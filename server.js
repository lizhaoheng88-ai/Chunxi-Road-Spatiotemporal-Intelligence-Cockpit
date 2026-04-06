const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const DASHBOARD_PATH = path.join(DATA_DIR, "dashboard-data.json");
const KNOWLEDGE_PATH = path.join(DATA_DIR, "knowledge-base.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 20);
const rateBuckets = new Map();

const SYSTEM_PROMPT = [
  "You are the Chunxi Road project copilot.",
  "Answer only from the supplied dashboard context and retrieved evidence.",
  "Be concise, actionable, and specific about time, space, and stakeholder impact.",
  "If the question asks for recommendations, tailor them to residents, businesses, communities, or planners when relevant.",
  "If the evidence is weak or incomplete, say so clearly instead of inventing facts.",
].join(" ");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function cleanupRateBuckets(now = Date.now()) {
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}

function isRateLimited(req) {
  const now = Date.now();
  cleanupRateBuckets(now);

  const clientIp = getClientIp(req);
  const bucket = rateBuckets.get(clientIp);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  rateBuckets.set(clientIp, bucket);
  return bucket.count > RATE_LIMIT_MAX_REQUESTS;
}

function getProviderConfigs() {
  return {
    local: {
      id: "local",
      label: "Grounded local mode",
      model: "grounded-local",
      available: true,
      type: "local",
      hint: "Always available. Answers come from the prepared Chunxi Road evidence bundle.",
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      available: Boolean(process.env.OPENAI_API_KEY),
      type: "compatible-chat",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      hint: process.env.OPENAI_API_KEY
        ? "Configured through OPENAI_API_KEY."
        : "Set OPENAI_API_KEY to enable hosted OpenAI chat.",
    },
    qwen: {
      id: "qwen",
      label: "Qwen",
      model: process.env.QWEN_MODEL || "qwen-plus",
      available: Boolean(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY),
      type: "compatible-chat",
      apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY,
      baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      hint: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY
        ? "Configured through QWEN_API_KEY or DASHSCOPE_API_KEY."
        : "Set QWEN_API_KEY or DASHSCOPE_API_KEY to enable Qwen.",
    },
    doubao: {
      id: "doubao",
      label: "Doubao",
      model: process.env.DOUBAO_MODEL || "doubao-seed-1-6-250615",
      available: Boolean(process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY),
      type: "compatible-chat",
      apiKey: process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY,
      baseUrl: process.env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
      hint: process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY
        ? "Configured through DOUBAO_API_KEY or ARK_API_KEY."
        : "Set DOUBAO_API_KEY or ARK_API_KEY to enable Doubao.",
    },
  };
}

function listProviders() {
  return Object.values(getProviderConfigs()).map((provider) => ({
    id: provider.id,
    label: provider.label,
    model: provider.model,
    available: provider.available,
    hint: provider.hint,
  }));
}

function getDefaultProviderId() {
  const configs = getProviderConfigs();
  const priority = ["openai", "qwen", "doubao", "local"];
  return priority.find((id) => configs[id] && configs[id].available) || "local";
}

function getDashboardPayload() {
  const dashboard = readJson(DASHBOARD_PATH);
  const providerId = getDefaultProviderId();
  const provider = getProviderConfigs()[providerId];
  dashboard.chatProvider = provider.label;
  dashboard.chatModel = provider.model;
  dashboard.chatProviders = listProviders();
  dashboard.defaultChatProvider = providerId;
  dashboard.publicUrlHint = HOST === "0.0.0.0" ? "Deployment-ready" : `Bound to ${HOST}`;
  return dashboard;
}

function getKnowledgeBase() {
  const knowledge = readJson(KNOWLEDGE_PATH);
  return knowledge.map((entry) => ({
    ...entry,
    _search: [
      entry.title || "",
      entry.content || "",
      ...(entry.tags || []),
      ...(entry.recommendations || []),
      ...(entry.sources || []),
    ]
      .join(" ")
      .toLowerCase(),
  }));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": MIME_TYPES[".json"],
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function safePath(urlPath) {
  const normalized = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(PUBLIC_DIR, normalized);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

function serveStatic(req, res, pathname) {
  const target = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = safePath(target);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  let actualPath = filePath;
  if (fs.existsSync(actualPath) && fs.statSync(actualPath).isDirectory()) {
    actualPath = path.join(actualPath, "index.html");
  }

  if (!fs.existsSync(actualPath)) {
    sendText(res, 404, "Not Found");
    return;
  }

  const ext = path.extname(actualPath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mimeType });
  fs.createReadStream(actualPath).pipe(res);
}

function tokenize(question) {
  const lower = (question || "").toLowerCase();
  const latin = lower.match(/[a-z0-9_]+/g) || [];
  const han = lower.match(/[\p{Script=Han}]{1,}/gu) || [];
  return [...new Set([...latin.filter((item) => item.length > 1), ...han])];
}

function scoreDocument(question, doc) {
  const query = (question || "").toLowerCase().trim();
  if (!query) {
    return 0;
  }

  let score = 0;
  const search = doc._search;
  for (const tag of doc.tags || []) {
    const lowered = String(tag).toLowerCase();
    if (query.includes(lowered) || lowered.includes(query)) {
      score += 6;
    }
  }

  for (const token of tokenize(query)) {
    if (search.includes(token)) {
      score += token.length > 3 ? 4 : 2;
    }
  }

  if ((doc.title || "").toLowerCase().includes(query)) {
    score += 8;
  }

  return score;
}

function retrieveDocs(question, limit = 4) {
  const knowledge = getKnowledgeBase();
  return knowledge
    .map((doc) => ({ ...doc, _score: scoreDocument(question, doc) }))
    .filter((doc) => doc._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function formatSources(docs) {
  const seen = new Set();
  const items = [];
  for (const doc of docs) {
    for (const source of doc.sources || []) {
      if (!seen.has(source)) {
        seen.add(source);
        items.push(source);
      }
    }
  }
  return items;
}

function buildLocalAnswer(question, docs, dashboard) {
  if (!docs.length) {
    return {
      mode: "Grounded local mode",
      answer: [
        "I could not find a strong match for that question in the prepared dashboard evidence.",
        "Try asking about hourly activity peaks, fused dual-camera heatmaps, OD corridors, pedestrian activity, or planning recommendations for Chunxi Road.",
      ].join("\n\n"),
      sources: [],
    };
  }

  const keyLines = docs.map((doc) => `- ${doc.content}`).join("\n");
  const recommendationLines = docs
    .flatMap((doc) => doc.recommendations || [])
    .slice(0, 4)
    .map((item) => `- ${item}`)
    .join("\n");

  const answer = [
    `Here is a data-grounded answer for \"${question}\":`,
    keyLines,
    recommendationLines
      ? `Recommended actions\n${recommendationLines}`
      : `Relevant next step\n- Use the dashboard's signal, fused video, and road-context layers together to validate this pattern.`,
    `Context window\n- Dashboard generated ${dashboard.generatedAt}`,
  ].join("\n\n");

  return {
    mode: "Grounded local mode",
    answer,
    sources: formatSources(docs),
  };
}

function extractCompatibleText(payload) {
  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") {
    return choice.trim();
  }
  if (Array.isArray(choice)) {
    return choice
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

async function callCompatibleChat(provider, question, docs, messages) {
  const userPayload = {
    question,
    retrieved_evidence: docs.map((doc) => ({
      title: doc.title,
      content: doc.content,
      recommendations: doc.recommendations || [],
      sources: doc.sources || [],
    })),
    recent_messages: messages.slice(-6),
  };

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(userPayload, null, 2) },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${provider.label} request failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return {
    mode: provider.label,
    answer: extractCompatibleText(payload),
    sources: formatSources(docs),
  };
}

function resolveProvider(requestedId) {
  const providers = getProviderConfigs();
  const chosen = providers[requestedId] || providers[getDefaultProviderId()];
  return chosen;
}

async function handleChat(req, res) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk.toString("utf8");
    if (raw.length > 1_000_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    try {
      const payload = raw ? JSON.parse(raw) : {};
      const question = String(payload.question || "").trim();
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const requestedProvider = String(payload.provider || getDefaultProviderId()).trim().toLowerCase();

      if (!question) {
        sendJson(res, 400, { error: "Question is required." });
        return;
      }

      if (isRateLimited(req)) {
        sendJson(res, 429, { error: "Too many chat requests. Please try again in a few minutes." });
        return;
      }

      const docs = retrieveDocs(question);
      const dashboard = getDashboardPayload();
      const provider = resolveProvider(requestedProvider);

      if (!provider || provider.type === "local") {
        sendJson(res, 200, buildLocalAnswer(question, docs, dashboard));
        return;
      }

      if (!provider.available) {
        const fallback = buildLocalAnswer(question, docs, dashboard);
        fallback.notice = `${provider.label} is not configured on this server, so the site returned a grounded local answer instead.`;
        sendJson(res, 200, fallback);
        return;
      }

      try {
        const result = await callCompatibleChat(provider, question, docs, messages);
        sendJson(res, 200, result);
      } catch (error) {
        const fallback = buildLocalAnswer(question, docs, dashboard);
        fallback.notice = `${provider.label} was unavailable, so the server returned a grounded local answer instead. ${error.message}`;
        sendJson(res, 200, fallback);
      }
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/dashboard") {
    sendJson(res, 200, getDashboardPayload());
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, pathname);
    return;
  }

  sendText(res, 405, "Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`Chunxi dashboard running at http://${HOST}:${PORT}`);
});

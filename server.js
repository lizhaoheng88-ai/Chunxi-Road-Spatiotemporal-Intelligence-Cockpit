const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  callCompatibleChat,
  getDefaultProviderId,
  getProviderConfigs,
  listProviders,
  resolveProvider,
} = require("./lib/provider-client");
const { answerPlanningQuestion } = require("./lib/chat-assistant");
const { isWebSearchAvailable } = require("./lib/web-search");
const {
  buildDeterministicRecommendation,
  entityCacheKey,
  generateRecommendation,
  getDecisionCard,
} = require("./lib/recommendation-engine");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const DASHBOARD_PATH = path.join(DATA_DIR, "dashboard-data.json");
const KNOWLEDGE_PATH = path.join(DATA_DIR, "knowledge-base.json");
const DECISION_SUPPORT_PATH = path.join(DATA_DIR, "decision-support.json");
const DECISION_GRAPH_PATH = path.join(DATA_DIR, "decision-graph.json");
const RECOMMENDATION_CACHE_PATH = path.join(DATA_DIR, "recommendation-cache.json");

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

const AREA_LABELS = {
  chunxi_core: "春熙路步行街核心",
  ifs_core: "IFS 国际金融中心",
  zongfu_road: "总府路沿线",
  taikoo_daci_merged: "太古里-大慈寺商圈",
};

const FEATURE_LABELS = {
  road_length_m: "道路长度",
  pedestrian_way_length_m: "步行道长度",
  sidewalk_length_m: "人行道长度",
  crossing_count: "过街设施数量",
  intersection_density_per_sqkm: "路网交叉密度",
  distance_to_subway_entrance_m: "距地铁口距离",
  poi_count: "POI 总量",
  poi_diversity: "POI 多样性",
  poi_shopping_count: "购物 POI 数量",
  poi_food_count: "餐饮 POI 数量",
  poi_entertainment_count: "娱乐 POI 数量",
  poi_transit_count: "交通服务 POI 数量",
};

const SCENARIO_LABELS = {
  A_subway_zero: "新增 / 贴近地铁口可达性",
  B_pedestrian_way_plus50: "步行道长度提升 50%",
  C_food_to_q75: "餐饮业态补足到 75 分位",
  D_intersection_to_q80: "路网交叉密度提升到 80 分位",
};

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 20);
const rateBuckets = new Map();

const SYSTEM_PROMPT = [
  "你是春熙路规划助手，一个在成都春熙路商圈生活了十年的城市规划顾问。",
  "你说话亲切、专业但不学术，像一个懂行的本地朋友在聊天。",
  "",
  "根据问题类型自动调整回答方式：",
  "- 打招呼/闲聊 → 简短回应，自我介绍，引导用户提具体问题，两三句话就够",
  "- 问某个地点情况 → 用生活化语言描述，不超过3段，不要列编号清单",
  "- 问政策/新闻 → 有证据就说，没有就坦白说不确定，不要编造政策细节",
  "- 问规划建议 → 给具体的、能落地的建议，说清在哪个路口做什么",
  "- 问数据对比 → 用人话翻译数字，比如'人流大概是隔壁的两倍'",
  "",
  "绝对禁止：",
  "- 文件名、JSON字段名、仓库路径",
  "- SHAP、ALE、residual、zscore、percentile、feature importance 等技术术语",
  "- 网格编号（如6_9、7_2），除非用户主动问",
  "- 每次都用相同的固定模板回答（不要总是'现状一句话→三个问题→三条建议'）",
  "- 在回答末尾列证据来源、数据覆盖范围等免责声明",
  "",
  "翻译规则：",
  "- '步行道长度226米' → '步行道偏短，走不了几步就到头了'",
  "- '距地铁口585米' → '离最近的地铁口将近600米，走路要七八分钟'",
  "- '正向率48.2%' → '网上评价还不错，差不多一半的帖子是正面的'",
  "",
  "你会收到 retrieved_evidence（结构化数据），读懂后用自己的话转述。",
  "如果证据不够，简短说一句就行，不要长篇分析为什么不够。",
].join("\n");

const REWRITE_PROMPT = [
  "请把下面这段回答改写成普通人能直接看懂的简洁中文。",
  "保留原来的判断和建议，但绝对不要出现文件名、字段名、路径、模型名，",
  "也不要出现 SHAP、ALE、residual、zscore、percentile、feature importance 等术语。",
  "输出纯文本，不要加标题，不要解释你做了什么。",
].join("");

const FORBIDDEN_OUTPUT_PATTERNS = [
  /shap/i,
  /ale/i,
  /residual/i,
  /zscore/i,
  /percentile/i,
  /feature[_ ]importance/i,
  /\.json\b/i,
  /\.csv\b/i,
  /[A-Za-z]:\\\\/i,
  /analysis_outputs/i,
  /decision-support/i,
  /knowledge-base/i,
  /\b[a-z_]+_(mean|count|rate|direction|value|summary)\b/i,
];

const POLICY_PRIORITY_DOMAINS = [
  "chengdu.gov.cn",
  "cd.gov.cn",
  "sc.gov.cn",
  "gov.cn",
  "people.com.cn",
  "xinhuanet.com",
];

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    if (fallback !== null) {
      return fallback;
    }
    throw new Error(`Missing JSON file at ${filePath}`);
  }
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

function formatFixed(value, digits = 1) {
  return Number(value || 0).toFixed(digits);
}

function formatPercent(value, digits = 1) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}

function getDashboardPayload() {
  const dashboard = readJson(DASHBOARD_PATH);
  const providerId = getDefaultProviderId();
  const provider = getProviderConfigs()[providerId];
  dashboard.chatProvider = provider.label;
  dashboard.chatModel = provider.model;
  dashboard.chatProviders = listProviders();
  dashboard.defaultChatProvider = providerId;
  dashboard.webSearchConfigured = isWebSearchAvailable();
  dashboard.publicUrlHint = HOST === "0.0.0.0" ? "可本地打开，也可部署到外网访问" : `当前绑定地址：${HOST}`;
  return dashboard;
}

function buildSearchIndex(entry) {
  return [
    entry.title || "",
    entry.content || "",
    ...(entry.tags || []),
    ...(entry.recommendations || []),
    ...(entry.sources || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getDecisionBundle() {
  const support = readJson(DECISION_SUPPORT_PATH, { meta: {}, grid_cards: {}, area_cards: {}, cached_recommendations: {} });
  const graph = readJson(DECISION_GRAPH_PATH, { meta: {}, nodes: [], edges: [] });
  const cache = readJson(RECOMMENDATION_CACHE_PATH, { meta: {}, recommendations: {} });
  return {
    support,
    graph,
    cache,
    providers: listProviders(),
    defaultProvider: getDefaultProviderId(),
  };
}

function getKnowledgeBase() {
  const knowledge = readJson(KNOWLEDGE_PATH, []);
  const decisionKnowledge = buildDecisionKnowledgeBase(getDecisionBundle());
  return [...knowledge, ...decisionKnowledge].map((entry) => ({
    ...entry,
    _search: buildSearchIndex(entry),
  }));
}

function getFeatureLabel(meta, feature, label) {
  return label || meta?.feature_labels?.[feature] || FEATURE_LABELS[feature] || feature;
}

function getAreaLabel(cardOrArea) {
  if (!cardOrArea) return "研究区";
  if (typeof cardOrArea === "string") {
    return AREA_LABELS[cardOrArea] || cardOrArea;
  }
  if (cardOrArea.label) return cardOrArea.label;
  if (cardOrArea.area_id) return AREA_LABELS[cardOrArea.area_id] || cardOrArea.area_id;
  if (Array.isArray(cardOrArea.area_candidates) && cardOrArea.area_candidates.length) {
    return cardOrArea.area_candidates.join("、");
  }
  return cardOrArea.zone || "研究区";
}

function getClusterLabel(label) {
  return label || "未标注画像";
}

function interpretResidualDirection(value) {
  const numeric = Number(value || 0);
  if (numeric > 0) return "说明实际需求高于模型预期，属于需求溢出或承接不足。";
  if (numeric < 0) return "说明现有供给没有被充分转化为实际活力，更像利用不足或空间品质拖累。";
  return "说明供给与需求总体匹配。";
}

function recommendationForEntity(cache, entityType, entityId) {
  const localKey = entityCacheKey(entityType, entityId, "local");
  if (cache?.recommendations?.[localKey]) {
    return cache.recommendations[localKey];
  }
  const prefix = `${entityType}:${entityId}:`;
  const match = Object.entries(cache?.recommendations || {}).find(([key]) => key.startsWith(prefix));
  return match ? match[1] : null;
}

function summarizeRecommendation(recommendation) {
  if (!recommendation) return [];
  return (recommendation.priority_actions || [])
    .slice(0, 3)
    .map((action, index) => {
      const firstMeasure = Array.isArray(action.measures) && action.measures.length ? action.measures[0] : action.why;
      return `${index + 1}. ${action.theme}：${firstMeasure}`;
    });
}

function getActionableFeatures(card, meta) {
  const shapOrder = new Map((card?.shap_top3 || []).map((item, index) => [item.feature, index]));
  const inlineItems = Object.entries(card?.ale_actionable_features || {}).map(([feature, item]) => ({
    ...item,
    feature,
    label: getFeatureLabel(meta, feature, item.label),
  }));
  const areaItems = Array.isArray(card?.top_actionable_features)
    ? card.top_actionable_features.map((item) => ({
        ...item,
        current_percentile: item.mean_percentile,
        current_value: item.mean_value,
        label: getFeatureLabel(meta, item.feature, item.label),
      }))
    : [];

  const seen = new Set();
  return [...inlineItems, ...areaItems]
    .filter((item) => {
      if (!item.feature || seen.has(item.feature)) return false;
      seen.add(item.feature);
      return true;
    })
    .sort((a, b) => {
      const aRank = shapOrder.has(a.feature) ? shapOrder.get(a.feature) : 99;
      const bRank = shapOrder.has(b.feature) ? shapOrder.get(b.feature) : 99;
      if (aRank !== bRank) return aRank - bRank;
      return Number(b.current_percentile || 0) - Number(a.current_percentile || 0);
    });
}

function topActionableFeatureTexts(card, meta) {
  return getActionableFeatures(card, meta)
    .slice(0, 3)
    .map((item) => {
      const percentile = Number(item.current_percentile || 0) * 100;
      const directionLabel = item.direction === "positive"
        ? "仍有提升空间"
        : item.direction === "negative"
          ? "边际收益趋弱"
          : "待进一步判断";
      return `${item.label}（${directionLabel}，当前分位 ${percentile.toFixed(0)}%）`;
    });
}

function socialCueText(card) {
  const social = card?.social_perception || card?.social_summary;
  if (!social) return "当前没有可直接引用的社会感知佐证。";
  const parts = [];
  if (social.label) parts.push(`社会感知锚定片区：${social.label}`);
  if (Number(social.post_count || 0) > 0) {
    parts.push(`帖子 ${social.post_count} 条，正向率 ${formatPercent(social.positive_rate || 0)}`);
  }
  if (social.top_signal) parts.push(`高频正向语义为“${social.top_signal}”`);
  if (social.top_complaint) parts.push(`主要抱怨为“${social.top_complaint}”`);
  return `${parts.join("，")}。`;
}

function counterfactualText(card, meta) {
  const scenario = card?.counterfactual_best_scenario;
  if (!scenario?.available) return "";
  const featureLabel = getFeatureLabel(meta, scenario.feature);
  const scenarioLabel = SCENARIO_LABELS[scenario.scenario] || scenario.scenario;
  return `反事实模拟显示，${scenarioLabel} 是当前最优情景，对应特征为 ${featureLabel}；平均日总量增量 ${formatFixed(scenario.mean_daily_total_delta, 1)}，峰时增量 ${formatFixed(scenario.mean_peak_hour_delta, 1)}。`;
}

function buildPrioritySummaryDoc(gridCards) {
  const negativePriority = [...gridCards]
    .sort((a, b) => Number(a.residual_mean || 0) - Number(b.residual_mean || 0))
    .slice(0, 6)
    .map((card) => `${card.grid_id}（${formatFixed(card.residual_mean, 0)}）`);
  const positivePriority = [...gridCards]
    .sort((a, b) => Number(b.residual_mean || 0) - Number(a.residual_mean || 0))
    .slice(0, 6)
    .map((card) => `${card.grid_id}（${formatFixed(card.residual_mean, 0)}）`);

  return {
    title: "网格优先级总览",
    tags: [
      "priority grids",
      "which grid",
      "planning priority",
      "decision support",
      "高优先级网格",
      "正残差",
      "负残差",
      "先改哪里",
      "哪个网格",
    ],
    content: `当前最需要优先做“存量优化 / 提升利用效率”的负残差网格包括：${negativePriority.join("，")}。最需要优先做“补足承接能力 / 承接溢出需求”的正残差网格包括：${positivePriority.join("，")}。`,
    recommendations: [
      "先用残差方向确定治理类型：负残差先做利用效率与空间品质修复，正残差先做承接能力补足。",
      "如果两个网格精度接近，优先看 SHAP / ALE / 反事实是否同时支持同一类动作。",
      "正式汇报时，可把首页 AI 问答作为入口，再回到决策证据工作台追溯网格证据。",
    ],
    sources: ["decision-support.json", "recommendation-cache.json"],
  };
}

function buildScenarioSummaryDocs(gridCards, meta) {
  const scenarioGroups = new Map();
  for (const card of gridCards) {
    const scenario = card?.counterfactual_best_scenario;
    if (!scenario?.available || !scenario.scenario) continue;
    if (!scenarioGroups.has(scenario.scenario)) {
      scenarioGroups.set(scenario.scenario, []);
    }
    scenarioGroups.get(scenario.scenario).push(card);
  }

  const docs = [];
  for (const [scenarioId, cards] of scenarioGroups.entries()) {
    const sortedCards = [...cards].sort((a, b) => {
      const aDelta = Number(a.counterfactual_best_scenario?.mean_daily_total_delta || 0);
      const bDelta = Number(b.counterfactual_best_scenario?.mean_daily_total_delta || 0);
      return bDelta - aDelta;
    });
    const sample = sortedCards[0]?.counterfactual_best_scenario || {};
    const featureLabel = getFeatureLabel(meta, sample.feature);
    const scenarioLabel = SCENARIO_LABELS[scenarioId] || scenarioId;
    const topTargets = sortedCards
      .slice(0, 5)
      .map((card) => `${card.grid_id}（日总量增量 ${formatFixed(card.counterfactual_best_scenario?.mean_daily_total_delta, 1)}）`)
      .join("，");

    const extraTags = sample.feature === "distance_to_subway_entrance_m"
      ? ["地铁", "可达性", "subway", "交通"]
      : sample.feature === "poi_food_count"
        ? ["餐饮", "业态", "food", "poi"]
        : [sample.feature || "counterfactual"];

    docs.push({
      title: `反事实情景：${scenarioLabel}`,
      tags: [
        "反事实",
        "what-if",
        "规划模拟",
        scenarioId,
        featureLabel,
        ...extraTags,
      ],
      content: `在当前正式解释结果中，${scenarioLabel} 是 ${cards.length} 个网格的最优改善情景，重点对应特征为 ${featureLabel}。优先收益更高的网格包括：${topTargets}。`,
      recommendations: [
        `如果你优先做 ${scenarioLabel}，建议先从 ${sortedCards.slice(0, 3).map((card) => card.grid_id).join("、")} 这类网格做小范围试点。`,
        "不要只看单个特征的理论方向，还要结合残差方向判断是补承接能力还是做存量优化。",
      ],
      sources: ["decision-support.json"],
    });
  }

  return docs;
}

function buildAreaDoc(card, meta, cache) {
  const recommendation = recommendationForEntity(cache, "area", card.area_id);
  const dominantClusters = (card.dominant_clusters || [])
    .map((item) => `${getClusterLabel(item.cluster_label)}（${item.grid_count} 个）`)
    .join("，");
  const topFeatures = topActionableFeatureTexts(card, meta).join("；");
  const residualValue = Number(card.residual_summary?.residual_mean || 0);
  return {
    title: `片区诊断卡：${getAreaLabel(card)}`,
    tags: [
      card.area_id,
      getAreaLabel(card),
      "area",
      "片区",
      "规划建议",
      ...(card.grid_ids || []),
      ...(card.top_actionable_features || []).map((item) => item.feature),
      ...(card.top_actionable_features || []).map((item) => getFeatureLabel(meta, item.feature, item.label)),
    ].filter(Boolean),
    content: `${getAreaLabel(card)}共覆盖 ${(card.grid_ids || []).length} 个网格，平均残差 ${formatFixed(residualValue)}，${interpretResidualDirection(residualValue)} 主导需求画像为 ${dominantClusters || "未标注"}。当前最值得关注的供给要素是：${topFeatures || "暂无"} ${socialCueText(card)}`,
    recommendations: summarizeRecommendation(recommendation),
    sources: ["decision-support.json", "recommendation-cache.json"],
    entity_type: "area",
    entity_id: card.area_id,
  };
}

function buildGridDoc(card, meta, cache) {
  const recommendation = recommendationForEntity(cache, "grid", card.grid_id);
  const shapFeatures = (card.shap_top3 || [])
    .map((item) => `${getFeatureLabel(meta, item.feature, item.label)}（SHAP ${Number(item.shap_value || 0).toFixed(4)}，${item.direction || "neutral"}）`)
    .join("；");
  const actionable = topActionableFeatureTexts(card, meta).join("；");
  const areaLabel = Array.isArray(card.area_candidates) && card.area_candidates.length
    ? card.area_candidates.join("、")
    : getAreaLabel(card);
  return {
    title: `网格诊断卡：${card.grid_id}`,
    tags: [
      card.grid_id,
      `grid ${card.grid_id}`,
      "grid",
      "网格",
      "决策诊断",
      areaLabel,
      getClusterLabel(card.cluster_label),
      card.residual_direction,
      ...(card.shap_top3 || []).map((item) => item.feature),
      ...(card.shap_top3 || []).map((item) => getFeatureLabel(meta, item.feature, item.label)),
      card.counterfactual_best_scenario?.scenario || "",
      card.counterfactual_best_scenario?.feature || "",
    ].filter(Boolean),
    content: `网格 ${card.grid_id} 位于 ${areaLabel}，需求画像为 ${getClusterLabel(card.cluster_label)}，平均残差 ${formatFixed(card.residual_mean)}，${interpretResidualDirection(card.residual_mean)} SHAP 关注度最高的供给因子为：${shapFeatures || "暂无"}。ALE 指向当前更可行动的方向为：${actionable || "暂无"}。 ${counterfactualText(card, meta)} ${socialCueText(card)}`,
    recommendations: summarizeRecommendation(recommendation),
    sources: ["decision-support.json", "recommendation-cache.json"],
    entity_type: "grid",
    entity_id: card.grid_id,
  };
}

function buildDecisionKnowledgeBase(decisionBundle) {
  const support = decisionBundle.support || {};
  const cache = decisionBundle.cache || { recommendations: {} };
  const meta = support.meta || {};
  const gridCards = Object.values(support.grid_cards || {});
  const areaCards = Object.values(support.area_cards || {});

  return [
    buildPrioritySummaryDoc(gridCards),
    ...buildScenarioSummaryDocs(gridCards, meta),
    ...areaCards.map((card) => buildAreaDoc(card, meta, cache)),
    ...gridCards.map((card) => buildGridDoc(card, meta, cache)),
  ];
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
  if (!query) return 0;

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

function isGreeting(question) {
  const greetings = ["你好", "您好", "hi", "hello", "嗨", "hey", "在吗", "在不在", "哈喽"];
  const lower = question.toLowerCase().trim().replace(/[!！?？。.~～]+$/, "");
  return greetings.some((g) => lower === g || lower === g + "啊" || lower === g + "呀");
}

function buildLocalAnswer(question, docs, dashboard) {
  if (isGreeting(question)) {
    return {
      mode: "本地证据模式",
      answer: "你好！我是春熙路规划助手，对春熙路、太古里、IFS、总府路这一带比较熟悉。你可以问我某个地方的人流情况、步行体验、或者规划改善建议。想了解哪里？",
      sources: [],
    };
  }

  if (!docs.length) {
    return {
      mode: "本地证据模式",
      answer: `关于"${question}"，我现有的资料暂时覆盖不到。你可以试试问我具体片区的情况，比如"总府路那边走路方便吗"或者"太古里附近哪里人最多"。`,
      sources: [],
    };
  }

  const parts = [];
  for (const doc of docs.slice(0, 3)) {
    if (doc.content) parts.push(doc.content);
  }
  const recommendations = docs
    .flatMap((doc) => doc.recommendations || [])
    .slice(0, 3);
  if (recommendations.length) {
    parts.push("可以考虑的方向：\n" + recommendations.map((r) => `- ${r}`).join("\n"));
  }

  return {
    mode: "本地证据模式",
    answer: parts.join("\n\n"),
    sources: formatSources(docs),
  };
}

async function callHostedChat(provider, question, docs, messages) {
  const userPayload = {
    question,
    retrieved_evidence: docs.map((doc) => ({
      title: doc.title,
      content: doc.content,
      recommendations: doc.recommendations || [],
      sources: doc.sources || [],
      entity_type: doc.entity_type || null,
      entity_id: doc.entity_id || null,
    })),
    recent_messages: messages.slice(-6),
  };

  const result = await callCompatibleChat(provider, {
    temperature: 0.3,
    maxTokens: 1200,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload, null, 2) },
    ],
  });

  return {
    mode: provider.label,
    answer: result.text,
    sources: formatSources(docs),
  };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function handleChat(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const question = String(payload.question || "").trim();
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const requestedProvider = String(payload.provider || getDefaultProviderId()).trim().toLowerCase();
    const role = String(payload.role || "planner").trim().toLowerCase();

    if (!question) {
      sendJson(res, 400, { error: "question ?????" });
      return;
    }

    if (isRateLimited(req)) {
      sendJson(res, 429, { error: "???????????????" });
      return;
    }

    const dashboard = getDashboardPayload();
    const decisionBundle = getDecisionBundle();
    const knowledge = getKnowledgeBase();
    const provider = resolveProvider(requestedProvider);
    const result = await answerPlanningQuestion({
      question,
      messages,
      provider,
      role,
      dashboard,
      knowledge,
      decisionBundle,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function findCachedRecommendation(cache, entityType, entityId, provider) {
  const exactKey = entityCacheKey(entityType, entityId, provider);
  if (cache.recommendations?.[exactKey]) {
    return { provider, recommendation: cache.recommendations[exactKey], fromCache: true, notice: null };
  }
  const localKey = entityCacheKey(entityType, entityId, "local");
  if (cache.recommendations?.[localKey]) {
    return {
      provider: "local",
      recommendation: cache.recommendations[localKey],
      fromCache: true,
      notice: provider === "local" ? null : `${provider} 暂无缓存结果，已回退到 local 结构化建议。`,
    };
  }
  return null;
}

async function handleDecisionRecommend(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const entityType = String(payload.entityType || "grid").trim();
    const entityId = String(payload.entityId || "").trim();
    const requestedProvider = String(payload.provider || "local").trim().toLowerCase();
    const mode = String(payload.mode || "cached").trim().toLowerCase();

    if (!entityId) {
      sendJson(res, 400, { error: "entityId 不能为空。" });
      return;
    }

    const decisionBundle = getDecisionBundle();
    const card = getDecisionCard(decisionBundle.support, entityType, entityId);
    if (!card) {
      sendJson(res, 404, { error: `未知实体 ${entityType}:${entityId}` });
      return;
    }

    if (mode === "cached") {
      const cached = findCachedRecommendation(decisionBundle.cache, entityType, entityId, requestedProvider);
      if (cached) {
        sendJson(res, 200, {
          entityType,
          entityId,
          provider: cached.provider,
          fromCache: true,
          card,
          recommendation: cached.recommendation,
          notice: cached.notice,
        });
        return;
      }

      const recommendation = buildDeterministicRecommendation(decisionBundle.support, entityType, entityId);
      sendJson(res, 200, {
        entityType,
        entityId,
        provider: "local",
        fromCache: false,
        card,
        recommendation,
        notice: "当前没有命中缓存，已即时生成一份本地结构化建议。",
      });
      return;
    }

    if (mode === "refresh" && isRateLimited(req)) {
      sendJson(res, 429, { error: "当前实时重生成请求过多，请稍后再试。" });
      return;
    }

    const result = await generateRecommendation(decisionBundle.support, entityType, entityId, requestedProvider);
    sendJson(res, 200, {
      entityType,
      entityId,
      provider: result.provider,
      fromCache: false,
      card,
      recommendation: result.recommendation,
      notice: result.notice,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
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

  if (req.method === "GET" && pathname === "/api/decision-support") {
    sendJson(res, 200, getDecisionBundle());
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/decision/recommend") {
    handleDecisionRecommend(req, res);
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

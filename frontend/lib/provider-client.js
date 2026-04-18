const DEFAULT_PRIORITY = ["openai", "qwen", "doubao", "local"];

function getProviderConfigs() {
  return {
    local: {
      id: "local",
      label: "本地证据模式",
      model: "grounded-local",
      available: true,
      type: "local",
      hint: "始终可用，回答来自已构建好的春熙路结构化证据库。",
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
        ? "已通过 OPENAI_API_KEY 配置。"
        : "设置 OPENAI_API_KEY 后可启用 OpenAI 在线问答。",
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
        ? "已通过 QWEN_API_KEY / DASHSCOPE_API_KEY 配置。"
        : "设置 QWEN_API_KEY 或 DASHSCOPE_API_KEY 后可启用通义千问。",
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
        ? "已通过 DOUBAO_API_KEY / ARK_API_KEY 配置。"
        : "设置 DOUBAO_API_KEY 或 ARK_API_KEY 后可启用豆包。",
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

function getDefaultProviderId(priority = DEFAULT_PRIORITY) {
  const configs = getProviderConfigs();
  return priority.find((id) => configs[id] && configs[id].available) || "local";
}

function resolveProvider(requestedId) {
  const providers = getProviderConfigs();
  return providers[requestedId] || providers[getDefaultProviderId()];
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

async function callCompatibleChat(provider, options = {}) {
  if (!provider || provider.type === "local") {
    throw new Error("Local provider does not support hosted chat calls.");
  }
  const body = {
    model: options.model || provider.model,
    temperature: options.temperature ?? 0.3,
    messages: Array.isArray(options.messages) ? options.messages : [],
  };
  if (options.responseFormat) {
    body.response_format = options.responseFormat;
  }
  if (options.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${provider.label} request failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return {
    raw: payload,
    text: extractCompatibleText(payload),
  };
}

module.exports = {
  callCompatibleChat,
  extractCompatibleText,
  getDefaultProviderId,
  getProviderConfigs,
  listProviders,
  resolveProvider,
};

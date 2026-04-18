const { callCompatibleChat } = require("./provider-client");
const { buildPlaceRegistry, normalizePlaceText, resolveLocalPlace } = require("./place-registry");
const { isWebSearchAvailable, searchWeb } = require("./web-search");

const SYSTEM_PROMPT = [
  "你是春熙路规划助手，一个在成都春熙路商圈生活了十年的城市规划顾问。",
  "你说话亲切、专业但不学术，像一个懂行的本地朋友在聊天。",
  "",
  "根据问题类型自动调整回答方式（这是最重要的规则）：",
  "- 打招呼/闲聊 → 一两句话回应+自我介绍，不要分析任何数据",
  "- 问某个地点情况 → 用生活化语言描述，像本地人聊天，不要列编号清单",
  "- 问政策/新闻 → 结合搜索到的资料回答，注明大致时间",
  "- 问规划建议 → 给具体可落地的建议，说清在哪个路口做什么",
  "- 问数据对比 → 用人话翻译，比如'人流大概是隔壁的两倍'",
  "",
  "关于地名的重要规则：",
  "- 永远不要说某个地方'不存在'或'没有这个地方'",
  "- 如果你不确定用户说的地方在哪，就根据搜索结果或常识判断它大概在哪个片区",
  "- 然后用那个片区的数据来回答，比如'银石广场在春熙路步行街这一带，这个区域...'",
  "- 如果实在定位不了，礼貌地请用户补充信息，但不要否认地名的存在",
  "",
  "绝对禁止：",
  "- 文件名、JSON字段名、仓库路径",
  "- SHAP、ALE、residual、zscore、percentile、feature importance 等技术术语",
  "- 网格编号（6_9、7_2等），除非用户主动问",
  "- 不要每次都用'现状→问题→建议'的固定三段式，根据问题灵活回答",
  "- 不要在末尾加免责声明、数据来源说明",
  "",
  "翻译规则（把数据变成人话）：",
  "- '步行道长度226米' → '步行道偏短'",
  "- '距地铁口585米' → '离地铁口走路要七八分钟，有点远'",
  "- '正向率48.2%' → '网上评价还不错'",
  "",
  "你会收到结构化数据，读懂后用自己的话转述。",
  "证据不够就简短说一句，不要长篇分析为什么不够。",
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

function tokenize(question) {
  const lower = String(question || "").toLowerCase();
  const latin = lower.match(/[a-z0-9_]+/g) || [];
  const han = lower.match(/[\p{Script=Han}]{1,}/gu) || [];
  return [...new Set([...latin.filter((item) => item.length > 1), ...han])];
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // fall through
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch (error) {
          return null;
        }
      }
    }
  }
  return null;
}

function classifyQuestion(question) {
  const text = String(question || "");
  const lower = text.toLowerCase().trim().replace(/[!！?？。.~～]+$/, "");
  const greetings = ["你好", "您好", "hi", "hello", "嗨", "hey", "在吗", "在不在", "哈喽", "你好啊", "你好呀"];
  const isGreeting = greetings.includes(lower) || /^(你好|您好|嗨|哈喽|hello|hi)[啊呀吗]?$/.test(lower);
  const asksPolicy = /(最近|最新|近期|政策|通知|办法|文件|规定|改造|规划|更新|方案)/.test(text);
  const asksRecommendation = /(怎么改|如何改|建议|怎么做|如何优化|改善|提升|改造|怎么规划)/.test(text);
  const asksComparison = /(对比|相比|哪个更|差别|区别|相比之下)/.test(text);
  const asksSpecificLocation = /(哪里|哪儿|哪块|哪一块|哪边|附近|路口|哪条|哪段|哪个网格|更堵|容易堵|拥堵|瓶颈)/.test(text);
  const asksDiagnosis = /(问题|怎么回事|为什么|偏弱|不足|堵|拥堵|症结)/.test(text) || (!asksPolicy && !asksRecommendation && !asksComparison && !isGreeting);
  return {
    category: isGreeting ? "greeting" : asksPolicy ? "policy" : asksComparison ? "comparison" : asksRecommendation ? "recommendation" : "diagnosis",
    isGreeting,
    asksPolicy,
    asksRecommendation,
    asksComparison,
    asksSpecificLocation,
    asksDiagnosis,
    needsWebSearch: asksPolicy || /(最近|最新|近期|政策|通知|文件)/.test(text),
  };
}

function getFeatureLabel(decisionSupport, feature, fallback) {
  return fallback || decisionSupport?.meta?.feature_labels?.[feature] || feature;
}

function getAreaCard(decisionSupport, areaId) {
  return decisionSupport?.area_cards?.[areaId] || null;
}

function getGridCard(decisionSupport, gridId) {
  return decisionSupport?.grid_cards?.[gridId] || null;
}

function getAreaLabel(decisionSupport, areaId) {
  return getAreaCard(decisionSupport, areaId)?.label || areaId;
}

function inferAreaIdFromGrid(card, registry) {
  if (!card) return null;
  if (card.area_id) return card.area_id;
  if (Array.isArray(card.area_candidates) && card.area_candidates.length) return card.area_candidates[0];
  return registry.gridToArea.get(card.grid_id) || null;
}

function rankAreaGridIds(areaCard, decisionSupport, mode = "positive", limit = 3) {
  const cards = (areaCard?.grid_ids || [])
    .map((gridId) => getGridCard(decisionSupport, gridId))
    .filter(Boolean);
  const sorted = cards.sort((a, b) => {
    const aResidual = Number(a.residual_mean || 0);
    const bResidual = Number(b.residual_mean || 0);
    return mode === "negative" ? aResidual - bResidual : bResidual - aResidual;
  });
  return sorted.slice(0, limit).map((card) => card.grid_id);
}

function describeGridPosition(card, peerCards) {
  if (!card) return "";
  const cards = peerCards?.length ? peerCards : [card];
  const rows = cards.map((item) => Number(item.row));
  const cols = cards.map((item) => Number(item.col));
  const rowMid = (Math.min(...rows) + Math.max(...rows)) / 2;
  const colMid = (Math.min(...cols) + Math.max(...cols)) / 2;
  const vertical = Number(card.row) < rowMid - 0.5 ? "北侧" : Number(card.row) > rowMid + 0.5 ? "南侧" : "中部";
  const horizontal = Number(card.col) < colMid - 0.5 ? "西侧" : Number(card.col) > colMid + 0.5 ? "东侧" : "";
  return `${vertical}${horizontal}`;
}

function resolveMapFocus(decisionSupport, resolution) {
  if (resolution.gridIds?.length) {
    const firstCard = getGridCard(decisionSupport, resolution.gridIds[0]);
    const areaId = resolution.areaIds?.[0] || firstCard?.area_id || firstCard?.area_candidates?.[0] || null;
    return {
      areaId,
      gridIds: resolution.gridIds.slice(0, 3),
    };
  }
  if (resolution.areaIds?.length) {
    const areaCard = getAreaCard(decisionSupport, resolution.areaIds[0]);
    return {
      areaId: resolution.areaIds[0],
      gridIds: (areaCard?.grid_ids || []).slice(0, 12),
    };
  }
  return null;
}

function buildResolvedEntities(decisionSupport, resolution) {
  const entities = [];
  (resolution.areaIds || []).forEach((areaId, index) => {
    entities.push({
      entityType: "area",
      entityId: areaId,
      label: getAreaLabel(decisionSupport, areaId),
      confidence: index === 0 ? resolution.confidence : Math.max(0.4, resolution.confidence - 0.1),
    });
  });
  (resolution.gridIds || []).slice(0, 3).forEach((gridId) => {
    entities.push({
      entityType: "grid",
      entityId: gridId,
      label: `网格 ${gridId}`,
      confidence: Math.max(0.45, resolution.confidence - 0.06),
    });
  });
  return entities;
}

function containsForbiddenOutput(text) {
  return FORBIDDEN_OUTPUT_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

async function rewritePlainLanguageAnswer(provider, question, rawAnswer) {
  const result = await callCompatibleChat(provider, {
    temperature: 0.1,
    maxTokens: 800,
    messages: [
      { role: "system", content: REWRITE_PROMPT },
      { role: "user", content: `用户问题：${question}\n\n原回答：\n${rawAnswer}` },
    ],
  });
  return result.text;
}

async function resolveLocationWithHostedLLM(question, provider, registry) {
  if (!provider || provider.type === "local" || !provider.available) {
    return null;
  }

  const areaCatalog = registry.areas.map((item) => ({
    area_id: item.areaId,
    label: item.label,
    aliases: item.aliases.slice(0, 8),
  }));

  const result = await callCompatibleChat(provider, {
    temperature: 0,
    maxTokens: 500,
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你只负责做地点解析，不回答规划问题。",
          "请把用户提到的地点，映射到给定研究区的 4 个片区之一；如果明显不在研究区，就标记 outside_study_area=true。",
          "输出 JSON，字段固定为 normalized_place, area_candidates, outside_study_area, confidence, needs_web_search。",
          "area_candidates 是数组，元素字段为 area_id 和 confidence。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({ question, area_catalog: areaCatalog }, null, 2),
      },
    ],
  });

  const parsed = extractJsonObject(result.text);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const areaIds = Array.isArray(parsed.area_candidates)
    ? parsed.area_candidates
        .map((item) => item?.area_id)
        .filter((areaId) => registry.areas.some((entry) => entry.areaId === areaId))
    : [];

  return {
    method: "hosted_llm",
    normalizedPlace: String(parsed.normalized_place || ""),
    areaIds,
    gridIds: [],
    confidence: Number(parsed.confidence || (areaIds.length ? 0.72 : 0)),
    needsWebSearch: Boolean(parsed.needs_web_search),
    outsideStudyArea: Boolean(parsed.outside_study_area),
  };
}

function mapWebResultsToArea(webResults, registry) {
  const scores = new Map();
  webResults.forEach((result) => {
    const normalized = normalizePlaceText(`${result.title} ${result.snippet}`);
    registry.areas.forEach((area) => {
      area.normalizedAliases.forEach((alias) => {
        if (alias && normalized.includes(alias)) {
          scores.set(area.areaId, (scores.get(area.areaId) || 0) + alias.length + 3);
        }
      });
    });
  });

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 8) {
    return null;
  }

  return {
    areaId: ranked[0][0],
    confidence: Math.min(0.82, 0.5 + ranked[0][1] / 30),
  };
}

async function resolveQuestionContext(question, provider, decisionBundle, classification) {
  const decisionSupport = decisionBundle.support;
  const registry = buildPlaceRegistry(decisionSupport);
  const localResolution = resolveLocalPlace(question, registry, decisionSupport);
  let resolution = { ...localResolution, needsWebSearch: false };
  let webResults = [];

  if (resolution.confidence < 0.82 && provider && provider.type !== "local" && provider.available) {
    try {
      const hostedResolution = await resolveLocationWithHostedLLM(question, provider, registry);
      if (hostedResolution?.outsideStudyArea) {
        resolution = {
          method: hostedResolution.method,
          normalizedPlace: hostedResolution.normalizedPlace || question,
          areaIds: [],
          gridIds: [],
          confidence: Number(hostedResolution.confidence || 0.75),
          needsWebSearch: Boolean(hostedResolution.needsWebSearch),
          outsideStudyArea: true,
        };
      } else if ((hostedResolution?.confidence || 0) > resolution.confidence) {
        resolution = {
          ...hostedResolution,
          gridIds: hostedResolution.gridIds || [],
        };
      }
    } catch (error) {
      // fall back to local resolution
    }
  }

  const shouldSearch = provider && provider.type !== "local" && provider.available
    && isWebSearchAvailable()
    && (classification.needsWebSearch || resolution.confidence < 0.72 || resolution.needsWebSearch || resolution.outsideStudyArea);

  if (shouldSearch) {
    const domains = classification.asksPolicy ? POLICY_PRIORITY_DOMAINS : undefined;
    const searchQuery = resolution.outsideStudyArea
      ? `${question} 成都 春熙路`
      : question;
    try {
      webResults = await searchWeb(searchQuery, { limit: classification.asksPolicy ? 5 : 4, domains });
      if (resolution.confidence < 0.72 || resolution.outsideStudyArea) {
        const mapped = mapWebResultsToArea(webResults, registry);
        if (mapped) {
          const areaCard = getAreaCard(decisionSupport, mapped.areaId);
          resolution = {
            method: "web_search",
            normalizedPlace: areaCard?.label || mapped.areaId,
            areaIds: [mapped.areaId],
            gridIds: [],
            confidence: Number(mapped.confidence.toFixed(2)),
            outsideStudyArea: false,
          };
        }
      }
    } catch (error) {
      webResults = [];
    }
  }

  if (!resolution.outsideStudyArea && resolution.areaIds?.length && classification.asksSpecificLocation && !resolution.gridIds?.length) {
    const areaCard = getAreaCard(decisionSupport, resolution.areaIds[0]);
    resolution.gridIds = rankAreaGridIds(areaCard, decisionSupport, "positive", 3);
  }

  if (!resolution.outsideStudyArea && resolution.gridIds?.length && !resolution.areaIds?.length) {
    const firstCard = getGridCard(decisionSupport, resolution.gridIds[0]);
    const areaId = inferAreaIdFromGrid(firstCard, registry);
    if (areaId) {
      resolution.areaIds = [areaId];
    }
  }

  return {
    registry,
    resolution,
    webResults,
  };
}

function makeHumanReadableDoc(doc) {
  return {
    title: doc.title,
    content: doc.content,
    recommendations: doc.recommendations || [],
    entity_type: doc.entity_type || null,
    entity_id: doc.entity_id || null,
  };
}

function scoreDocument(question, doc, context = {}) {
  const query = String(question || "").toLowerCase().trim();
  if (!query) return 0;

  let score = 0;
  const search = doc._search || "";
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

  if (context.resolution?.areaIds?.length && doc.entity_type === "area" && context.resolution.areaIds.includes(doc.entity_id)) {
    score += 42;
  }
  if (context.resolution?.gridIds?.length && doc.entity_type === "grid" && context.resolution.gridIds.includes(doc.entity_id)) {
    score += 52;
  }
  if (context.classification?.asksPolicy && /(政策|规划|更新|步行街|改造|renewal|policy|planning)/i.test(search)) {
    score += 12;
  }
  if (context.classification?.asksRecommendation && /(建议|recommendation|scenario|情景|counterfactual|决策)/i.test(search)) {
    score += 10;
  }
  if (context.classification?.asksDiagnosis && /(诊断|残差|社会感知|活力|拥堵|grid|area)/i.test(search)) {
    score += 8;
  }

  return score;
}

function retrieveDocs(question, knowledge, context, limit = 5) {
  return knowledge
    .map((doc) => ({ ...doc, _score: scoreDocument(question, doc, context) }))
    .filter((doc) => doc._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function featureAdvice(feature, direction, label) {
  switch (feature) {
    case "distance_to_subway_entrance_m":
      return "优先把地铁口到商圈主入口这段路做顺，补过街引导、遮阴和连续步行线。";
    case "pedestrian_way_length_m":
      return direction === "negative"
        ? "不要再只是把步行道做得更长，重点是把断点接起来，让现有步行线更连续、更好走。"
        : "优先补齐连续步行线，减少绕行和断头路。";
    case "intersection_density_per_sqkm":
      return direction === "negative"
        ? "不要再靠增加路口解决问题，重点是把过街秩序、等候空间和行人优先做扎实。"
        : "把关键路口之间的过街联系补顺，减少被切断的步行路径。";
    case "poi_food_count":
      return direction === "negative"
        ? "餐饮不是越多越好，更该调布局、提品质，避免同质化扎堆。"
        : "可以补更适合停留的小餐饮和轻休闲业态，让人愿意多停一会儿。";
    case "poi_transit_count":
      return "补接驳、导向和交通服务配套，让进出这个片区更方便。";
    case "road_length_m":
      return "不必再单纯铺更多路，先把现有道路的慢行体验和街边停留感做细。";
    case "poi_count":
      return direction === "negative"
        ? "不要只靠继续堆店铺数量，重点是把业态分布和街道体验做平衡。"
        : "可以适当补一批能带来停留的生活服务和轻业态。";
    default:
      return direction === "negative"
        ? `不要再机械增加${label}，先把现有条件用顺。`
        : `优先补齐${label}这类短板。`;
  }
}

function clusterHint(label) {
  if (!label) return "";
  if (label.includes("夜间")) return "这个片区晚上更有吸引力，白天的承接和停留还可以再做强一点。";
  if (label.includes("午峰")) return "午间热度比较集中，早晚时段的连续活力还不够稳。";
  if (label.includes("平坦")) return "全天都有流量，但缺少特别能把人留住的高光时段。";
  return "它的日内人流节奏比较固定，更适合做有针对性的分时段优化。";
}

function buildCurrentSituation(primaryCard, areaCard) {
  const label = areaCard?.label || primaryCard?.label || (primaryCard?.grid_id ? `网格 ${primaryCard.grid_id}` : "这个片区");
  const residualValue = Number(primaryCard?.residual_mean ?? areaCard?.residual_summary?.residual_mean ?? 0);
  if (primaryCard?.grid_id) {
    if (residualValue > 0) return `${label}现在人流已经跑在承接能力前面，高峰时更容易出现挤压和拥堵。`;
    if (residualValue < 0) return `${label}不算缺条件，问题更像是现有空间没有把人顺畅留下来。`;
    return `${label}整体供需比较接近，属于可以做精细优化的状态。`;
  }
  if (residualValue > 0) return `${label}整体热度很高，接下来最怕的是高峰时段承接不够。`;
  if (residualValue < 0) return `${label}基础条件并不差，更需要做的是把现有资源真正转成稳定的人流和停留。`;
  return `${label}整体比较平稳，适合做小步快跑的微更新。`;
}

function buildProblemList(primaryCard, areaCard, decisionSupport, classification) {
  const problems = [];
  const card = primaryCard?.grid_id ? primaryCard : null;
  const residualValue = Number(primaryCard?.residual_mean ?? areaCard?.residual_summary?.residual_mean ?? 0);
  if (residualValue > 0) {
    problems.push("高峰承接压力偏大，热门时段更容易堵。");
  } else if (residualValue < 0) {
    problems.push("现有街道和商业条件没有完全转成真实停留，人来了也容易快速穿过。");
  } else {
    problems.push("整体不算失衡，但还缺少能明显提升体验的小改动。");
  }

  const social = card?.social_perception || areaCard?.social_summary;
  if (social?.top_complaint) {
    problems.push(`公众反馈里，"${social.top_complaint}"已经比较突出。`);
  }

  if (classification.asksSpecificLocation && areaCard?.grid_ids?.length) {
    const hotspotIds = rankAreaGridIds(areaCard, decisionSupport, "positive", 2);
    const hotspotCards = hotspotIds.map((gridId) => getGridCard(decisionSupport, gridId)).filter(Boolean);
    if (hotspotCards.length) {
      const positions = hotspotCards.map((item) => describeGridPosition(item, areaCard.grid_ids.map((gridId) => getGridCard(decisionSupport, gridId)).filter(Boolean))).filter(Boolean);
      problems.push(`更容易出拥堵的位置，多半落在这个片区的${positions.join("和")}。`);
    }
  }

  const clusterText = clusterHint(card?.cluster_label || areaCard?.dominant_clusters?.[0]?.cluster_label);
  if (clusterText) {
    problems.push(clusterText);
  }

  const actionable = card
    ? Object.entries(card.ale_actionable_features || {}).map(([feature, item]) => ({ feature, ...item }))
    : (areaCard?.top_actionable_features || []);
  const firstPositive = actionable.find((item) => item.feature === "poi_transit_count" && item.direction === "positive")
    || actionable.find((item) => item.direction === "positive");
  if (firstPositive) {
    const label = getFeatureLabel(decisionSupport, firstPositive.feature, firstPositive.label);
    problems.push(`${label}这类配套还有短板，补得准会更有效。`);
  }

  return [...new Set(problems)].slice(0, 3);
}

function buildSuggestionList(primaryCard, areaCard, decisionSupport) {
  const suggestions = [];
  const residualValue = Number(primaryCard?.residual_mean ?? areaCard?.residual_summary?.residual_mean ?? 0);
  if (residualValue > 0) {
    suggestions.push("先把高峰疏导、入口承接和人流分流做好，尤其是地铁口到核心街区的这段路线。");
  } else if (residualValue < 0) {
    suggestions.push("先盘活现有街道和店面界面，补导向、停留点和舒适步行体验，而不是继续堆新量。");
  } else {
    suggestions.push("先从小范围微更新入手，优先修补最影响通行和停留体验的断点。");
  }

  const card = primaryCard?.grid_id ? primaryCard : null;
  const actionable = card
    ? Object.entries(card.ale_actionable_features || {}).map(([feature, item]) => ({ feature, ...item }))
    : (areaCard?.top_actionable_features || []);
  actionable.slice(0, 4).forEach((item) => {
    const label = getFeatureLabel(decisionSupport, item.feature, item.label);
    suggestions.push(featureAdvice(item.feature, item.direction, label));
  });

  const bestScenario = card?.counterfactual_best_scenario;
  if (bestScenario?.feature === "distance_to_subway_entrance_m") {
    suggestions.unshift("把地铁口周边的出入口组织、过街动线和到店导向做顺，这一类改动通常更能立刻见效。");
  }

  return [...new Set(suggestions)].slice(0, 3);
}

function buildPolicySupportLine(webResults) {
  if (!webResults.length) return "";
  const titles = webResults.slice(0, 2).map((item) => item.title).filter(Boolean);
  if (!titles.length) return "";
  return `另外，最近公开信息里也在强调步行友好、商圈微更新和交通组织优化，这和上面的改法是一致的。`;
}

function buildEvidenceSummary(docs, webResults) {
  const titles = docs.map((doc) => doc.title).filter(Boolean);
  const seen = new Set();
  const summary = [];
  [...titles, ...webResults.map((item) => item.title).filter(Boolean)].forEach((title) => {
    if (!seen.has(title)) {
      seen.add(title);
      summary.push(title);
    }
  });
  return summary.slice(0, 6);
}

function buildNotice(provider, classification, webResults) {
  if (!provider || provider.type === "local") {
    return classification.needsWebSearch
      ? "当前先按现有研究数据回答，未叠加最新公开政策或联网补充。"
      : null;
  }
  if (classification.needsWebSearch && !webResults.length && !isWebSearchAvailable()) {
    return "当前未配置联网搜索，这次先按现有研究数据回答。";
  }
  return null;
}

function pickPrimaryEntity(decisionSupport, docs, resolution, classification) {
  if (resolution.gridIds?.length && classification.asksSpecificLocation) {
    const gridCard = getGridCard(decisionSupport, resolution.gridIds[0]);
    if (gridCard) {
      const areaCard = getAreaCard(decisionSupport, resolution.areaIds?.[0] || gridCard.area_id);
      return { primaryCard: gridCard, areaCard, entityType: "grid", entityId: gridCard.grid_id };
    }
  }

  if (resolution.areaIds?.length) {
    const areaCard = getAreaCard(decisionSupport, resolution.areaIds[0]);
    if (areaCard) {
      return { primaryCard: areaCard, areaCard, entityType: "area", entityId: areaCard.area_id };
    }
  }

  if (resolution.gridIds?.length) {
    const gridCard = getGridCard(decisionSupport, resolution.gridIds[0]);
    if (gridCard) {
      const areaCard = getAreaCard(decisionSupport, gridCard.area_id || resolution.areaIds?.[0]);
      return { primaryCard: gridCard, areaCard, entityType: "grid", entityId: gridCard.grid_id };
    }
  }

  const entityDoc = docs.find((doc) => doc.entity_type && doc.entity_id);
  if (entityDoc?.entity_type === "area") {
    const areaCard = getAreaCard(decisionSupport, entityDoc.entity_id);
    if (areaCard) {
      return { primaryCard: areaCard, areaCard, entityType: "area", entityId: areaCard.area_id };
    }
  }
  if (entityDoc?.entity_type === "grid") {
    const gridCard = getGridCard(decisionSupport, entityDoc.entity_id);
    if (gridCard) {
      const areaCard = getAreaCard(decisionSupport, gridCard.area_id);
      return { primaryCard: gridCard, areaCard, entityType: "grid", entityId: gridCard.grid_id };
    }
  }

  return { primaryCard: null, areaCard: null, entityType: null, entityId: null };
}

function buildClarificationAnswer(question, webResults = []) {
  return "\u6211\u4e0d\u592a\u786e\u5b9a\u4f60\u8bf4\u7684\u5177\u4f53\u662f\u54ea\u4e2a\u4f4d\u7f6e\u3002\u4f60\u53ef\u4ee5\u544a\u8bc9\u6211\u66f4\u5177\u4f53\u7684\u5730\u6807\u5417\uff1f\u6bd4\u5982\u9760\u8fd1 IFS\u3001\u592a\u53e4\u91cc\u3001\u603b\u5e9c\u8def\u8fd8\u662f\u6625\u7199\u8def\u6b65\u884c\u8857\uff1f\u8fd9\u6837\u6211\u80fd\u7ed9\u4f60\u66f4\u51c6\u786e\u7684\u5224\u65ad\u3002";
}

function buildOutsideScopeAnswer(question, webResults = []) {
  let answer = "\u4f60\u8bf4\u7684\u8fd9\u4e2a\u5730\u65b9\u4e0d\u5728\u6211\u73b0\u5728\u7684\u7814\u7a76\u8303\u56f4\u5185\u3002\u6211\u76ee\u524d\u4e3b\u8981\u8986\u76d6\u6625\u7199\u8def\u6b65\u884c\u8857\u3001IFS\u3001\u592a\u53e4\u91cc-\u5927\u6148\u5bfa\u548c\u603b\u5e9c\u8def\u8fd9\u51e0\u4e2a\u7247\u533a\u3002";
  if (webResults.length) {
    answer += "\n\n\u4e0d\u8fc7\u6211\u4ece\u516c\u5f00\u8d44\u6599\u91cc\u627e\u5230\u4e86\u4e00\u4e9b\u76f8\u5173\u4fe1\u606f\uff0c\u4ec5\u4f9b\u53c2\u8003\u3002\u5982\u679c\u4f60\u60f3\u95ee\u6625\u7199\u8def\u5546\u5708\u5185\u7684\u60c5\u51b5\uff0c\u968f\u65f6\u544a\u8bc9\u6211\u3002";
  }
  return answer;
}

function buildPolicyUnavailableAnswer() {
  if (isWebSearchAvailable()) {
    return "这次搜索没有找到直接相关的政策信息。你可以换个更具体的关键词再试，比如'春熙路步行街改造'或'锦江区商圈政策'。也可以问我片区现状和改善方向，这方面我比较有把握。";
  }
  return "这类问题需要联网搜索最新信息，但当前没有配置搜索服务。你可以设置 TAVILY_API_KEY 后重启来启用联网搜索，或者先问我春熙路商圈的现状分析和改善建议。";
}

function buildLocalAnswer(question, docs, context, dashboard) {
  const { classification, decisionSupport, resolution, webResults, provider } = context;

  if (resolution.outsideStudyArea) {
    return {
      mode: provider?.label || "本地证据模式",
      answer: buildOutsideScopeAnswer(question, webResults),
      sources: buildEvidenceSummary(docs, webResults),
      evidenceSummary: buildEvidenceSummary(docs, webResults),
      webSources: webResults,
      resolvedEntities: [],
      mapFocus: null,
      notice: buildNotice(provider, classification, webResults),
    };
  }

  const picked = pickPrimaryEntity(decisionSupport, docs, resolution, classification);
  if (!picked.primaryCard && !docs.length) {
    return {
      mode: provider?.label || "本地证据模式",
      answer: classification.asksPolicy ? buildPolicyUnavailableAnswer() : buildClarificationAnswer(question, webResults),
      sources: [],
      evidenceSummary: [],
      webSources: webResults,
      resolvedEntities: [],
      mapFocus: null,
      notice: buildNotice(provider, classification, webResults),
    };
  }

  const current = buildCurrentSituation(picked.primaryCard, picked.areaCard);
  const problems = buildProblemList(picked.primaryCard, picked.areaCard, decisionSupport, classification);
  const suggestions = buildSuggestionList(picked.primaryCard, picked.areaCard, decisionSupport);
  const lines = [
    `现状：${current}`,
    "主要问题：",
    ...problems.map((item, index) => `${index + 1}. ${item}`),
    "建议：",
    ...suggestions.map((item, index) => `${index + 1}. ${item}`),
  ];

  const policySupport = buildPolicySupportLine(webResults);
  if (policySupport) {
    lines.push(`说明：${policySupport}`);
  } else if (classification.asksPolicy && !webResults.length) {
    lines.push("说明：这次没有叠加到最新公开政策，我先按现有研究数据给出判断。");
  }

  return {
    mode: provider?.label || "本地证据模式",
    answer: lines.join("\n"),
    sources: buildEvidenceSummary(docs, webResults),
    evidenceSummary: buildEvidenceSummary(docs, webResults),
    webSources: webResults,
    resolvedEntities: buildResolvedEntities(decisionSupport, resolution),
    mapFocus: resolveMapFocus(decisionSupport, resolution),
    notice: buildNotice(provider, classification, webResults),
  };
}

async function callHostedPlanner(provider, question, docs, messages, context) {
  const recentMessages = (messages || []).slice(-6).map((item) => ({
    role: item.role,
    content: item.body || item.content || "",
  }));

  const result = await callCompatibleChat(provider, {
    temperature: 0.25,
    maxTokens: 1200,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify(
          {
            question,
            question_analysis: context.classification,
            place_resolution: {
              normalized_place: context.resolution.normalizedPlace || "",
              resolved_area_ids: context.resolution.areaIds || [],
              candidate_grid_ids: context.resolution.gridIds || [],
              outside_study_area: Boolean(context.resolution.outsideStudyArea),
            },
            retrieved_evidence: docs.map(makeHumanReadableDoc),
            web_evidence: context.webResults,
            recent_messages: recentMessages,
          },
          null,
          2,
        ),
      },
    ],
  });

  let answer = result.text;
  if (containsForbiddenOutput(answer)) {
    try {
      answer = await rewritePlainLanguageAnswer(provider, question, answer);
    } catch (error) {
      // keep original answer for final check below
    }
  }

  if (containsForbiddenOutput(answer)) {
    throw new Error("Hosted answer still contains technical jargon after rewrite.");
  }

  return {
    mode: provider.label + (context.webResults.length ? " + Web" : ""),
    answer,
    sources: buildEvidenceSummary(docs, context.webResults),
    evidenceSummary: buildEvidenceSummary(docs, context.webResults),
    webSources: context.webResults,
    resolvedEntities: buildResolvedEntities(context.decisionSupport, context.resolution),
    mapFocus: resolveMapFocus(context.decisionSupport, context.resolution),
    notice: buildNotice(provider, context.classification, context.webResults),
  };
}

async function answerPlanningQuestion({ question, messages, provider, dashboard, knowledge, decisionBundle }) {
  const classification = classifyQuestion(question);

  if (classification.isGreeting) {
    return {
      mode: provider?.label || "本地证据模式",
      answer: "你好！我是春熙路规划助手，对春熙路、太古里、IFS、总府路这一带比较熟悉。你可以问我某个片区的人流情况、步行体验，或者哪里需要优先改善。想了解哪里？",
      sources: [],
      evidenceSummary: [],
      webSources: [],
      resolvedEntities: [],
      mapFocus: null,
      notice: null,
    };
  }

  const { resolution, webResults } = await resolveQuestionContext(question, provider, decisionBundle, classification);
  const decisionSupport = decisionBundle.support;
  const docs = retrieveDocs(question, knowledge, { classification, resolution });

  const baseContext = {
    classification,
    decisionSupport,
    resolution,
    webResults,
    provider,
    dashboard,
  };

  if (!provider || provider.type === "local") {
    return buildLocalAnswer(question, docs, baseContext, dashboard);
  }

  if (!provider.available) {
    const fallback = buildLocalAnswer(question, docs, baseContext, dashboard);
    fallback.mode = "本地证据模式";
    fallback.notice = `${provider.label} 当前未在本机配置，已自动回退到本地证据模式。`;
    return fallback;
  }

  try {
    return await callHostedPlanner(provider, question, docs, messages, baseContext);
  } catch (error) {
    const fallback = buildLocalAnswer(question, docs, baseContext, dashboard);
    fallback.mode = "本地证据模式";
    fallback.notice = `${provider.label} 暂时不可用，已自动回退到本地证据模式。${error.message}`;
    return fallback;
  }
}

module.exports = {
  answerPlanningQuestion,
};

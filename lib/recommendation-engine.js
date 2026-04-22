const { callCompatibleChat, resolveProvider } = require("./provider-client");

function entityCacheKey(entityType, entityId, provider = "local") {
  return `${entityType}:${entityId}:${provider}`;
}

function getDecisionCard(decisionSupport, entityType, entityId) {
  if (!decisionSupport) return null;
  if (entityType === "grid") {
    return decisionSupport.grid_cards?.[entityId] || null;
  }
  if (entityType === "area") {
    return decisionSupport.area_cards?.[entityId] || null;
  }
  return null;
}

function getFeatureLabel(meta, feature) {
  return meta?.feature_labels?.[feature] || feature;
}

function cardLabel(card) {
  if (!card) return "";
  if (card.grid_id) return `网格 ${card.grid_id}`;
  if (card.label) return card.label;
  return card.area_id || "";
}

function sortActionableFeatures(card) {
  const featureMap = card?.ale_actionable_features || {};
  const shapOrder = new Map((card?.shap_top3 || []).map((item, index) => [item.feature, index]));
  const inlineItems = Object.entries(featureMap).map(([feature, value]) => ({ feature, ...value }));
  const areaItems = Array.isArray(card?.top_actionable_features)
    ? card.top_actionable_features.map((item) => ({ ...item, current_percentile: item.mean_percentile, current_value: item.mean_value }))
    : [];
  return [...inlineItems, ...areaItems]
    .sort((a, b) => {
      const aRank = shapOrder.has(a.feature) ? shapOrder.get(a.feature) : 99;
      const bRank = shapOrder.has(b.feature) ? shapOrder.get(b.feature) : 99;
      if (aRank !== bRank) return aRank - bRank;
      return (b.current_percentile || 0) - (a.current_percentile || 0);
    });
}

function chooseConfidence(card) {
  let score = 0.55;
  if (card?.counterfactual_best_scenario?.available) score += 0.12;
  if ((card?.shap_top3 || []).length >= 3) score += 0.12;
  if (card?.social_perception?.post_count) score += 0.08;
  if (card?.cluster_label) score += 0.05;
  score = Math.min(score, 0.92);
  const level = score >= 0.8 ? "high" : score >= 0.65 ? "medium" : "medium_low";
  return {
    level,
    score: Number(score.toFixed(2)),
    reason: "基于 formal SHAP、ALE、残差、聚类、社会感知和反事实情景的结构化证据综合判断。",
  };
}

function describeResidual(card) {
  if (card?.grid_id) {
    const residual = Number(card.residual_mean || 0);
    if (residual > 0) {
      return `该网格当前表现为正残差（actual > predicted，均值 ${residual.toFixed(1)}），说明需求强于现有供给预期。`;
    }
    if (residual < 0) {
      return `该网格当前表现为负残差（actual < predicted，均值 ${residual.toFixed(1)}），说明现有供给没有被充分转化为实际活力。`;
    }
    return "该网格残差接近 0，说明当前供给水平与需求表现大体匹配。";
  }

  const residual = Number(card?.residual_summary?.residual_mean || 0);
  if (residual > 0) {
    return `该片区整体为正残差（均值 ${residual.toFixed(1)}），需要优先考虑承接和扩容。`;
  }
  if (residual < 0) {
    return `该片区整体为负残差（均值 ${residual.toFixed(1)}），更适合做存量优化和空间激活。`;
  }
  return "该片区残差整体接近 0，可按稳态微更新推进。";
}

function buildEvidence(card, meta, feature, extra = []) {
  const label = getFeatureLabel(meta, feature);
  const actionable =
    card?.ale_actionable_features?.[feature]
    || (Array.isArray(card?.top_actionable_features)
      ? card.top_actionable_features.find((item) => item.feature === feature)
      : null);
  const evidence = [];
  if (actionable) {
    evidence.push(
      `${label} 当前分位 ${Math.round((actionable.current_percentile || 0) * 100)}%，ALE 方向为 ${actionable.direction}.`,
    );
    if (actionable.first_acceleration_point !== null && actionable.first_acceleration_point !== undefined) {
      evidence.push(`${label} 的拐点参考值约为 ${Number(actionable.first_acceleration_point).toFixed(2)}。`);
    }
    if (actionable.saturation_point !== null && actionable.saturation_point !== undefined) {
      evidence.push(`${label} 的边际饱和参考值约为 ${Number(actionable.saturation_point).toFixed(2)}。`);
    }
  }
  (card?.shap_top3 || []).forEach((item) => {
    if (item.feature === feature) {
      evidence.push(`${label} 位于该对象 SHAP Top3，局部影响值 ${Number(item.shap_value).toFixed(4)}。`);
    }
  });
  extra.forEach((item) => {
    if (item) evidence.push(item);
  });
  return evidence;
}

function buildThemeAction(card, meta, rank, featureItem) {
  const feature = featureItem?.feature;
  const label = getFeatureLabel(meta, feature);
  const isPositive = featureItem?.direction === "positive";
  const social = card?.social_perception || card?.social_summary || {};
  const complaint = social.top_complaint;
  const signal = social.top_signal;

  if (isPositive) {
    return {
      rank,
      theme: `优先改善${label}`,
      why: `${label} 在当前区间仍有提升空间，适合做直接的空间增益或服务补足。`,
      measures: [
        `围绕 ${label} 制定网格级提升清单，先补足低于合理阈值的短板点位。`,
        complaint === "交通压力"
          ? "同步处理交通组织与慢行引导，避免新增供给被通行摩擦抵消。"
          : `将 ${label} 改造与周边步行流线、店铺界面和导视系统一体化。`,
        "优先在高峰时段压力较大的路径和入口点位做小范围快改快试。",
      ],
      evidence: buildEvidence(card, meta, feature, [
        signal ? `社会感知中“${signal}”是当前片区最强的正向语义之一。` : null,
      ]),
      urgency: rank === 1 ? "high" : "medium",
    };
  }

  return {
    rank,
    theme: `避免机械堆叠${label}`,
    why: `${label} 的 ALE 方向为 negative，继续增加的边际收益已弱化，更应优化质量与使用效率。`,
    measures: [
      `不再单纯追求 ${label} 数量增长，转向动线、停留体验和使用组织的精细化调整。`,
      "将新增投资优先投向真正仍有提升空间的要素，而不是在已饱和维度继续加码。",
      complaint === "交通压力"
        ? "若公众已感知交通压力，优先做秩序疏导和可达性修补，而不是叠加更多高强度供给。"
        : "通过业态组合、导视、活动策划和时段运营来提升既有供给转化效率。",
    ],
    evidence: buildEvidence(card, meta, feature, [
      complaint ? `社会感知中“${complaint}”已出现，提示需要关注体验摩擦。` : null,
    ]),
    urgency: rank === 1 ? "high" : "medium",
  };
}

function buildResidualAction(card, meta, rank) {
  const residual = Number(card?.residual_mean ?? card?.residual_summary?.residual_mean ?? 0);
  const counterfactual = card?.counterfactual_best_scenario;
  const feature = counterfactual?.feature || sortActionableFeatures(card)[0]?.feature;
  const label = getFeatureLabel(meta, feature);
  const social = card?.social_perception || card?.social_summary || {};

  if (residual > 0) {
    return {
      rank,
      theme: "补足承接能力",
      why: "需求已经跑在当前供给预期前面，优先任务是补短板、提高高峰承接能力。",
      measures: [
        counterfactual?.feature === "distance_to_subway_entrance_m"
          ? "优先围绕地铁口接驳、导流和入口步行连续性做网格级微更新。"
          : `围绕 ${label} 做第一轮承接能力补齐，优先处理高峰期瓶颈点位。`,
        "在高峰时段同步优化人流组织、导视和短停空间，避免需求外溢变成拥堵摩擦。",
        "把高需求网格与相邻次级网格联动设计，提升片区整体消纳能力。",
      ],
      evidence: [
        describeResidual(card),
        counterfactual?.scenario
          ? `反事实中当前最优情景为 ${counterfactual.scenario}，提示 ${label} 相关措施更值得优先测试。`
          : null,
        social.top_complaint ? `社会感知已出现“${social.top_complaint}”信号，可作为紧迫性佐证。` : null,
      ].filter(Boolean),
      urgency: "high",
    };
  }

  return {
    rank,
    theme: "提升利用效率",
    why: "模型当前高估了该对象的活力表现，说明继续堆供给未必有效，更需要把现有条件转成真实使用。",
    measures: [
      "优先通过业态激活、时段运营和步行动线梳理提升现有供给的转化效率。",
      counterfactual?.feature === "distance_to_subway_entrance_m"
        ? "把可达性修补与活动组织配套推进，避免单点改善无法转化为稳定客流。"
        : `若继续投资，优先选择仍具提升空间的 ${label}，而不是对已饱和特征继续叠加。`,
      "以低成本快改和运营实验先验证效果，再决定是否上更重的建设类投入。",
    ],
    evidence: [
      describeResidual(card),
      counterfactual?.scenario
        ? `反事实显示 ${counterfactual.scenario} 仍可能带来正向改善，但幅度有限，说明要结合运营和空间品质同步发力。`
        : null,
      social.top_signal ? `社会感知中“${social.top_signal}”较突出，可作为塑造差异化体验的抓手。` : null,
    ].filter(Boolean),
    urgency: Math.abs(residual) > 1500 ? "high" : "medium",
  };
}

function buildClusterAction(card, meta, rank) {
  const label = card?.cluster_label || (card?.dominant_clusters?.[0]?.cluster_label ?? "当前画像");
  const social = card?.social_perception || card?.social_summary || {};
  const featureItem = sortActionableFeatures(card)[1] || sortActionableFeatures(card)[0];
  const featureLabel = featureItem ? getFeatureLabel(meta, featureItem.feature) : "关键供给特征";

  return {
    rank,
    theme: "按需求画像做时段化运营",
    why: `${label} 说明该对象存在明确的时段使用模式，空间改善应与运营时段匹配。`,
    measures: [
      `${label} 类型优先做“时段 × 动线 × 活动”联动设计，让 ${featureLabel} 在关键时段真正被使用。`,
      social.top_signal
        ? `把社会感知中的“${social.top_signal}”转成场景化体验策略，强化已有优势。`
        : "对高峰前后两个小时做轻量运营试验，校准真实使用行为。",
      "把监测指标拆到工作日/周末和高峰/平峰两个维度，持续观察空间调整后的响应差异。",
    ],
    evidence: [
      label ? `当前需求画像为 ${label}。` : null,
      social.top_signal ? `片区主观感知高频语义为“${social.top_signal}”。` : null,
    ].filter(Boolean),
    urgency: "medium",
  };
}

function buildPlanningMeasures(actions) {
  return {
    quick_wins: actions[0]?.measures?.slice(0, 2) || [],
    mid_term: actions[1]?.measures?.slice(0, 2) || [],
    long_term: actions[2]?.measures?.slice(0, 2) || [],
  };
}

function buildCaution(card, meta) {
  const saturated = sortActionableFeatures(card)
    .filter((item) => item.direction === "negative")
    .slice(0, 2)
    .map((item) => getFeatureLabel(meta, item.feature));
  if (saturated.length) {
    return `对 ${saturated.join("、")} 这类 ALE 为 negative 的特征，不建议继续机械增加，应转向效率和品质优化。`;
  }
  return "社会感知只作为辅助证据，建议以 SHAP、ALE、残差和反事实结论为主进行优先级排序。";
}

function buildDeterministicRecommendation(decisionSupport, entityType, entityId) {
  const card = getDecisionCard(decisionSupport, entityType, entityId);
  if (!card) {
    throw new Error(`Missing decision card for ${entityType}:${entityId}`);
  }
  const meta = decisionSupport?.meta || {};
  const featureItems = sortActionableFeatures(card);
  const actions = [
    buildResidualAction(card, meta, 1),
    buildThemeAction(card, meta, 2, featureItems[0] || { feature: "distance_to_subway_entrance_m", direction: "positive" }),
    buildClusterAction(card, meta, 3),
  ];

  return {
    entity_type: entityType,
    entity_id: entityId,
    diagnostic_conclusion: `${cardLabel(card)}：${describeResidual(card)} 当前画像为 ${card.cluster_label || card.dominant_clusters?.[0]?.cluster_label || "未命名类型"}，应避免把解释力弱的社会感知当作主诊断，而应围绕 SHAP Top3 与 ALE 可行动特征制定改造优先级。`,
    priority_actions: actions,
    planning_measures: buildPlanningMeasures(actions),
    caution: buildCaution(card, meta),
    confidence: chooseConfidence(card),
  };
}

function buildRecommendationPrompt(decisionSupport, entityType, entityId) {
  const card = getDecisionCard(decisionSupport, entityType, entityId);
  if (!card) {
    throw new Error(`Missing decision card for ${entityType}:${entityId}`);
  }
  const meta = decisionSupport?.meta || {};
  const system = [
    "你是城市规划决策支持助手。",
    "你只能基于给定的结构化诊断卡给出规划建议，不得虚构额外事实。",
    "必须遵守这些解释规则：",
    "- cluster_label 代表需求时间画像，应转成时段化运营或空间策略。",
    "- supply_profile 是当前供给值，supply_zscore 是相对全体 105 网格的偏离程度。",
    "- ALE direction=negative 表示边际效应已弱化或接近饱和，不建议继续机械增加该特征。",
    "- ALE direction=positive 表示存在提升空间，可作为优先改造抓手。",
    "- residual_mean < 0 代表供给未被充分利用 / 空间品质拖累 / 高估。",
    "- residual_mean > 0 代表需求超出供给预期 / 低估。",
    "- social_perception 只能作为佐证，不得覆盖结构化诊断主结论。",
    "请只输出 JSON，不要输出 Markdown，不要额外解释。",
    "JSON schema:",
    JSON.stringify(
      {
        entity_type: entityType,
        entity_id: entityId,
        diagnostic_conclusion: "string",
        priority_actions: [
          {
            rank: 1,
            theme: "string",
            why: "string",
            measures: ["string"],
            evidence: ["string"],
            urgency: "high|medium|low",
          },
        ],
        planning_measures: {
          quick_wins: ["string"],
          mid_term: ["string"],
          long_term: ["string"],
        },
        caution: "string",
        confidence: {
          level: "high|medium|medium_low|low",
          score: 0.0,
          reason: "string",
        },
      },
      null,
      2,
    ),
  ].join("\n");

  const user = JSON.stringify(
    {
      meta: {
        checkpoint_path: meta.checkpoint_path,
        top_supply_features: meta.top_supply_features,
        explanation_rules: meta.explanation_rules,
        feature_labels: meta.feature_labels,
      },
      card,
    },
    null,
    2,
  );
  return { system, user };
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
        const candidate = trimmed.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch (error) {
          return null;
        }
      }
    }
  }
  return null;
}

function validateRecommendationShape(payload, entityType, entityId) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Recommendation payload is not an object.");
  }
  if (!Array.isArray(payload.priority_actions) || payload.priority_actions.length < 3) {
    throw new Error("Recommendation payload is missing priority_actions.");
  }
  if (!payload.planning_measures || typeof payload.planning_measures !== "object") {
    throw new Error("Recommendation payload is missing planning_measures.");
  }
  return {
    entity_type: payload.entity_type || entityType,
    entity_id: payload.entity_id || entityId,
    diagnostic_conclusion: String(payload.diagnostic_conclusion || ""),
    priority_actions: payload.priority_actions.slice(0, 5).map((item, index) => ({
      rank: Number(item.rank || index + 1),
      theme: String(item.theme || `Action ${index + 1}`),
      why: String(item.why || ""),
      measures: Array.isArray(item.measures) ? item.measures.map(String) : [],
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String) : [],
      urgency: String(item.urgency || "medium"),
    })),
    planning_measures: {
      quick_wins: Array.isArray(payload.planning_measures.quick_wins)
        ? payload.planning_measures.quick_wins.map(String)
        : [],
      mid_term: Array.isArray(payload.planning_measures.mid_term)
        ? payload.planning_measures.mid_term.map(String)
        : [],
      long_term: Array.isArray(payload.planning_measures.long_term)
        ? payload.planning_measures.long_term.map(String)
        : [],
    },
    caution: String(payload.caution || ""),
    confidence: payload.confidence || { level: "medium_low", score: 0.5, reason: "Hosted output did not return confidence." },
  };
}

async function generateRecommendation(decisionSupport, entityType, entityId, providerId) {
  const fallback = buildDeterministicRecommendation(decisionSupport, entityType, entityId);
  const provider = resolveProvider(providerId);
  if (!provider || provider.type === "local") {
    return { provider: "local", recommendation: fallback, notice: null };
  }
  if (!provider.available) {
    return {
      provider: "local",
      recommendation: fallback,
      notice: `${provider.label} 当前未配置，已回退到本地确定性建议生成器。`,
    };
  }

  const { system, user } = buildRecommendationPrompt(decisionSupport, entityType, entityId);

  try {
    const result = await callCompatibleChat(provider, {
      temperature: 0.15,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = extractJsonObject(result.text);
    const recommendation = validateRecommendationShape(parsed, entityType, entityId);
    return { provider: provider.id, recommendation, notice: null };
  } catch (error) {
    return {
      provider: "local",
      recommendation: fallback,
      notice: `${provider.label} 返回异常，已回退到本地确定性建议生成器。${error.message}`,
    };
  }
}

function listAllDecisionEntities(decisionSupport) {
  const entities = [];
  Object.keys(decisionSupport?.grid_cards || {}).forEach((gridId) => {
    entities.push({ entityType: "grid", entityId: gridId });
  });
  Object.keys(decisionSupport?.area_cards || {}).forEach((areaId) => {
    entities.push({ entityType: "area", entityId: areaId });
  });
  return entities;
}

module.exports = {
  buildDeterministicRecommendation,
  entityCacheKey,
  generateRecommendation,
  getDecisionCard,
  listAllDecisionEntities,
  validateRecommendationShape,
};

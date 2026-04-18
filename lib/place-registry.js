const AREA_ALIAS_CONFIG = {
  chunxi_core: {
    aliases: [
      "春熙路",
      "春熙路核心",
      "春熙路步行街",
      "春熙路步行街核心",
      "银石广场",
      "银石",
      "群光广场",
      "群光",
      "王府井",
      "伊藤洋华堂",
      "伊藤",
      "龙抄手",
    ],
  },
  ifs_core: {
    aliases: [
      "ifs",
      "ifs国际金融中心",
      "国际金融中心",
      "国金中心",
      "大熊猫",
      "爬墙熊猫",
      "熊猫爬楼",
      "熊猫爬墙",
      "熊猫那边",
      "熊猫爬楼那栋",
    ],
  },
  zongfu_road: {
    aliases: [
      "总府路",
      "总府路沿线",
      "总府路口",
      "红星路口",
      "地铁口那条街",
      "地铁口出来那条步行街",
    ],
  },
  taikoo_daci_merged: {
    aliases: [
      "太古里",
      "远洋太古里",
      "太古里商圈",
      "大慈寺",
      "大慈寺商圈",
      "太古里大慈寺",
      "太古里-大慈寺",
    ],
  },
};

function normalizePlaceText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{Script=Han}a-z0-9]/gu, "");
}

function parseGridIds(text = "") {
  const matches = String(text).match(/\b\d{1,2}_\d{1,2}\b/g) || [];
  return [...new Set(matches)];
}

function buildPlaceRegistry(decisionSupport) {
  const areaCards = decisionSupport?.area_cards || {};
  const areaEntries = Object.values(areaCards).map((card) => {
    const aliasConfig = AREA_ALIAS_CONFIG[card.area_id] || {};
    const aliases = new Set([card.label, card.area_id, ...(aliasConfig.aliases || [])].filter(Boolean));
    return {
      areaId: card.area_id,
      label: card.label || card.area_id,
      aliases: [...aliases],
      normalizedAliases: [...aliases].map(normalizePlaceText).filter(Boolean),
      gridIds: [...new Set(card.grid_ids || [])],
    };
  });

  const areaIndex = areaEntries.flatMap((entry) => {
    return entry.normalizedAliases.map((alias) => ({
      areaId: entry.areaId,
      label: entry.label,
      alias,
      score: alias.length >= 5 ? 14 : alias.length >= 3 ? 11 : 8,
    }));
  });

  const gridToArea = new Map();
  areaEntries.forEach((entry) => {
    entry.gridIds.forEach((gridId) => {
      if (!gridToArea.has(gridId)) {
        gridToArea.set(gridId, entry.areaId);
      }
    });
  });

  return {
    areas: areaEntries,
    areaIndex,
    gridToArea,
  };
}

function resolveLocalPlace(question, registry, decisionSupport) {
  const gridIds = parseGridIds(question).filter((gridId) => decisionSupport?.grid_cards?.[gridId]);
  if (gridIds.length) {
    const areaIds = [...new Set(gridIds.map((gridId) => registry.gridToArea.get(gridId)).filter(Boolean))];
    return {
      method: "grid_id",
      confidence: 0.98,
      normalizedPlace: gridIds.join(", "),
      areaIds,
      gridIds,
      outsideStudyArea: false,
    };
  }

  const normalizedQuestion = normalizePlaceText(question);
  const scores = new Map();
  registry.areaIndex.forEach((item) => {
    if (!item.alias) return;
    if (normalizedQuestion.includes(item.alias)) {
      scores.set(item.areaId, (scores.get(item.areaId) || 0) + item.score);
    }
  });

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([areaId, score]) => {
      const entry = registry.areas.find((item) => item.areaId === areaId);
      const confidence = Math.max(0.55, Math.min(0.93, 0.56 + score / 30));
      return {
        areaId,
        label: entry?.label || areaId,
        gridIds: entry?.gridIds || [],
        confidence: Number(confidence.toFixed(2)),
      };
    });

  if (ranked.length) {
    return {
      method: "local_alias",
      confidence: ranked[0].confidence,
      normalizedPlace: ranked[0].label,
      areaIds: ranked.map((item) => item.areaId),
      gridIds: [],
      outsideStudyArea: false,
    };
  }

  return {
    method: "none",
    confidence: 0,
    normalizedPlace: "",
    areaIds: [],
    gridIds: [],
    outsideStudyArea: false,
  };
}

module.exports = {
  AREA_ALIAS_CONFIG,
  buildPlaceRegistry,
  normalizePlaceText,
  parseGridIds,
  resolveLocalPlace,
};

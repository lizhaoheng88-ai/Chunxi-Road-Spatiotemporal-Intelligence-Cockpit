const state = {
  dashboard: null,
  decisionSupport: null,
  decisionGraph: null,
  recommendationCache: {},
  chatMessages: [],
  selectedProvider: "local",
  selectedDecisionProvider: "local",
  activeView: "chat",
  vaultOpen: false,
  selectedEntityType: "grid",
  selectedEntityId: null,
  decisionRecommendation: null,
  decisionRecommendationProvider: "local",
  decisionRecommendationFromCache: true,
  decisionRecommendationNotice: "",
  decisionAreaFilter: "all",
  decisionLeaflet: null,
  decisionMapShouldFocus: false,
  chatResolvedEntities: [],
  chatMapFocus: null,
  layers: {
    roads: true,
    pedestrian: true,
    flows: true,
    hotspots: true,
    subway: true,
    cameras: true,
  },
};

const colors = {
  jade: "#1d7964",
  amber: "#bd7c2f",
  terracotta: "#bf5b43",
  ink: "#1c221f",
  muted: "#6a726d",
  grid: "rgba(28, 34, 31, 0.12)",
};

document.addEventListener("DOMContentLoaded", () => {
  setupReveal();
  init().catch((error) => {
    console.error(error);
    document.getElementById("projectTitle").textContent = "平台加载失败";
    document.getElementById("projectSubtitle").textContent = error.message;
  });
});

async function init() {
  const [dashboardResponse, decisionResponse] = await Promise.all([
    fetch("/api/dashboard"),
    fetch("/api/decision-support"),
  ]);
  if (!dashboardResponse.ok) {
    throw new Error("无法加载 dashboard 数据。");
  }
  if (!decisionResponse.ok) {
    throw new Error("无法加载决策证据数据。");
  }

  state.dashboard = await dashboardResponse.json();
  const decisionBundle = await decisionResponse.json();
  state.decisionSupport = decisionBundle.support;
  state.decisionGraph = decisionBundle.graph;
  state.recommendationCache = decisionBundle.cache?.recommendations || {};
  state.selectedProvider = state.dashboard.defaultChatProvider || "local";
  state.selectedDecisionProvider = decisionBundle.defaultProvider || "local";
  const initialGrid = chooseInitialDecisionGrid();
  state.selectedEntityType = "grid";
  state.selectedEntityId = initialGrid;
  renderPage();
  bindLayerControls();
  bindWorkspaceNav();
  bindChat();
  bindProviderSelect();
  bindDecisionWorkspace();
  seedChat();
  initializeWorkspace();
  if (state.selectedEntityId) {
    await loadDecisionRecommendation("cached");
  }
}

function setupReveal() {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
        }
      }
    },
    { threshold: 0.18 },
  );

  document.querySelectorAll(".reveal").forEach((item) => observer.observe(item));
}

function renderPage() {
  const { dashboard } = state;
  document.getElementById("projectTitle").textContent = publicProjectTitle();
  document.getElementById("projectSubtitle").textContent = publicProjectSubtitle();
  document.getElementById("chatProviderText").textContent = "可以直接问：哪里容易拥堵、哪个片区更适合先改、哪些路口更需要改善步行体验。";
  document.getElementById("chatModeBadge").textContent = publicModeLabel(getProviderMeta(state.selectedProvider)?.label || dashboard.chatProvider);

  renderHeroFacts(dashboard.metrics);
  renderMetrics(dashboard.metrics);
  renderFramework(dashboard.framework.pillars);
  renderDatasets(dashboard.datasets);
  renderPatterns(dashboard.patterns);
  renderProviderOptions(dashboard.chatProviders);
  renderSignalChart(dashboard.signal.timeline);
  renderHotspotChart(dashboard.signal.hotspots);
  renderFusedVideoTimeline(dashboard.video.fusedTimeline);
  renderFusedHeatmap(dashboard.video.fusedHeatmap);
  renderMap();
  renderSocialChart(dashboard.social.themeCounts);
  renderSocialSamples(dashboard.social.samples);
  renderStreetMetrics(dashboard.streetScene.summary);
  renderRoadSummary(dashboard.road.summary);
  renderForecastComparison(dashboard.forecast.modelComparison);
  renderForecastTimeline(dashboard.forecast.timeline, dashboard.forecast.summary);
  renderForecastGates(dashboard.forecast.hybridGateWeights);
  renderForecastSummary(dashboard.forecast.summaryCards);
  renderForecastHighlights(dashboard.forecast.highlights);
  renderForecastTopGrids(dashboard.forecast.hybridTopGrids, dashboard.forecast.hybridErrorGrids);
  renderPromptChips(dashboard.chatPrompts);
  renderVideoLabels();
  renderCameraBreakdown(dashboard.video.cameraBreakdown);
  renderDecisionWorkspace();
  renderChatContextBar();
  updateProviderHint();
  syncChatLandingState();
}

function normalizeView(viewId) {
  const availableViews = new Set(
    Array.from(document.querySelectorAll(".workspace-view")).map((node) => node.getAttribute("data-view")),
  );
  return availableViews.has(viewId) ? viewId : "chat";
}

function initializeWorkspace() {
  state.vaultOpen = false;
  syncVaultState();
  syncViewFromHash();
  syncChatLandingState();
}

function bindWorkspaceNav() {
  document.querySelectorAll("[data-view-target]").forEach((control) => {
    control.addEventListener("click", () => {
      const target = control.getAttribute("data-view-target") || "chat";
      setActiveView(target);

      if (control.classList.contains("vault-link") && window.innerWidth < 960) {
        state.vaultOpen = false;
        syncVaultState();
      }
    });
  });

  document.getElementById("vaultToggle").addEventListener("click", () => {
    state.vaultOpen = !state.vaultOpen;
    syncVaultState();
  });

  window.addEventListener("hashchange", () => syncViewFromHash());
}

function syncVaultState() {
  document.body.classList.toggle("vault-open", state.vaultOpen);
  document.getElementById("vaultToggle").setAttribute("aria-expanded", state.vaultOpen ? "true" : "false");
}

function syncViewFromHash() {
  const hashView = window.location.hash.replace(/^#/, "").trim();
  setActiveView(hashView || "chat", { updateHash: false, scroll: false });
}

function setActiveView(viewId, options = {}) {
  const { updateHash = true, scroll = true } = options;
  const nextView = normalizeView(viewId);
  state.activeView = nextView;

  document.querySelectorAll(".workspace-view").forEach((node) => {
    const isActive = node.getAttribute("data-view") === nextView;
    node.classList.toggle("active", isActive);
    node.hidden = !isActive;
    if (isActive) {
      node.classList.add("visible");
    }
  });

  document.querySelectorAll("[data-view-target]").forEach((control) => {
    const isActive = control.getAttribute("data-view-target") === nextView;
    control.classList.toggle("active", isActive);
    control.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  if (updateHash) {
    const nextHash = `#${nextView}`;
    if (window.location.hash !== nextHash) {
      history.replaceState(null, "", nextHash);
    }
  }

  if (scroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  syncChatLandingState();

  if (nextView === "decision") {
    window.requestAnimationFrame(() => {
      renderDecisionWorkspace();
    });
  }
}

function formatNumber(value) {
  return Number(value).toLocaleString();
}

function shortNumber(value) {
  const number = Number(value);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const PUBLIC_STARTER_PROMPTS = [
  "春熙路现在最需要优先解决的问题是什么？",
  "IFS 熊猫附近哪里最容易拥堵？",
  "总府路沿线怎样改造会更舒服？",
  "太古里和春熙路核心的人流特点有什么区别？",
  "哪几个片区更适合优先改善步行体验？",
  "如果要先做小规模改造，应该从哪里下手？",
];

const FEATURE_LABELS = {
  road_length_m: "道路长度",
  pedestrian_way_length_m: "步行通道长度",
  sidewalk_length_m: "人行道长度",
  crossing_count: "过街设施数量",
  intersection_density_per_sqkm: "路网交叉密度",
  distance_to_subway_entrance_m: "距地铁入口距离",
  poi_count: "兴趣点数量",
  poi_diversity: "业态丰富度",
  poi_shopping_count: "购物点位数量",
  poi_food_count: "餐饮点位数量",
  poi_entertainment_count: "娱乐点位数量",
  poi_transit_count: "交通服务点位数量",
};

const AREA_LABELS = {
  chunxi_core: "春熙路核心",
  ifs_core: "IFS",
  zongfu_road: "总府路沿线",
  taikoo_daci_merged: "太古里-大慈寺",
};

const ROAD_LABELS = {
  "Road network lines": "道路线段数",
  "Pedestrian ways": "步行线段数",
  Crossings: "过街设施数",
  "Subway entrances": "地铁入口数",
  "Subway stop positions": "地铁站点数",
  "Extraction date": "数据提取日期",
};

const MODEL_LABELS = {
  "Hybrid baseline": "当前主线方案",
  "Hybrid + log1p": "对数变换探索方案",
  Actual: "实际值",
  Hybrid: "融合方案",
  Transformer: "Transformer",
  Mamba: "Mamba",
};

const GATE_LABELS = {
  "Dynamic signal": "历史人流",
  "Video prior": "视频观测",
  "Social semantics": "社会感知",
  "Static context": "路网与地铁",
};

const SOCIAL_LABELS = {
  Posts: "帖子数",
  Comments: "评论数",
  "Mention Chunxi": "提及春熙路",
  "Mention Taikoo Li": "提及太古里",
};

const SCENARIO_LABELS = {
  A: "新增近距离地铁入口",
  B: "补强步行通道",
  C: "补充餐饮服务",
  D: "优化路网连接",
};

function publicProjectTitle() {
  return "春熙路 AI 城市规划顾问";
}

function publicProjectSubtitle() {
  return "结合手机信令、视频观测、路网地铁和社会感知结果，用通俗语言回答春熙路商圈的现状、问题与改进建议。";
}

function containsChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function publicModeLabel(value) {
  const raw = String(value || "");
  const normalized = raw.toLowerCase();
  if (!raw) return "AI 问答";
  if (normalized.includes("local")) return "本地模式";
  if (normalized.includes("web")) return "联网分析";
  if (normalized.includes("openai")) return "OpenAI";
  if (normalized.includes("qwen")) return "Qwen";
  if (normalized.includes("doubao")) return "豆包";
  return raw;
}

function publicFeatureLabel(value) {
  const raw = String(value || "");
  if (!raw) return "空间因素";
  return FEATURE_LABELS[raw] || (containsChineseText(raw) ? raw : raw.replace(/_/g, " "));
}

function publicAreaLabel(value) {
  const raw = String(value || "");
  if (!raw) return "研究片区";
  return AREA_LABELS[raw] || raw;
}

function publicClusterLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "未标注";
  if (containsChineseText(raw)) return raw;

  const descriptorMatch = raw.match(/^cluster_descriptor_(\d+)_(\d+)$/i);
  if (descriptorMatch) {
    return `复合画像簇（${descriptorMatch[1]}-${descriptorMatch[2]}）`;
  }

  if (/cluster/i.test(raw)) {
    const normalized = raw.replace(/cluster/gi, "").replace(/_/g, " ").trim();
    return normalized ? `复合画像簇（${normalized}）` : "复合画像簇";
  }

  return raw.replace(/_/g, " ");
}

function publicRoadLabel(value) {
  const raw = String(value || "");
  return ROAD_LABELS[raw] || raw;
}

function publicModelLabel(value) {
  const raw = String(value || "");
  return MODEL_LABELS[raw] || raw;
}

function publicGateLabel(value) {
  const raw = String(value || "");
  return GATE_LABELS[raw] || raw;
}

function publicSocialLabel(value) {
  const raw = String(value || "");
  return SOCIAL_LABELS[raw] || raw;
}

function publicScenarioLabel(value) {
  const raw = String(value || "");
  const normalized = raw.toLowerCase();
  if (!raw) return "未提供";
  if (SCENARIO_LABELS[raw]) return SCENARIO_LABELS[raw];
  if (normalized.includes("subway")) return "新增近距离地铁入口";
  if (normalized.includes("pedestrian")) return "补强步行通道";
  if (normalized.includes("food")) return "补充餐饮服务";
  if (normalized.includes("intersection")) return "优化路网连接";
  return containsChineseText(raw) ? raw : raw;
}

function publicDirectionLabel(value) {
  const raw = String(value || "");
  const normalized = raw.toLowerCase();
  if (!raw) return "重点关注";
  if (containsChineseText(raw)) return raw;
  if (normalized.includes("negative")) return "不宜继续机械增加";
  if (normalized.includes("positive")) return "仍有提升空间";
  if (normalized.includes("non")) return "需要分阶段优化";
  if (normalized.includes("flat")) return "边际收益有限";
  return raw;
}

function publicResidualMeaning(value) {
  const number = Number(value || 0);
  if (number > 0) return "需求高于当前空间承接表现";
  if (number < 0) return "空间利用不足或体验存在拖累";
  return "供需相对平衡";
}

function publicConfidenceLabel(value) {
  const raw = String(value || "");
  const normalized = raw.toLowerCase();
  if (!raw) return "未注明";
  if (containsChineseText(raw)) return raw;
  if (normalized.startsWith("high")) return "高";
  if (normalized.startsWith("medium")) return "中";
  if (normalized.startsWith("low")) return "低";
  return raw;
}

function sanitizePublicText(value) {
  let textValue = String(value || "");
  Object.entries(FEATURE_LABELS).forEach(([key, label]) => {
    textValue = textValue.replaceAll(key, label);
  });
  textValue = textValue
    .replace(/cluster_descriptor_(\d+)_(\d+)/gi, "复合画像簇（$1-$2）")
    .replace(/SHAP/gi, "结构化解释")
    .replace(/ALE/gi, "阈值分析")
    .replace(/residual/gi, "偏差")
    .replace(/zscore/gi, "相对位置")
    .replace(/percentile/gi, "分位")
    .replace(/grid_id/gi, "网格编号")
    .replace(/\.json/gi, "")
    .replace(/\.csv/gi, "");
  return textValue;
}

function formatCnDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).replace(/\//g, "-");
}

function hasUserConversation() {
  return state.chatMessages.some((message) => message.role === "user");
}

function syncChatLandingState() {
  const isChatView = state.activeView === "chat";
  const hasConversation = hasUserConversation();
  document.body.classList.toggle("chat-home", isChatView);
  document.body.classList.toggle("chat-landing", isChatView && !hasConversation);
  document.body.classList.toggle("chat-active", isChatView && hasConversation);
}

function buildPublicMetricCards() {
  const dashboard = state.dashboard || {};
  const signalSummary = dashboard.signal?.summary || {};
  const forecastSummary = dashboard.forecast?.summary || {};
  const values = dashboard.metrics || [];
  return [
    {
      label: "研究记录总量",
      value: values[0]?.value || "—",
      detail: "用于展示春熙路商圈整体变化的多源记录总量。",
    },
    {
      label: "稳定分析小时",
      value: values[1]?.value || "—",
      detail: `稳定窗口：${formatCnDateTime(signalSummary.modelWindowStart)} 至 ${formatCnDateTime(signalSummary.modelWindowEnd)}。`,
    },
    {
      label: "人流峰值时点",
      value: values[2]?.value || "—",
      detail: `稳定窗口内峰值约 ${formatNumber(signalSummary.peakSignalCount || 0)} 次信令。`,
    },
    {
      label: "当前主线误差",
      value: values[3]?.value || "—",
      detail: `当前主线方案的 WAPE 约 ${(forecastSummary.testWape || 0).toFixed(2)}%。`,
    },
    {
      label: "社会感知覆盖率",
      value: values[4]?.value || "—",
      detail: "可用于补充公众体验、口碑与片区感知的结构化线索。",
    },
    {
      label: "视频峰值时点",
      value: values[5]?.value || "—",
      detail: "视频观测更适合补充局部时段的人流热度和现场状态。",
    },
    {
      label: "路网覆盖网格",
      value: values[6]?.value || "—",
      detail: "含有效道路与步行环境特征的研究网格数量。",
    },
    {
      label: "社会感知对齐天数",
      value: values[7]?.value || "—",
      detail: "能够与人流变化做时间对照的社会感知日期数量。",
    },
  ];
}

function buildPublicFrameworkCards() {
  return [
    {
      subtitle: "研究范围",
      title: "统一研究底图",
      description: "所有结果都放在同一套 105 个研究网格里，方便把不同来源的信息放到一张图上理解。",
    },
    {
      subtitle: "多源观察",
      title: "人流与空间线索",
      description: "手机信令、视频观测、路网地铁和社会感知共同描述春熙路商圈的活力与体验差异。",
    },
    {
      subtitle: "应用展示",
      title: "预测与建议",
      description: "平台把关键结果整理成公众可读的图表、地图和问答，帮助快速判断哪里更值得优先改善。",
    },
  ];
}

function buildPublicDatasetCards() {
  const dashboard = state.dashboard || {};
  const signalSummary = dashboard.signal?.summary || {};
  const forecastSummary = dashboard.forecast?.summary || {};
  return [
    {
      role: "研究范围",
      name: "研究网格范围",
      description: "把春熙路商圈统一切分成 105 个研究网格，便于把不同来源的数据放到同一张图上。",
      metrics: [`${signalSummary.gridCount || 105} 个研究网格`, "4 个重点片区", "支持地图定位"],
    },
    {
      role: "综合底表",
      name: "多源特征总表",
      description: "汇总手机信令、视频、路网、地铁和社会感知结果，是当前前端展示的综合信息底座。",
      metrics: [
        dashboard.metrics?.[0]?.value ? `${dashboard.metrics[0].value} 行记录` : "多源记录",
        signalSummary.warehouseHourCount ? `${signalSummary.warehouseHourCount} 个小时` : "稳定时序",
        `社会感知覆盖率 ${dashboard.metrics?.[4]?.value || "—"}`,
      ],
    },
    {
      role: "主时空观察",
      name: "手机信令",
      description: "反映较长时间尺度的人流强弱变化，是理解春熙路商圈活力最稳定的基础。",
      metrics: [
        `${signalSummary.hourCount || 0} 个稳定小时`,
        `峰值 ${formatNumber(signalSummary.peakSignalCount || 0)} 次`,
        `${signalSummary.gridCount || 105} 个网格可比`,
      ],
    },
    {
      role: "现场补充",
      name: "视频观测",
      description: "补充局部时段的现场流动情况，帮助识别人流热区和短时拥挤。",
      metrics: [
        dashboard.video?.cameraBreakdown?.length ? `${dashboard.video.cameraBreakdown.length} 个相机视角` : "有限相机视角",
        dashboard.video?.fusedTimeline?.length ? `${dashboard.video.fusedTimeline.length} 个采样时点` : "有限观测时段",
        "适合局部热区对照",
      ],
    },
    {
      role: "预测结果",
      name: "人流预测结果",
      description: "汇总 Mamba / Transformer 等模型对下一时段人流的判断，用于比较不同方案的稳定性。",
      metrics: [
        forecastSummary.bestTestTotalMae ? `主线 MAE ${forecastSummary.bestTestTotalMae.toFixed(2)}` : "主线误差已记录",
        forecastSummary.testWape ? `WAPE ${forecastSummary.testWape.toFixed(2)}%` : "WAPE 已记录",
        dashboard.forecast?.modelComparison?.length ? `${dashboard.forecast.modelComparison.length} 种可比方案` : "可比方案",
      ],
    },
    {
      role: "空间解释",
      name: "路网与地铁",
      description: "用于解释哪些地方更好走、哪些位置因可达性不足更容易拖累人流表现。",
      metrics: [
        dashboard.metrics?.[6]?.value ? `${dashboard.metrics[6].value} 覆盖网格` : "路网覆盖已记录",
        "含步行通道与交叉口",
        "含地铁入口距离",
      ],
    },
  ];
}

function buildPublicPatternCards() {
  const dashboard = state.dashboard || {};
  const signalSummary = dashboard.signal?.summary || {};
  const topHotspots = dashboard.forecast?.hybridTopGrids || [];
  return [
    {
      label: "研究范围",
      title: "春熙路商圈已经统一到同一套研究网格",
      evidence: `当前所有主要结果都放在 ${signalSummary.gridCount || 105} 个研究网格里对照。`,
      implication: "不同数据来源终于能在同一张图上互相解释，便于直接做片区比较。",
    },
    {
      label: "人流变化",
      title: "手机信令仍是最稳定的人流主骨架",
      evidence: `稳定窗口覆盖 ${signalSummary.hourCount || 0} 个小时，峰值约 ${formatNumber(signalSummary.peakSignalCount || 0)} 次。`,
      implication: "判断春熙路整体活力时，仍应优先看长时间尺度的人流变化。",
    },
    {
      label: "视频补充",
      title: "视频更适合解释局部热区和短时拥挤",
      evidence: "视频覆盖时段有限，但能直观看到现场流动和热点位置。",
      implication: "在局部空间优化和现场观察上，视频仍有很高价值。",
    },
    {
      label: "公众体验",
      title: "社会感知能补充公众体验和片区口碑",
      evidence: `社会感知覆盖率约 ${dashboard.metrics?.[4]?.value || "—"}，可辅助判断哪里更受欢迎、哪里抱怨更多。`,
      implication: "它更适合作为定性佐证，而不是单独替代人流数据。",
    },
    {
      label: "空间条件",
      title: "路网与地铁是解释差异的重要底座",
      evidence: "道路、步行条件和地铁可达性在大多数网格都能提供稳定解释。",
      implication: "这也是后续提出规划建议时最容易落到具体设施层面的部分。",
    },
    {
      label: "预测判断",
      title: "当前主线预测仍以历史人流最稳",
      evidence: "主线方案目前仍是前端展示中最稳定的预测结果。",
      implication: "多源信息更像是帮助解释和微调，而不是完全替代人流主骨架。",
    },
    {
      label: "热点区域",
      title: "热点持续集中在核心消费带",
      evidence: topHotspots.length ? `${topHotspots[0].label.replace("Grid", "网格")} 等核心网格持续活跃。` : "热点长期集中在核心商业带。",
      implication: "无论是运营管理还是空间优化，核心消费带都值得持续优先关注。",
    },
  ];
}

function buildPublicSocialSamples() {
  const social = state.dashboard?.social || {};
  const themeCounts = social.themeCounts || [];
  const themeLookup = Object.fromEntries(themeCounts.map((item) => [item.label, item.count]));
  return [
    {
      label: "讨论热度",
      title: "春熙路相关讨论量整体较高",
      detail: `当前样本里约有 ${formatNumber(themeLookup.Posts || 0)} 条帖子、${formatNumber(themeLookup.Comments || 0)} 条评论，说明公众讨论活跃。`,
    },
    {
      label: "片区提及",
      title: "春熙路和太古里是最常被同时讨论的核心片区",
      detail: `提及春熙路约 ${formatNumber(themeLookup["Mention Chunxi"] || 0)} 次，提及太古里约 ${formatNumber(themeLookup["Mention Taikoo Li"] || 0)} 次。`,
    },
    {
      label: "辅助解释",
      title: "社会感知更适合补充体验感和口碑线索",
      detail: "它可以帮助解释为什么同样的人流强度下，不同片区的主观感受并不一样。",
    },
    {
      label: "使用边界",
      title: "当前社会感知更适合片区级判断",
      detail: "这一层更像公众体验的佐证，适合辅助判断，但不单独替代人流主结论。",
    },
  ];
}

function renderHeroFacts() {
  const container = document.getElementById("heroFacts");
  clear(container);
  buildPublicMetricCards().slice(0, 3).forEach((metric) => {
    const card = create("article", "hero-fact");
    card.append(create("strong", "", metric.value), create("span", "", metric.label));
    container.append(card);
  });
}

function renderMetrics() {
  const grid = document.getElementById("metricsGrid");
  clear(grid);
  buildPublicMetricCards().forEach((metric) => {
    const card = create("article", "metric-card");
    card.append(
      create("div", "metric-label", metric.label),
      create("div", "metric-value", metric.value),
      create("p", "metric-detail", metric.detail),
    );
    grid.append(card);
  });
}

function renderFramework() {
  const grid = document.getElementById("frameworkGrid");
  clear(grid);
  buildPublicFrameworkCards().forEach((pillar) => {
    const card = create("article", "framework-card");
    card.append(
      create("div", "eyebrow", pillar.subtitle),
      create("h3", "", pillar.title),
      create("p", "framework-subtitle", pillar.description),
    );
    grid.append(card);
  });
}

function renderDatasets() {
  const grid = document.getElementById("datasetsGrid");
  clear(grid);
  buildPublicDatasetCards().forEach((dataset) => {
    const card = create("article", "dataset-card");
    const metrics = create("div", "dataset-metrics");
    dataset.metrics.forEach((item) => metrics.append(create("span", "", item)));

    card.append(
      create("div", "dataset-role", dataset.role),
      create("h3", "", dataset.name),
      create("p", "dataset-description", dataset.description),
      metrics,
    );
    grid.append(card);
  });
}

function renderPatterns() {
  const grid = document.getElementById("patternsGrid");
  clear(grid);
  buildPublicPatternCards().forEach((pattern) => {
    const card = create("article", "pattern-card");
    card.append(
      create("div", "pattern-evidence-label", pattern.label),
      create("h3", "", pattern.title),
      create("p", "pattern-evidence", pattern.evidence),
      create("p", "pattern-copy", pattern.implication),
    );
    grid.append(card);
  });
}

function renderProviderOptions(providers) {
  fillProviderSelect(document.getElementById("providerSelect"), providers, state.selectedProvider);
  fillProviderSelect(document.getElementById("decisionProviderSelect"), providers, state.selectedDecisionProvider);
}

function fillProviderSelect(select, providers, selectedValue) {
  if (!select) return;
  clear(select);
  providers.forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.available
      ? `${provider.label} (${provider.model})`
      : `${provider.label} - 未配置`;
    if (provider.id === selectedValue) option.selected = true;
    select.append(option);
  });
}

function getProviderMeta(providerId = state.selectedProvider) {
  return state.dashboard.chatProviders.find((provider) => provider.id === providerId) || state.dashboard.chatProviders[0];
}

function updateProviderHint() {
  const provider = getProviderMeta();
  const node = document.getElementById("providerHint");
  if (!node) return;
  if (!provider) {
    node.textContent = "";
    return;
  }

  if (provider.id === "local") {
    node.textContent = "\u5f53\u524d\u4ec5\u4f7f\u7528\u672c\u5730\u7814\u7a76\u8bc1\u636e\uff0c\u4e0d\u8054\u7f51\u8865\u5145\u516c\u5f00\u4fe1\u606f\u3002";
    return;
  }

  if (!provider.available) {
    node.textContent = `${provider.label} \u5f53\u524d\u672a\u914d\u7f6e\uff0c\u63d0\u4ea4\u540e\u4f1a\u81ea\u52a8\u56de\u9000\u5230\u672c\u5730\u8bc1\u636e\u6a21\u5f0f\u3002`;
    return;
  }

  node.textContent = state.dashboard.webSearchConfigured
    ? `${provider.label} \u53ef\u7ed3\u5408\u672c\u5730\u7814\u7a76\u8bc1\u636e\u548c\u516c\u5f00\u4fe1\u606f\u56de\u7b54\u3002`
    : `${provider.label} \u53ef\u505a\u7efc\u5408\u5206\u6790\uff0c\u4f46\u5f53\u524d\u672a\u914d\u7f6e\u8054\u7f51\u641c\u7d22\u3002`;
}

function bindProviderSelect() {
  const select = document.getElementById("providerSelect");
  select.addEventListener("change", (event) => {
    state.selectedProvider = event.target.value;
    updateProviderHint();
  });

  const decisionSelect = document.getElementById("decisionProviderSelect");
  if (decisionSelect) {
    decisionSelect.addEventListener("change", async (event) => {
      state.selectedDecisionProvider = event.target.value;
      await loadDecisionRecommendation("cached");
    });
  }
}

function svgEl(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function renderLineChart(svg, series, options = {}) {
  clear(svg);
  const width = Number(svg.getAttribute("viewBox")?.split(" ")[2] || 720);
  const height = Number(svg.getAttribute("viewBox")?.split(" ")[3] || 320);
  const margin = { top: 24, right: 18, bottom: 42, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const group = svgEl("g", { transform: `translate(${margin.left},${margin.top})` });
  svg.append(group);

  const values = series.flatMap((entry) => entry.data.map((item) => Number(item.value)));
  const maxValue = Math.max(...values, 1);

  for (let i = 0; i <= 4; i += 1) {
    const y = (innerHeight / 4) * i;
    group.append(svgEl("line", { x1: 0, y1: y, x2: innerWidth, y2: y, stroke: colors.grid, "stroke-width": 1 }));
    const tickValue = maxValue - (maxValue / 4) * i;
    const label = svgEl("text", { x: -14, y: y + 4, fill: colors.muted, "font-size": 11, "text-anchor": "end" });
    label.textContent = shortNumber(Math.round(tickValue));
    group.append(label);
  }

  const pointCount = Math.max(...series.map((entry) => entry.data.length), 1);
  const xFor = (index) => (pointCount === 1 ? innerWidth / 2 : (index / (pointCount - 1)) * innerWidth);
  const yFor = (value) => innerHeight - (Number(value) / maxValue) * innerHeight;

  series.forEach((entry) => {
    const path = entry.data.map((item, index) => `${index === 0 ? "M" : "L"}${xFor(index)},${yFor(item.value)}`).join(" ");
    group.append(svgEl("path", { d: path, fill: "none", stroke: entry.color, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    const last = entry.data[entry.data.length - 1];
    if (last) {
      group.append(svgEl("circle", { cx: xFor(entry.data.length - 1), cy: yFor(last.value), r: 4.5, fill: entry.color }));
    }
  });

  const xTicks = options.xTicks || series[0]?.data || [];
  const step = Math.max(1, Math.floor(xTicks.length / 6));
  xTicks.forEach((item, index) => {
    if (index % step !== 0 && index !== xTicks.length - 1) return;
    const label = svgEl("text", { x: margin.left + xFor(index), y: height - 12, fill: colors.muted, "font-size": 11, "text-anchor": "middle" });
    label.textContent = item.label;
    svg.append(label);
  });

  const legend = svgEl("g", { transform: `translate(${margin.left},${height - 302})` });
  svg.append(legend);
  series.forEach((entry, index) => {
    const x = index * 156;
    legend.append(svgEl("line", { x1: x, y1: 0, x2: x + 18, y2: 0, stroke: entry.color, "stroke-width": 3 }));
    const text = svgEl("text", { x: x + 26, y: 4, fill: colors.muted, "font-size": 12 });
    text.textContent = entry.name;
    legend.append(text);
  });
}

function renderBarChart(svg, items) {
  clear(svg);
  const width = 720;
  const height = 320;
  const margin = { top: 18, right: 22, bottom: 18, left: 120 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...items.map((item) => Number(item.value)), 1);
  const barHeight = innerHeight / Math.max(items.length, 1);
  const group = svgEl("g", { transform: `translate(${margin.left},${margin.top})` });
  svg.append(group);

  items.forEach((item, index) => {
    const y = index * barHeight + 8;
    const widthValue = (Number(item.value) / maxValue) * (innerWidth - 10);
    group.append(svgEl("rect", { x: 0, y, width: widthValue, height: barHeight - 16, rx: 11, fill: item.color || colors.jade, opacity: 0.82 }));
    const label = svgEl("text", { x: -14, y: y + (barHeight - 16) / 2 + 4, fill: colors.ink, "font-size": 12, "text-anchor": "end" });
    label.textContent = item.label;
    group.append(label);
    const value = svgEl("text", { x: widthValue + 8, y: y + (barHeight - 16) / 2 + 4, fill: colors.muted, "font-size": 12 });
    value.textContent = item.display || shortNumber(item.value);
    group.append(value);
  });
}

function translateHotspotPeriod(period) {
  const raw = String(period || "").toLowerCase();
  if (!raw) return "重点时段";
  if (raw.includes("morning")) return "早间";
  if (raw.includes("noon")) return "午间";
  if (raw.includes("afternoon")) return "下午";
  if (raw.includes("evening")) return "傍晚";
  if (raw.includes("night")) return "夜间";
  if (raw.includes("late")) return "深夜";
  return containsChineseText(period) ? period : "重点时段";
}

function renderSignalChart(timeline) {
  const svg = document.getElementById("signalTimelineChart");
  const data = timeline.map((item) => ({
    label: new Date(item.hour_start).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit" }),
    value: item.signal_count,
  }));
  renderLineChart(svg, [{ name: "手机信令人流", color: colors.terracotta, data }]);
}

function renderHotspotChart(hotspots) {
  const svg = document.getElementById("hotspotChart");
  const items = hotspots.slice(0, 10).map((item, index) => ({
    label: `${item.grid_id} · ${translateHotspotPeriod(item.period)}`,
    value: item.total_signal,
    display: shortNumber(item.total_signal),
    color: index < 3 ? colors.amber : colors.jade,
  }));
  renderBarChart(svg, items);
}

function buildProjectedFusedTimeline(timeline) {
  const observed = (timeline || [])
    .map((item) => ({
      timestamp: new Date(item.event_minute),
      value: Number(item.detections),
    }))
    .filter((item) => !Number.isNaN(item.timestamp.getTime()) && Number.isFinite(item.value))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!observed.length) {
    return [];
  }

  const projected = [];

  for (let index = 0; index < observed.length - 1; index += 1) {
    const current = observed[index];
    const next = observed[index + 1];
    const gapMinutes = Math.round((next.timestamp - current.timestamp) / 60000);
    projected.push(current);

    if (gapMinutes > 1) {
      for (let step = 1; step < gapMinutes; step += 1) {
        const ratio = step / gapMinutes;
        projected.push({
          timestamp: new Date(current.timestamp.getTime() + step * 60_000),
          value: Math.round(current.value + (next.value - current.value) * ratio),
        });
      }
    }
  }

  projected.push(observed[observed.length - 1]);

  return projected.map((item) => ({
    label: item.timestamp.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    value: item.value,
  }));
}

function renderFusedVideoTimeline(timeline) {
  const svg = document.getElementById("fusedVideoTimelineChart");
  const data = buildProjectedFusedTimeline(timeline);
  renderLineChart(svg, [{ name: "视频观测人流", color: colors.jade, data }]);
}

function heatColor(t) {
  const hue = 36 - t * 24;
  const saturation = 78;
  const lightness = 92 - t * 42;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function renderFusedHeatmap(heatmap) {
  const svg = document.getElementById("fusedHeatmapChart");
  clear(svg);
  const width = 720;
  const height = 360;
  const margin = { top: 16, right: 18, bottom: 36, left: 18 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const group = svgEl("g", { transform: `translate(${margin.left},${margin.top})` });
  svg.append(group);

  const xBins = Number(heatmap.xBins || 1);
  const yBins = Number(heatmap.yBins || 1);
  const cellW = innerWidth / xBins;
  const cellH = innerHeight / yBins;
  const counts = heatmap.cells.map((cell) => Number(cell.count));
  const maxCount = Math.max(...counts, 1);

  group.append(svgEl("rect", { x: 0, y: 0, width: innerWidth, height: innerHeight, rx: 22, fill: "rgba(255,255,255,0.6)", stroke: colors.grid }));

  heatmap.cells.forEach((cell) => {
    const value = Number(cell.count);
    const ratio = value / maxCount;
    const x = Number(cell.x_bin) * cellW;
    const y = innerHeight - (Number(cell.y_bin) + 1) * cellH;
    group.append(svgEl("rect", {
      x: x + 1,
      y: y + 1,
      width: Math.max(0, cellW - 2),
      height: Math.max(0, cellH - 2),
      rx: 4,
      fill: heatColor(ratio),
      opacity: 0.96,
    }));
  });

  for (let i = 0; i <= xBins; i += 1) {
    const x = i * cellW;
    group.append(svgEl("line", { x1: x, y1: 0, x2: x, y2: innerHeight, stroke: "rgba(28,34,31,0.05)", "stroke-width": 1 }));
  }
  for (let i = 0; i <= yBins; i += 1) {
    const y = i * cellH;
    group.append(svgEl("line", { x1: 0, y1: y, x2: innerWidth, y2: y, stroke: "rgba(28,34,31,0.05)", "stroke-width": 1 }));
  }

  const legend = svgEl("g", { transform: `translate(${width - 200},${height - 24})` });
  svg.append(legend);
  [0, 0.25, 0.5, 0.75, 1].forEach((stop, index) => {
    legend.append(svgEl("rect", { x: index * 26, y: -14, width: 22, height: 10, rx: 4, fill: heatColor(stop) }));
  });
  const text = svgEl("text", { x: 0, y: 12, fill: colors.muted, "font-size": 11 });
  text.textContent = "低热度  →  高热度";
  legend.append(text);
}

function projectPoint(lon, lat, bbox, width = 1000, height = 700, pad = 42) {
  const x = pad + ((lon - bbox.min_lon) / (bbox.max_lon - bbox.min_lon)) * (width - pad * 2);
  const y = height - pad - ((lat - bbox.min_lat) / (bbox.max_lat - bbox.min_lat)) * (height - pad * 2);
  return [x, y];
}

function renderMap() {
  const svg = document.getElementById("spatialMap");
  clear(svg);
  const { dashboard } = state;
  const bbox = dashboard.road.bbox;
  const layers = {
    roads: svgEl("g", { "data-layer-group": "roads" }),
    pedestrian: svgEl("g", { "data-layer-group": "pedestrian" }),
    flows: svgEl("g", { "data-layer-group": "flows" }),
    hotspots: svgEl("g", { "data-layer-group": "hotspots" }),
    subway: svgEl("g", { "data-layer-group": "subway" }),
    cameras: svgEl("g", { "data-layer-group": "cameras" }),
  };

  dashboard.road.roadLines.forEach((line) => {
    const points = line.coords.map(([lon, lat]) => projectPoint(lon, lat, bbox).join(",")).join(" ");
    layers.roads.append(svgEl("polyline", { points, fill: "none", stroke: "rgba(28, 34, 31, 0.14)", "stroke-width": 1.4, "stroke-linecap": "round" }));
  });

  dashboard.road.pedestrianLines.forEach((line) => {
    const points = line.coords.map(([lon, lat]) => projectPoint(lon, lat, bbox).join(",")).join(" ");
    layers.pedestrian.append(svgEl("polyline", { points, fill: "none", stroke: "rgba(29, 121, 100, 0.7)", "stroke-width": 2.3, "stroke-linecap": "round" }));
  });

  dashboard.od.topCorridors.forEach((flow) => {
    const [x1, y1] = projectPoint(flow.origin_lng, flow.origin_lat, bbox);
    const [x2, y2] = projectPoint(flow.dest_lng, flow.dest_lat, bbox);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2 - 18;
    layers.flows.append(svgEl("path", { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, fill: "none", stroke: "rgba(191, 91, 67, 0.34)", "stroke-width": Math.max(1.6, flow.flow_count / 60000), "stroke-linecap": "round" }));
  });

  dashboard.signal.hotspots.forEach((spot, index) => {
    const [x, y] = projectPoint(spot.grid_center_lng, spot.grid_center_lat, bbox);
    const radius = 9 + index * 0.55;
    layers.hotspots.append(svgEl("circle", { cx: x, cy: y, r: radius, fill: "rgba(189, 124, 47, 0.15)" }));
    layers.hotspots.append(svgEl("circle", { cx: x, cy: y, r: 5.2, fill: colors.amber }));
  });

  dashboard.road.subwayEntrances.forEach((point) => {
    const [x, y] = projectPoint(point.lon, point.lat, bbox);
    layers.subway.append(svgEl("rect", { x: x - 4, y: y - 4, width: 8, height: 8, rx: 2, fill: colors.ink }));
  });

  dashboard.video.cameras.forEach((camera) => {
    const [x, y] = projectPoint(camera.lon, camera.lat, bbox);
    const heading = Number(camera.heading_deg || 0) - 90;
    const marker = svgEl("polygon", {
      points: "0,-8 6,6 -6,6",
      fill: colors.jade,
      transform: `translate(${x},${y}) rotate(${heading})`,
    });
    layers.cameras.append(marker);
  });

  Object.values(layers).forEach((group) => svg.append(group));
  applyLayerVisibility();
}

function renderSocialChart(themeCounts) {
  const svg = document.getElementById("socialChart");
  const items = themeCounts.map((item, index) => ({
    label: publicSocialLabel(item.label),
    value: item.count,
    display: `${formatNumber(item.count)} 条`,
    color: index % 2 === 0 ? colors.jade : colors.terracotta,
  }));
  renderBarChart(svg, items);
}

function renderSocialSamples() {
  const stack = document.getElementById("socialSamples");
  clear(stack);
  buildPublicSocialSamples().forEach((sample) => {
    const card = create("article", "sample-card");
    card.append(
      create("div", "dataset-role", sample.label),
      create("h3", "", sample.title),
      create("p", "", sample.detail),
    );
    stack.append(card);
  });
}

function renderStreetMetrics(summary) {
  const grid = document.getElementById("streetMetrics");
  clear(grid);
  const display = (value, suffix = "") => (value === null || value === undefined ? "暂无" : `${Number(value).toFixed(1)}${suffix}`);
  const items = [
    ["综合观感", display(summary.avgScore)],
    ["绿量占比", display(summary.avgGreen, "%")],
    ["建筑占比", display(summary.avgBuild, "%")],
    ["车行占比", display(summary.avgCar, "%")],
  ];
  items.forEach(([label, value]) => {
    const card = create("article", "street-card");
    card.append(create("strong", "", value), create("span", "", label));
    grid.append(card);
  });
}

function renderRoadSummary(summary) {
  const container = document.getElementById("roadSummary");
  clear(container);
  const rows = Array.isArray(summary.summaryRows) && summary.summaryRows.length
    ? summary.summaryRows.map((item) => [publicRoadLabel(item.label), item.value])
    : [
        ["道路线段数", summary.layer_counts.road_network],
        ["步行线段数", summary.layer_counts.pedestrian_ways],
        ["过街设施数", summary.layer_counts.crossings],
        ["地铁入口数", summary.layer_counts.subway_entrances],
        ["地铁站点数", summary.layer_counts.subway_stop_positions],
        ["数据提取日期", summary.extraction_date],
      ];
  rows.forEach(([label, value]) => {
    const row = create("div", "road-row");
    row.append(create("span", "", label), create("strong", "", String(value)));
    container.append(row);
  });
}

function renderForecastComparison(rows) {
  const svg = document.getElementById("forecastComparisonChart");
  const items = [...rows]
    .sort((a, b) => Number(a.test_total_mae) - Number(b.test_total_mae))
    .map((row) => ({
      label: publicModelLabel(row.label),
      value: row.test_total_mae,
      display: shortNumber(Math.round(row.test_total_mae * 100) / 100),
      color: row.color,
    }));
  renderBarChart(svg, items);

  const best = items[0];
  const summary = state.dashboard.forecast.summary || {};
  const comparisonCount = state.dashboard.forecast.modelComparison?.length || 0;
  document.getElementById("forecastBestNote").textContent = best
    ? `当前展示的 ${comparisonCount} 种方案里，${best.label} 的测试误差最低，适合作为前端默认的人流预测结果。`
    : "当前暂无可展示的模型对比结果。";
  if (best && summary.bestTestTotalMae) {
    document.getElementById("forecastBestNote").textContent += ` 当前主线 MAE 约为 ${summary.bestTestTotalMae.toFixed(2)}。`;
  }
}

function renderForecastTimeline(timeline, summary) {
  const svg = document.getElementById("forecastTimelineChart");
  if (timeline && timeline.kind === "epoch_validation") {
    const series = (timeline.series || []).map((item) => ({
      name: publicModelLabel(item.name),
      color: item.color,
      data: (item.points || []).map((point) => ({ label: point.label, value: point.value })),
    }));
    renderLineChart(svg, series);
    const start = formatCnDateTime(summary.testWindowStart);
    const end = formatCnDateTime(summary.testWindowEnd);
    document.getElementById("forecastRangeNote").textContent = `这张图展示同一稳定时间窗口下，不同方案的验证误差变化。测试时段：${start} 至 ${end}。`;
    return;
  }

  const data = timeline.map((item) => ({
    label: new Date(item.target_time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit" }),
    actual: item.actual_signal,
    hybrid: item.hybrid_pred_signal,
    transformer: item.transformer_only_pred_signal,
    mamba: item.mamba_only_pred_signal,
  }));

  renderLineChart(svg, [
    { name: "实际值", color: colors.ink, data: data.map((item) => ({ label: item.label, value: item.actual })) },
    { name: "融合方案", color: colors.terracotta, data: data.map((item) => ({ label: item.label, value: item.hybrid })) },
    { name: "Transformer", color: colors.jade, data: data.map((item) => ({ label: item.label, value: item.transformer })) },
    { name: "Mamba", color: colors.amber, data: data.map((item) => ({ label: item.label, value: item.mamba })) },
  ]);

  const start = formatCnDateTime(summary.testWindowStart);
  const end = formatCnDateTime(summary.testWindowEnd);
  const peak = formatCnDateTime(summary.hybridPeakPredTime);
  document.getElementById("forecastRangeNote").textContent = `这里对比测试时段内的实际人流与预测人流。测试时段：${start} 至 ${end}；融合方案的预测峰值大约出现在 ${peak}。`;
}

function renderForecastGates(gates) {
  const svg = document.getElementById("forecastGateChart");
  const items = gates.map((item) => ({
    label: publicGateLabel(item.label),
    value: item.value,
    display: `${Number(item.value).toFixed(1)}%`,
    color: item.color,
  }));
  renderBarChart(svg, items);
}

function renderForecastSummary(cards) {
  const container = document.getElementById("forecastSummaryCards");
  clear(container);
  const labelMap = {
    "Accepted run": "当前主线方案",
    "Test MAE": "测试 MAE",
    "Test WAPE": "测试 WAPE",
    "Model-ready hours": "稳定分析小时",
    "Comparable variants": "可比方案数",
  };
  cards.forEach((card) => {
    const chip = create("article", "camera-chip");
    chip.append(
      create("div", "metric-label", labelMap[card.label] || card.label),
      create("strong", "", sanitizePublicText(card.value)),
      create("span", "", sanitizePublicText(card.detail)),
    );
    container.append(chip);
  });
}

function renderForecastHighlights() {
  const container = document.getElementById("forecastHighlights");
  clear(container);
  const summary = state.dashboard.forecast.summary || {};
  const gates = state.dashboard.forecast.hybridGateWeights || [];
  const signalGate = gates.find((item) => item.label === "Dynamic signal")?.value || 0;
  const videoGate = gates.find((item) => item.label === "Video prior")?.value || 0;
  const socialGate = gates.find((item) => item.label === "Social semantics")?.value || 0;
  const staticGate = gates.find((item) => item.label === "Static context")?.value || 0;
  [
    {
      title: "历史人流仍是当前最稳的判断依据",
      detail: `主线方案里，历史人流权重约 ${signalGate.toFixed(1)}%，高于视频 ${videoGate.toFixed(1)}%、社会感知 ${socialGate.toFixed(1)}% 和路网地铁 ${staticGate.toFixed(1)}%。`,
    },
    {
      title: "误差更高的片区值得重点关注",
      detail: summary.hybridWorstHour ? `当前较难预测的时段出现在 ${summary.hybridWorstHour}:00 附近，说明局部空间的波动更复杂。` : "部分片区和时段波动仍较大。",
    },
    {
      title: "傍晚到晚间通常更难预测",
      detail: `当前最难时段约在 ${summary.hybridWorstHour || "16"}:00，最稳定时段约在 ${summary.hybridBestHour || "04"}:00。`,
    },
    {
      title: "当前主线方案仍是默认展示结果",
      detail: `目前主线方案的测试 MAE 约 ${summary.bestTestTotalMae?.toFixed(2) || "—"}，暂时仍优于探索性变体。`,
    },
  ].forEach((item) => {
    const card = create("article", "sample-card");
    card.append(
      create("div", "sample-tag", "结果解读"),
      create("h3", "", item.title),
      create("p", "", item.detail),
    );
    container.append(card);
  });
}

function renderForecastTopGrids(topGrids, errorGrids) {
  const container = document.getElementById("forecastTopGrids");
  clear(container);

  const cards = [...(topGrids || []), ...(errorGrids || [])];
  cards.forEach((item, index) => {
    const card = create("article", "sample-card");
    const isTopGrid = index < (topGrids || []).length;
    const observedMatch = /([\d,.]+) observed signals.*Zone ([A-Z])/i.exec(item.description || "");
    const errorMatch = /Test MAE ([\d.]+).*WAPE ([\d.]+)%/i.exec(item.description || "");
    let description = "值得重点关注的研究网格。";
    if (observedMatch) {
      description = `该网格在稳定窗口内累计约 ${observedMatch[1]} 次观测信号，属于 ${observedMatch[2]} 区的重要热点。`;
    } else if (errorMatch) {
      description = `${item.label.replace(/^Zone\s*/i, "")} 区的测试 MAE 约 ${errorMatch[1]}，WAPE 约 ${errorMatch[2]}%，说明这里的人流波动更复杂。`;
    } else if (item.description) {
      description = sanitizePublicText(item.description)
        .replace(/Within the accepted test window,\s*/i, "")
        .replace(/Grid/gi, "网格")
        .replace(/Zone/gi, "片区");
    }

    card.append(
      create("div", "sample-tag", isTopGrid ? "热点网格" : "重点关注片区"),
      create("h3", "", item.label.replace(/^Grid\s*/i, "网格 ").replace(/^Zone\s*/i, "片区 ")),
      create("p", "", description),
    );
    container.append(card);
  });
}

function renderPromptChips() {
  const container = document.getElementById("promptChips");
  clear(container);
  PUBLIC_STARTER_PROMPTS.forEach((prompt) => {
    const button = create("button", "prompt-chip", prompt);
    button.type = "button";
    button.addEventListener("click", () => sendQuestion(prompt));
    container.append(button);
  });
}

function renderVideoLabels() {
  const observedCount = state.dashboard.video.fusedTimeline?.length || 0;
  const projectedCount = buildProjectedFusedTimeline(state.dashboard.video.fusedTimeline).length;
  const note = ["视频观测目前主要用于补充局部时段的人流节奏与热区。"];
  if (projectedCount > observedCount) {
    note.push("为了便于阅读，图中会把相邻采样时段做平滑连接，而不是把中间空档直接显示为 0。");
  }
  document.getElementById("videoLabelNote").textContent = note.join("");
}

function renderCameraBreakdown(rows) {
  const container = document.getElementById("cameraBreakdown");
  clear(container);
  rows.forEach((row) => {
    const chip = create("div", "camera-chip");
    chip.append(
      create("span", "dataset-role", `${row.camera} 视角`),
      create("strong", "", `${shortNumber(row.unique_tracks)} 条轨迹`),
      create("span", "", `约占融合轨迹的 ${Number(row.track_share_pct).toFixed(1)}%`),
    );
    container.append(chip);
  });
}

function bindLayerControls() {
  document.querySelectorAll("[data-layer]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const layer = event.target.getAttribute("data-layer");
      state.layers[layer] = event.target.checked;
      applyLayerVisibility();
    });
  });
}

function applyLayerVisibility() {
  document.querySelectorAll("[data-layer-group]").forEach((group) => {
    const name = group.getAttribute("data-layer-group");
    group.style.display = state.layers[name] ? "block" : "none";
  });
}

function bindChat() {
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  let isComposing = false;

  const submitQuestion = async () => {
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    await sendQuestion(question);
    input.focus();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isComposing) return;
    await submitQuestion();
  });

  input.addEventListener("compositionstart", () => {
    isComposing = true;
  });

  input.addEventListener("compositionend", () => {
    isComposing = false;
  });

  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.isComposing || isComposing) return;
    event.preventDefault();
    await submitQuestion();
  });

  const mapButton = document.getElementById("chatOpenMapButton");
  if (mapButton) {
    mapButton.addEventListener("click", () => {
      focusChatMapResult();
    });
  }
}

function seedChat() {
  state.chatMessages = [
    {
      role: "assistant",
      body: "你好，我是春熙路 AI 城市规划顾问。你可以直接问我春熙路、IFS、太古里或总府路一带哪里拥堵、哪里更适合优先改善。",
      sources: [],
      evidenceSummary: [],
      webSources: [],
      notice: "",
      resolvedEntities: [],
      mapFocus: null,
    },
  ];
  renderChatThread();
  renderChatContextBar();
  syncChatLandingState();
}

async function sendQuestion(question) {
  state.chatMessages.push({ role: "user", body: question, sources: [], evidenceSummary: [], webSources: [], notice: "", resolvedEntities: [], mapFocus: null });
  renderChatThread();
  syncChatLandingState();
  state.chatMessages.push({
    role: "assistant",
    body: "正在整理春熙路相关证据，请稍等……",
    sources: [],
    evidenceSummary: [],
    webSources: [],
    notice: "",
    resolvedEntities: [],
    mapFocus: null,
  });
  renderChatThread();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        provider: state.selectedProvider,
        role: (document.getElementById("roleSelect") || {}).value || "planner",
        messages: state.chatMessages.slice(-8),
      }),
    });
    const payload = await response.json();
    state.chatMessages[state.chatMessages.length - 1] = {
      role: "assistant",
      body: payload.answer,
      sources: payload.evidenceSummary || [],
      evidenceSummary: payload.evidenceSummary || [],
      webSources: payload.webSources || [],
      notice: payload.notice || "",
      resolvedEntities: payload.resolvedEntities || [],
      mapFocus: payload.mapFocus || null,
    };
    state.chatResolvedEntities = payload.resolvedEntities || [];
    state.chatMapFocus = payload.mapFocus || null;
    document.getElementById("chatModeBadge").textContent = publicModeLabel(payload.mode || getProviderMeta()?.label || state.dashboard.chatProvider);
    renderChatThread();
    renderChatContextBar();
  } catch (error) {
    state.chatMessages[state.chatMessages.length - 1] = {
      role: "assistant",
      body: `问答请求失败：${error.message}`,
      sources: [],
      evidenceSummary: [],
      webSources: [],
      notice: "",
      resolvedEntities: [],
      mapFocus: null,
    };
    state.chatResolvedEntities = [];
    state.chatMapFocus = null;
    renderChatThread();
    renderChatContextBar();
  }
}

function renderChatContextBar() {
  const bar = document.getElementById("chatContextBar");
  const summary = document.getElementById("chatContextSummary");
  const button = document.getElementById("chatOpenMapButton");
  if (!bar || !summary || !button) return;

  if (!state.chatResolvedEntities.length && !state.chatMapFocus) {
    bar.hidden = true;
    summary.textContent = "";
    button.disabled = true;
    return;
  }

  const labels = state.chatResolvedEntities.map((item) => item.label);
  const parts = [];
  if (labels.length) {
    parts.push(`已定位到：${labels.join(" / ")}`);
  }
  if (state.chatMapFocus?.gridIds?.length) {
    parts.push(`${state.chatMapFocus.gridIds.length} 个研究网格`);
  }
  summary.textContent = parts.join(" · ");
  bar.hidden = false;
  button.disabled = !state.chatMapFocus;
}

function focusChatMapResult() {
  if (!state.chatMapFocus) return;
  if (state.chatMapFocus.areaId) {
    state.decisionAreaFilter = state.chatMapFocus.areaId;
  } else {
    state.decisionAreaFilter = "all";
  }

  if (state.chatMapFocus.gridIds?.length === 1) {
    setSelectedDecisionEntity("grid", state.chatMapFocus.gridIds[0]);
  } else if (state.chatMapFocus.areaId) {
    setSelectedDecisionEntity("area", state.chatMapFocus.areaId);
  } else if (state.chatMapFocus.gridIds?.length) {
    setSelectedDecisionEntity("grid", state.chatMapFocus.gridIds[0]);
  }

  setActiveView("decision");
}

function renderChatThread() {
  const thread = document.getElementById("chatThread");
  clear(thread);
  state.chatMessages.forEach((message) => {
    const node = create("article", `message ${message.role}`);
    node.append(create("div", "message-role", message.role === "user" ? "你" : "AI 顾问"));
    const body = create("div", "message-body");
    body.textContent = message.body;
    node.append(body);

    if (message.notice) {
      node.append(create("div", "message-note", message.notice));
    }

    const hasEvidence = (message.evidenceSummary && message.evidenceSummary.length) || (message.webSources && message.webSources.length);
    if (hasEvidence) {
      const details = document.createElement("details");
      details.className = "message-evidence";
      const summary = document.createElement("summary");
      summary.textContent = "查看依据";
      details.append(summary);
      const bodyWrap = create("div", "message-evidence-body");

      if (message.evidenceSummary && message.evidenceSummary.length) {
        const evidenceLabel = create("div", "message-evidence-label", "本地证据");
        bodyWrap.append(evidenceLabel);
        const tags = create("div", "message-sources");
        message.evidenceSummary.forEach((item) => tags.append(create("span", "", sanitizePublicText(item))));
        bodyWrap.append(tags);
      }

      if (message.webSources && message.webSources.length) {
        const webLabel = create("div", "message-evidence-label", "公开信息");
        bodyWrap.append(webLabel);
        const list = create("div", "message-web-links");
        message.webSources.forEach((item) => {
          const link = document.createElement("a");
          link.href = item.url;
          link.target = "_blank";
          link.rel = "noreferrer noopener";
          link.textContent = item.date ? `${sanitizePublicText(item.title)} (${item.date})` : sanitizePublicText(item.title);
          list.append(link);
        });
        bodyWrap.append(list);
      }

      details.append(bodyWrap);
      node.append(details);
    }

    thread.append(node);
  });
  thread.scrollTop = thread.scrollHeight;
  syncChatLandingState();
}

function chooseInitialDecisionGrid() {
  const cards = Object.values(state.decisionSupport?.grid_cards || {});
  if (!cards.length) return null;
  cards.sort((a, b) => Math.abs(Number(b.residual_mean || 0)) - Math.abs(Number(a.residual_mean || 0)));
  return cards[0]?.grid_id || null;
}

function getSelectedDecisionCard() {
  if (!state.decisionSupport || !state.selectedEntityId) return null;
  if (state.selectedEntityType === "area") {
    return state.decisionSupport.area_cards?.[state.selectedEntityId] || null;
  }
  return state.decisionSupport.grid_cards?.[state.selectedEntityId] || null;
}

function getDecisionProviderMeta(providerId = state.selectedDecisionProvider) {
  return state.dashboard?.chatProviders?.find((provider) => provider.id === providerId) || null;
}

function bindDecisionWorkspace() {
  const searchButton = document.getElementById("decisionSearchButton");
  const searchInput = document.getElementById("decisionGridSearch");
  const cachedButton = document.getElementById("decisionCachedButton");
  const refreshButton = document.getElementById("decisionRefreshButton");

  if (searchButton && searchInput) {
    const runSearch = () => {
      const value = searchInput.value.trim();
      if (!value) return;
      const card = state.decisionSupport?.grid_cards?.[value];
      if (!card) {
        searchInput.setCustomValidity("未找到该网格编号");
        searchInput.reportValidity();
        return;
      }
      searchInput.setCustomValidity("");
      state.decisionAreaFilter = "all";
      setSelectedDecisionEntity("grid", value);
    };
    searchButton.addEventListener("click", runSearch);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
  }

  if (cachedButton) {
    cachedButton.addEventListener("click", async () => {
      await loadDecisionRecommendation("cached");
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      await loadDecisionRecommendation("refresh");
    });
  }
}

function setSelectedDecisionEntity(entityType, entityId, options = {}) {
  const { fetchRecommendation = true } = options;
  state.selectedEntityType = entityType;
  state.selectedEntityId = entityId;
  state.decisionRecommendation = null;
  state.decisionRecommendationNotice = "";
  state.decisionMapShouldFocus = true;
  renderDecisionWorkspace();
  if (fetchRecommendation) {
    loadDecisionRecommendation("cached").catch((error) => {
      state.decisionRecommendationNotice = error.message;
      renderDecisionWorkspace();
    });
  }
}

async function loadDecisionRecommendation(mode = "cached") {
  if (!state.selectedEntityId) return;
  const response = await fetch("/api/decision/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entityType: state.selectedEntityType,
      entityId: state.selectedEntityId,
      provider: state.selectedDecisionProvider,
      mode,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "无法加载结构化建议。");
  }
  state.decisionRecommendation = payload.recommendation;
  state.decisionRecommendationProvider = payload.provider;
  state.decisionRecommendationFromCache = Boolean(payload.fromCache);
  state.decisionRecommendationNotice = payload.notice || "";
  renderDecisionWorkspace();
}

function decisionEntityLabel(card) {
  if (!card) return "规划依据总览";
  if (state.selectedEntityType === "area") {
    return publicAreaLabel(card.label || card.area_id);
  }
  return `网格 ${card.grid_id}`;
}

function renderDecisionWorkspace() {
  if (!state.decisionSupport) return;
  renderDecisionAreaFilters();
  if (state.activeView === "decision") {
    renderDecisionMap();
  }
  renderDecisionDiagnosis();
  renderDecisionRecommendationPanel();
  renderDecisionEvidence();
  renderDecisionAreaCards();
}

function renderDecisionAreaFilters() {
  const container = document.getElementById("decisionAreaFilters");
  if (!container) return;
  clear(container);

  const chips = [{ id: "all", label: "全部网格" }, ...Object.values(state.decisionSupport.area_cards || {}).map((card) => ({ id: card.area_id, label: publicAreaLabel(card.label || card.area_id) }))];
  chips.forEach((chip) => {
    const button = create("button", `prompt-chip${state.decisionAreaFilter === chip.id ? " active-chip" : ""}`, chip.label);
    button.type = "button";
    button.addEventListener("click", () => {
      state.decisionAreaFilter = chip.id;
      state.decisionMapShouldFocus = true;
      renderDecisionWorkspace();
    });
    container.append(button);
  });
}

function interpolateHex(start, end, factor) {
  const clamp = Math.max(0, Math.min(1, factor));
  const a = start.match(/.{1,2}/g).map((item) => Number.parseInt(item, 16));
  const b = end.match(/.{1,2}/g).map((item) => Number.parseInt(item, 16));
  const mixed = a.map((value, index) => Math.round(value + (b[index] - value) * clamp));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function residualColor(value, maxAbs) {
  const scale = Math.max(maxAbs || 1, 1);
  const ratio = Math.min(Math.abs(Number(value || 0)) / scale, 1);
  if (value > 0) return interpolateHex("f5dcc0", "bf5b43", ratio);
  if (value < 0) return interpolateHex("d8ede8", "1d7964", ratio);
  return "#ebe3d6";
}

function isGridHighlighted(card) {
  if (!card) return false;
  if (state.selectedEntityType === "grid") {
    return state.selectedEntityId === card.grid_id;
  }
  const selectedArea = state.decisionSupport?.area_cards?.[state.selectedEntityId];
  return Boolean(selectedArea?.grid_ids?.includes(card.grid_id));
}

function decisionCardLatLngBounds(card) {
  return [
    [Number(card.bounds.south), Number(card.bounds.west)],
    [Number(card.bounds.north), Number(card.bounds.east)],
  ];
}

function buildDecisionLatLngBounds(cards) {
  if (!window.L || !cards.length) return null;
  const points = cards.flatMap((card) => [
    [Number(card.bounds.south), Number(card.bounds.west)],
    [Number(card.bounds.north), Number(card.bounds.east)],
  ]);
  return window.L.latLngBounds(points);
}

function ensureDecisionLeafletMap(container) {
  if (!window.L) return null;
  if (state.decisionLeaflet?.map) {
    state.decisionLeaflet.map.invalidateSize(false);
    return state.decisionLeaflet;
  }

  const map = window.L.map(container, {
    zoomControl: true,
    preferCanvas: true,
    attributionControl: true,
  });

  map.createPane("decisionGridBase");
  map.getPane("decisionGridBase").style.zIndex = 150;
  map.createPane("decisionStudyExtent");
  map.getPane("decisionStudyExtent").style.zIndex = 360;
  map.createPane("decisionGridHit");
  map.getPane("decisionGridHit").style.zIndex = 420;
  map.getPane("tilePane").style.zIndex = 260;
  map.getPane("tilePane").style.opacity = "0.68";
  map.getPane("tilePane").style.filter = "saturate(0.8) contrast(0.94)";
  map.getPane("tilePane").style.mixBlendMode = "multiply";

  const tileLayer = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
    opacity: 1,
  }).addTo(map);

  const gridBaseLayer = window.L.layerGroup().addTo(map);
  const extentLayer = window.L.layerGroup().addTo(map);
  const gridHitLayer = window.L.layerGroup().addTo(map);
  state.decisionLeaflet = {
    map,
    tileLayer,
    gridBaseLayer,
    extentLayer,
    gridHitLayer,
    initialized: false,
  };
  return state.decisionLeaflet;
}

function focusDecisionMap(cards) {
  if (!window.L || !state.decisionLeaflet?.map || !cards.length) return;
  const bounds = buildDecisionLatLngBounds(cards);
  if (!bounds || !bounds.isValid()) return;
  state.decisionLeaflet.map.fitBounds(bounds.pad(0.12), { animate: false });
}

function renderDecisionMap() {
  const container = document.getElementById("decisionMap");
  const legend = document.getElementById("decisionMapLegend");
  if (!container || !state.decisionSupport) return;

  if (!window.L) {
    container.innerHTML = '<div class="inline-note">Leaflet 底图加载失败，请刷新页面或检查网络连接。</div>';
    return;
  }

  const mapState = ensureDecisionLeafletMap(container);
  if (!mapState) return;

  const cards = Object.values(state.decisionSupport.grid_cards || {});
  const residualMax = Math.max(...cards.map((card) => Math.abs(Number(card.residual_mean || 0))), 1);
  const activeFilterGridIds = state.decisionAreaFilter === "all"
    ? null
    : new Set(state.decisionSupport.area_cards?.[state.decisionAreaFilter]?.grid_ids || []);

  mapState.gridBaseLayer.clearLayers();
  mapState.extentLayer.clearLayers();
  mapState.gridHitLayer.clearLayers();

  const visibleCards = [];
  let selectedLayer = null;
  cards.forEach((card) => {
    const inFilter = !activeFilterGridIds || activeFilterGridIds.has(card.grid_id);
    if (inFilter) {
      visibleCards.push(card);
    }
    const baseLayer = window.L.rectangle(decisionCardLatLngBounds(card), {
      pane: "decisionGridBase",
      color: "rgba(28,34,31,0.34)",
      weight: 1.2,
      fillColor: residualColor(card.residual_mean, residualMax),
      fillOpacity: inFilter ? 0.9 : 0.2,
      interactive: false,
    });
    baseLayer.addTo(mapState.gridBaseLayer);

    const layer = window.L.rectangle(decisionCardLatLngBounds(card), {
      pane: "decisionGridHit",
      color: isGridHighlighted(card) ? colors.ink : "rgba(28,34,31,0.0)",
      weight: isGridHighlighted(card) ? 2.4 : 0,
      fillColor: residualColor(card.residual_mean, residualMax),
      fillOpacity: inFilter ? 0.02 : 0.01,
      interactive: true,
    });
    layer.bindTooltip(
      `${card.grid_id}<br/>供需偏差 ${Number(card.residual_mean).toFixed(1)}<br/>${publicClusterLabel(card.cluster_label || "未标注画像")}`,
      { sticky: true, direction: "top" },
    );
    layer.on("click", () => setSelectedDecisionEntity("grid", card.grid_id));
    layer.addTo(mapState.gridHitLayer);
    if (isGridHighlighted(card)) {
      selectedLayer = layer;
    }
  });

  const extentCards = visibleCards.length ? visibleCards : cards;
  const extentBounds = buildDecisionLatLngBounds(extentCards);
  if (extentBounds?.isValid()) {
    window.L.rectangle(extentBounds, {
      pane: "decisionStudyExtent",
      color: "rgba(28,34,31,0.86)",
      weight: 2.2,
      dashArray: "10 8",
      fillOpacity: 0,
      interactive: false,
    }).addTo(mapState.extentLayer);
  }

  if (!mapState.initialized) {
    focusDecisionMap(visibleCards.length ? visibleCards : cards);
    mapState.initialized = true;
    state.decisionMapShouldFocus = false;
  } else if (state.decisionMapShouldFocus) {
    if (state.selectedEntityType === "grid" && state.selectedEntityId) {
      const card = state.decisionSupport.grid_cards?.[state.selectedEntityId];
      if (card) {
        state.decisionLeaflet.map.fitBounds(buildDecisionLatLngBounds([card]).pad(0.6), { animate: true });
      }
    } else if (state.selectedEntityType === "area" && state.selectedEntityId) {
      const area = state.decisionSupport.area_cards?.[state.selectedEntityId];
      const areaCards = (area?.grid_ids || []).map((gridId) => state.decisionSupport.grid_cards?.[gridId]).filter(Boolean);
      focusDecisionMap(areaCards);
    } else {
      focusDecisionMap(visibleCards.length ? visibleCards : cards);
    }
    state.decisionMapShouldFocus = false;
  } else {
    state.decisionLeaflet.map.invalidateSize(false);
  }

  if (selectedLayer) {
    selectedLayer.bringToFront();
  }

  if (legend) {
    const selected = getSelectedDecisionCard();
    legend.textContent = `底层彩色网格表示 105 个研究网格，上方半透明 2D 城市底图用于对应真实街区。冷色表示空间利用偏弱或体验拖累更明显，暖色表示需求更旺、现有承接压力更大。当前选中：${decisionEntityLabel(selected)}。`;
  }
}

function appendKeyValueRows(container, rows) {
  rows.forEach(([label, value]) => {
    const row = create("div", "road-row");
    row.append(create("span", "", label), create("strong", "", value));
    container.append(row);
  });
}

function renderDecisionDiagnosis() {
  const title = document.getElementById("decisionSelectionTitle");
  const container = document.getElementById("decisionDiagnosis");
  if (!container) return;
  clear(container);
  const card = getSelectedDecisionCard();
  if (!card) return;
  if (title) title.textContent = decisionEntityLabel(card);

  const summary = create("div", "road-summary");
  if (state.selectedEntityType === "grid") {
    appendKeyValueRows(summary, [
      ["需求画像", publicClusterLabel(card.cluster_label || "未标注")],
      ["平均供需偏差", Number(card.residual_mean || 0).toFixed(1)],
      ["实际均值", Number(card.actual_mean || 0).toFixed(1)],
      ["预测均值", Number(card.predicted_mean || 0).toFixed(1)],
      ["所属片区", card.area_candidates?.length ? card.area_candidates.map(publicAreaLabel).join("、") : publicAreaLabel(card.zone || "研究范围")],
    ]);
  } else {
    appendKeyValueRows(summary, [
      ["主导画像", publicClusterLabel(card.dominant_clusters?.[0]?.cluster_label || "未标注")],
      ["平均供需偏差", Number(card.residual_summary?.residual_mean || 0).toFixed(1)],
      ["网格数量", String(card.grid_ids?.length || 0)],
      ["偏高网格", String(card.residual_summary?.positive_grid_count || 0)],
      ["偏低网格", String(card.residual_summary?.negative_grid_count || 0)],
    ]);
  }
  container.append(summary);

  const top3 = create("div", "camera-breakdown");
  const topFeatures = state.selectedEntityType === "grid" ? (card.shap_top3 || []) : (card.top_actionable_features || []);
  topFeatures.slice(0, 3).forEach((item) => {
    const chip = create("article", "camera-chip");
    chip.append(
      create("span", "dataset-role", publicFeatureLabel(item.feature || item.label)),
      create("strong", "", state.selectedEntityType === "grid" ? "重点因素" : "优先方向"),
      create("span", "", publicDirectionLabel(item.direction)),
    );
    top3.append(chip);
  });
  if (topFeatures.length) {
    container.append(create("div", "dataset-role", state.selectedEntityType === "grid" ? "主要影响因素" : "优先改善方向"));
    container.append(top3);
  }

  const social = state.selectedEntityType === "grid" ? card.social_perception : card.social_summary;
  if (social) {
    const socialBox = create("article", "sample-card");
    socialBox.append(
      create("div", "sample-tag", "社会感知佐证"),
      create("h3", "", publicAreaLabel(sanitizePublicText(social.label || "片区感知摘要"))),
      create("p", "", `正向率 ${((social.positive_rate || 0) * 100).toFixed(1)}%，负向率 ${((social.negative_rate || 0) * 100).toFixed(1)}%，帖子数 ${social.post_count || 0}。`),
      create("p", "", social.top_signal ? `高频感知信号：${sanitizePublicText(social.top_signal)}` : "当前没有特别突出的高频感知信号。"),
    );
    container.append(socialBox);
  }
}

function renderDecisionRecommendationPanel() {
  const container = document.getElementById("decisionRecommendation");
  const meta = document.getElementById("decisionRecommendationMeta");
  if (!container || !meta) return;
  clear(container);
  const recommendation = state.decisionRecommendation;
  if (!recommendation) {
    meta.textContent = "尚未加载结构化建议。";
    return;
  }

  const providerMeta = getDecisionProviderMeta(state.decisionRecommendationProvider);
  const sourceLabel = providerMeta ? providerMeta.label : state.decisionRecommendationProvider;
  meta.textContent = `${state.decisionRecommendationFromCache ? "缓存建议" : "实时生成"} · ${publicModeLabel(sourceLabel)}${state.decisionRecommendationNotice ? ` · ${sanitizePublicText(state.decisionRecommendationNotice)}` : ""}`;

  const intro = create("article", "sample-card");
  intro.append(
    create("div", "sample-tag", "诊断结论"),
    create("p", "", sanitizePublicText(recommendation.diagnostic_conclusion || "")),
  );
  container.append(intro);

  (recommendation.priority_actions || []).forEach((action) => {
    const card = create("article", "sample-card");
    card.append(
      create("div", "sample-tag", `优先级 ${action.rank} · ${sanitizePublicText(action.urgency)}`),
      create("h3", "", sanitizePublicText(action.theme)),
      create("p", "", sanitizePublicText(action.why)),
    );
    const measures = create("div", "decision-bullet-list");
    (action.measures || []).forEach((item) => measures.append(create("div", "decision-bullet", `- ${sanitizePublicText(item)}`)));
    card.append(measures);
    if (action.evidence?.length) {
      const evidence = create("div", "decision-evidence-list");
      action.evidence.forEach((item) => evidence.append(create("span", "sample-tag", sanitizePublicText(item))));
      card.append(evidence);
    }
    container.append(card);
  });

  const planning = create("article", "sample-card");
  planning.append(create("div", "sample-tag", "行动分期"));
  [
    ["近期快改", recommendation.planning_measures?.quick_wins || []],
    ["中期推进", recommendation.planning_measures?.mid_term || []],
    ["长期策略", recommendation.planning_measures?.long_term || []],
  ].forEach(([label, items]) => {
    planning.append(create("div", "dataset-role", label));
    items.forEach((item) => planning.append(create("p", "", `- ${sanitizePublicText(item)}`)));
  });
  planning.append(create("p", "", `谨慎点：${sanitizePublicText(recommendation.caution || "暂无")}`));
  const confidence = recommendation.confidence || {};
  planning.append(create("p", "", `置信度：${publicConfidenceLabel(confidence.level)}${confidence.score ? ` (${confidence.score})` : ""}`));
  container.append(planning);
}

function renderDecisionEvidence() {
  const container = document.getElementById("decisionEvidence");
  if (!container) return;
  clear(container);
  const card = getSelectedDecisionCard();
  if (!card) return;

  const evidence = create("div", "sample-stack");
  const provenance = create("article", "sample-card");
  provenance.append(
    create("div", "sample-tag", "证据类别"),
    create("p", "", "这里综合了人流预测、空间供给诊断、社会感知和情景模拟，不直接展示内部文件路径。"),
    create("p", "", `当前判断重点：${publicResidualMeaning(state.selectedEntityType === "grid" ? card.residual_mean : card.residual_summary?.residual_mean)}。`),
  );
  evidence.append(provenance);

  const support = create("article", "sample-card");
  support.append(create("div", "sample-tag", "当前支撑点"));
  if (state.selectedEntityType === "grid") {
    (card.shap_top3 || []).forEach((item) => {
      support.append(create("p", "", `${publicFeatureLabel(item.feature || item.label)}：${publicDirectionLabel(item.direction)}。`));
    });
    if (card.counterfactual_best_scenario) {
      const scenario = card.counterfactual_best_scenario;
      support.append(create("p", "", `最值得优先尝试的改善情景：${publicScenarioLabel(scenario.scenario)}${scenario.description ? `，${sanitizePublicText(scenario.description)}` : ""}。`));
    }
  } else {
    (card.top_actionable_features || []).forEach((item) => {
      support.append(create("p", "", `${publicFeatureLabel(item.feature || item.label)}：${publicDirectionLabel(item.direction)}，平均分位约 ${((item.mean_percentile || 0) * 100).toFixed(1)}%。`));
    });
  }
  evidence.append(support);

  container.append(evidence);
}

function renderDecisionAreaCards() {
  const container = document.getElementById("decisionAreaCards");
  if (!container) return;
  clear(container);
  Object.values(state.decisionSupport.area_cards || {}).forEach((card) => {
    const item = create("article", `dataset-card decision-area-card${state.selectedEntityType === "area" && state.selectedEntityId === card.area_id ? " selected" : ""}`);
    item.append(
      create("div", "dataset-role", "片区摘要"),
      create("h3", "", publicAreaLabel(card.label || card.area_id)),
      create("p", "dataset-description", `平均供需偏差 ${Number(card.residual_summary?.residual_mean || 0).toFixed(1)}；主导画像 ${publicClusterLabel(card.dominant_clusters?.[0]?.cluster_label || "未标注")}。`),
      create("p", "dataset-description", `社会感知正向率 ${((((card.social_summary || {}).positive_rate || 0) * 100)).toFixed(1)}%；帖子 ${(card.social_summary || {}).post_count || 0} 条。`),
    );
    const metrics = create("div", "dataset-metrics");
    metrics.append(create("span", "", `${card.grid_ids.length} 个网格`));
    (card.top_actionable_features || []).slice(0, 2).forEach((feature) => metrics.append(create("span", "", publicFeatureLabel(feature.feature || feature.label))));
    item.append(metrics);
    item.addEventListener("click", () => setSelectedDecisionEntity("area", card.area_id));
    container.append(item);
  });
}

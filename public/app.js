const state = {
  dashboard: null,
  chatMessages: [],
  selectedProvider: "local",
  activeView: "chat",
  vaultOpen: false,
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
    document.getElementById("projectTitle").textContent = "Dashboard failed to load";
    document.getElementById("projectSubtitle").textContent = error.message;
  });
});

async function init() {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    throw new Error("Unable to load dashboard data.");
  }

  state.dashboard = await response.json();
  state.selectedProvider = state.dashboard.defaultChatProvider || "local";
  renderPage();
  bindLayerControls();
  bindWorkspaceNav();
  bindChat();
  bindProviderSelect();
  seedChat();
  initializeWorkspace();
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
  document.getElementById("projectTitle").textContent = dashboard.project.title;
  document.getElementById("projectSubtitle").textContent = dashboard.project.subtitle;
  document.getElementById("chatProviderText").textContent = `${dashboard.chatProvider} · model ${dashboard.chatModel} · ${dashboard.publicUrlHint}`;
  document.getElementById("chatModeBadge").textContent = dashboard.chatProvider;

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
  updateProviderHint();
}

function normalizeView(viewId) {
  const availableViews = new Set(
    Array.from(document.querySelectorAll(".workspace-view")).map((node) => node.getAttribute("data-view")),
  );
  return availableViews.has(viewId) ? viewId : "chat";
}

function initializeWorkspace() {
  state.vaultOpen = window.innerWidth >= 1180;
  syncVaultState();
  syncViewFromHash();
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

function renderHeroFacts(metrics) {
  const container = document.getElementById("heroFacts");
  clear(container);
  metrics.slice(0, 3).forEach((metric) => {
    const card = create("article", "hero-fact");
    card.append(create("strong", "", metric.value), create("span", "", metric.label));
    container.append(card);
  });
}

function renderMetrics(metrics) {
  const grid = document.getElementById("metricsGrid");
  clear(grid);
  metrics.forEach((metric) => {
    const card = create("article", "metric-card");
    card.append(
      create("div", "metric-label", metric.label),
      create("div", "metric-value", metric.value),
      create("p", "metric-detail", metric.detail),
    );
    grid.append(card);
  });
}

function renderFramework(pillars) {
  const grid = document.getElementById("frameworkGrid");
  clear(grid);
  pillars.forEach((pillar) => {
    const card = create("article", "framework-card");
    card.append(
      create("div", "eyebrow", pillar.subtitle),
      create("h3", "", pillar.title),
      create("p", "framework-subtitle", pillar.description),
    );
    grid.append(card);
  });
}

function renderDatasets(datasets) {
  const grid = document.getElementById("datasetsGrid");
  clear(grid);
  datasets.forEach((dataset) => {
    const card = create("article", "dataset-card");
    const badge = create("div", "readiness-badge", dataset.readiness);
    const metrics = create("div", "dataset-metrics");
    dataset.metrics.forEach((item) => metrics.append(create("span", "", item)));

    card.append(
      badge,
      create("div", "dataset-role", dataset.role),
      create("h3", "", dataset.name),
      create("div", "dataset-path", dataset.folder),
      create("p", "dataset-description", dataset.description),
      metrics,
    );
    grid.append(card);
  });
}

function renderPatterns(patterns) {
  const grid = document.getElementById("patternsGrid");
  clear(grid);
  patterns.forEach((pattern) => {
    const card = create("article", "pattern-card");
    card.append(
      create("div", "pattern-evidence-label", "Observed pattern"),
      create("h3", "", pattern.title),
      create("p", "pattern-evidence", pattern.evidence),
      create("p", "pattern-copy", pattern.implication),
    );
    grid.append(card);
  });
}

function renderProviderOptions(providers) {
  const select = document.getElementById("providerSelect");
  clear(select);
  providers.forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.available
      ? `${provider.label} · ${provider.model}`
      : `${provider.label} · not configured`;
    if (provider.id === state.selectedProvider) option.selected = true;
    select.append(option);
  });
}

function getProviderMeta(providerId = state.selectedProvider) {
  return state.dashboard.chatProviders.find((provider) => provider.id === providerId) || state.dashboard.chatProviders[0];
}

function updateProviderHint() {
  const provider = getProviderMeta();
  document.getElementById("providerHint").textContent = provider ? provider.hint : "";
}

function bindProviderSelect() {
  const select = document.getElementById("providerSelect");
  select.addEventListener("change", (event) => {
    state.selectedProvider = event.target.value;
    updateProviderHint();
  });
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

function renderSignalChart(timeline) {
  const svg = document.getElementById("signalTimelineChart");
  const data = timeline.map((item) => ({
    label: new Date(item.hour_start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }),
    value: item.signal_count,
  }));
  renderLineChart(svg, [{ name: "Signals", color: colors.terracotta, data }]);
}

function renderHotspotChart(hotspots) {
  const svg = document.getElementById("hotspotChart");
  const items = hotspots.slice(0, 10).map((item, index) => ({
    label: `${item.grid_id} · ${item.period}`,
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
    label: item.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    value: item.value,
  }));
}

function renderFusedVideoTimeline(timeline) {
  const svg = document.getElementById("fusedVideoTimelineChart");
  const data = buildProjectedFusedTimeline(timeline);
  renderLineChart(svg, [{ name: "Projected fused flow", color: colors.jade, data }]);
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
  text.textContent = "Lower movement intensity → higher movement intensity";
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
    label: item.label,
    value: item.count,
    display: `${item.count} docs`,
    color: index % 2 === 0 ? colors.jade : colors.terracotta,
  }));
  renderBarChart(svg, items);
}

function renderSocialSamples(samples) {
  const stack = document.getElementById("socialSamples");
  clear(stack);
  samples.slice(0, 4).forEach((sample) => {
    const card = create("article", "sample-card");
    const title = create("h4", "", sample.title);
    const meta = create("div", "dataset-role", `${sample.source_channel} · ${sample.sentiment_label}`);
    const tag = create("div", "sample-tag", sample.theme_primary || sample.topic_label || "Narrative sample");
    const link = create("a", "", sample.result_url || "");
    link.href = sample.result_url || "#";
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = sample.result_url ? "Open source" : "Local record";
    card.append(meta, title, tag, link);
    stack.append(card);
  });
}

function renderStreetMetrics(summary) {
  const grid = document.getElementById("streetMetrics");
  clear(grid);
  const items = [
    ["Avg beauty", Number(summary.avgScore).toFixed(1)],
    ["Green ratio", `${Number(summary.avgGreen).toFixed(1)}%`],
    ["Built ratio", `${Number(summary.avgBuild).toFixed(1)}%`],
    ["Traffic ratio", `${Number(summary.avgCar).toFixed(1)}%`],
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
  const rows = [
    ["Road network lines", summary.layer_counts.road_network],
    ["Pedestrian ways", summary.layer_counts.pedestrian_ways],
    ["Crossings", summary.layer_counts.crossings],
    ["Subway entrances", summary.layer_counts.subway_entrances],
    ["Subway stop positions", summary.layer_counts.subway_stop_positions],
    ["Extraction date", summary.extraction_date],
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
      label: row.label,
      value: row.test_total_mae,
      display: shortNumber(Math.round(row.test_total_mae)),
      color: row.color,
    }));
  renderBarChart(svg, items);

  const best = items[0];
  const baseline = state.dashboard.forecast.baselineComparison || [];
  const baselineText = baseline.length
    ? ` Legacy signal-only Mamba test Total MAE is ${shortNumber(Math.round(baseline.find((item) => item.label === "Signal-only Mamba")?.test_total_mae || 0))}.`
    : "";
  document.getElementById("forecastBestNote").textContent = `${best.label} currently gives the lowest held-out error in the multimodal comparison.${baselineText}`;
}

function renderForecastTimeline(timeline, summary) {
  const svg = document.getElementById("forecastTimelineChart");
  const data = timeline.map((item) => ({
    label: new Date(item.target_time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }),
    actual: item.actual_signal,
    hybrid: item.hybrid_pred_signal,
    transformer: item.transformer_only_pred_signal,
    mamba: item.mamba_only_pred_signal,
  }));

  renderLineChart(svg, [
    { name: "Actual", color: colors.ink, data: data.map((item) => ({ label: item.label, value: item.actual })) },
    { name: "Hybrid", color: colors.terracotta, data: data.map((item) => ({ label: item.label, value: item.hybrid })) },
    { name: "Transformer", color: colors.jade, data: data.map((item) => ({ label: item.label, value: item.transformer })) },
    { name: "Mamba", color: colors.amber, data: data.map((item) => ({ label: item.label, value: item.mamba })) },
  ]);

  const start = new Date(summary.testWindowStart).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  const end = new Date(summary.testWindowEnd).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  const peak = new Date(summary.hybridPeakPredTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  document.getElementById("forecastRangeNote").textContent = `Held-out window: ${start} to ${end}. The hybrid forecast peaks at ${peak}, while the actual weekly peak remains later on Saturday evening.`;
}

function renderForecastGates(gates) {
  const svg = document.getElementById("forecastGateChart");
  const items = gates.map((item) => ({
    label: item.label,
    value: item.value,
    display: `${Number(item.value).toFixed(1)}%`,
    color: item.color,
  }));
  renderBarChart(svg, items);
}

function renderForecastSummary(cards) {
  const container = document.getElementById("forecastSummaryCards");
  clear(container);
  cards.forEach((card) => {
    const chip = create("article", "camera-chip");
    chip.append(
      create("div", "metric-label", card.label),
      create("strong", "", card.value),
      create("span", "", card.detail),
    );
    container.append(chip);
  });
}

function renderForecastHighlights(items) {
  const container = document.getElementById("forecastHighlights");
  clear(container);
  items.forEach((item) => {
    const card = create("article", "sample-card");
    card.append(
      create("div", "sample-tag", "Forecast note"),
      create("h3", "", item.title),
      create("p", "", item.detail),
    );
    container.append(card);
  });
}

function renderForecastTopGrids(topGrids, errorGrids) {
  const container = document.getElementById("forecastTopGrids");
  clear(container);

  topGrids.forEach((grid, index) => {
    const card = create("article", "sample-card");
    card.append(
      create("div", "sample-tag", index < 3 ? "Predicted core" : "Forecast cell"),
      create("h3", "", `Grid ${grid.grid_id}`),
      create(
        "p",
        "",
        `Predicted total ${formatNumber(Math.round(grid.pred_signal))}, actual total ${formatNumber(Math.round(grid.actual_signal))}, absolute error ${formatNumber(Math.round(grid.abs_error))}.`,
      ),
    );
    container.append(card);
  });

  errorGrids.slice(0, 2).forEach((grid) => {
    const card = create("article", "sample-card");
    card.append(
      create("div", "sample-tag", "Error hotspot"),
      create("h3", "", `Grid ${grid.grid_id}`),
      create("p", "", `This cell accumulates ${formatNumber(Math.round(grid.abs_error))} total absolute forecast error in the hybrid run.`),
    );
    container.append(card);
  });
}


function renderPromptChips(prompts) {
  const container = document.getElementById("promptChips");
  clear(container);
  prompts.forEach((prompt) => {
    const button = create("button", "prompt-chip", prompt);
    button.type = "button";
    button.addEventListener("click", () => sendQuestion(prompt));
    container.append(button);
  });
}

function renderVideoLabels() {
  const observedCount = state.dashboard.video.fusedTimeline?.length || 0;
  const projectedCount = buildProjectedFusedTimeline(state.dashboard.video.fusedTimeline).length;
  const note = [state.dashboard.video.labelNote];
  if (projectedCount > observedCount) {
    note.push(
      "For display, the fused temporal chart bridges off-camera intervals with minute-level interpolation between sampled windows instead of showing artificial zero flow.",
    );
  }
  document.getElementById("videoLabelNote").textContent = note.join(" ");
}

function renderCameraBreakdown(rows) {
  const container = document.getElementById("cameraBreakdown");
  clear(container);
  rows.forEach((row) => {
    const chip = create("div", "camera-chip");
    chip.append(
      create("span", "dataset-role", row.camera),
      create("strong", "", `${shortNumber(row.unique_tracks)} tracks`),
      create("span", "", `${Number(row.track_share_pct).toFixed(1)}% of fused track set`),
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
  document.getElementById("chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("chatInput");
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    await sendQuestion(question);
  });
}

function seedChat() {
  state.chatMessages = [
    {
      role: "assistant",
      body: "Ask about peak crowd windows, fused dual-camera heatmaps, OD corridors, walkability priorities, or model-design ideas for Transformer and Mamba.",
      sources: [],
    },
  ];
  renderChatThread();
}

async function sendQuestion(question) {
  state.chatMessages.push({ role: "user", body: question, sources: [] });
  renderChatThread();
  state.chatMessages.push({ role: "assistant", body: "Working on a grounded answer...", sources: [] });
  renderChatThread();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, provider: state.selectedProvider, messages: state.chatMessages.slice(-8) }),
    });
    const payload = await response.json();
    state.chatMessages[state.chatMessages.length - 1] = {
      role: "assistant",
      body: payload.notice ? `${payload.answer}\n\n${payload.notice}` : payload.answer,
      sources: payload.sources || [],
    };
    document.getElementById("chatModeBadge").textContent = payload.mode || getProviderMeta()?.label || state.dashboard.chatProvider;
    renderChatThread();
  } catch (error) {
    state.chatMessages[state.chatMessages.length - 1] = {
      role: "assistant",
      body: `The chat request failed. ${error.message}`,
      sources: [],
    };
    renderChatThread();
  }
}

function renderChatThread() {
  const thread = document.getElementById("chatThread");
  clear(thread);
  state.chatMessages.forEach((message) => {
    const node = create("article", `message ${message.role}`);
    node.append(create("div", "message-role", message.role === "user" ? "You" : "AI copilot"));
    const body = create("div", "message-body");
    body.textContent = message.body;
    node.append(body);
    if (message.sources && message.sources.length) {
      const sources = create("div", "message-sources");
      message.sources.forEach((source) => sources.append(create("span", "", source)));
      node.append(sources);
    }
    thread.append(node);
  });
  thread.scrollTop = thread.scrollHeight;
}

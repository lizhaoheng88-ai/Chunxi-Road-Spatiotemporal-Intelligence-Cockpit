const TAVILY_ENDPOINT = process.env.TAVILY_BASE_URL || "https://api.tavily.com/search";

function isWebSearchAvailable() {
  return Boolean(process.env.TAVILY_API_KEY);
}

async function searchWeb(query, options = {}) {
  if (!isWebSearchAvailable()) {
    return [];
  }

  const body = {
    api_key: process.env.TAVILY_API_KEY,
    query,
    topic: options.topic || "general",
    search_depth: options.searchDepth || "advanced",
    max_results: options.limit || 5,
    include_answer: false,
    include_images: false,
    include_raw_content: false,
  };

  if (Array.isArray(options.domains) && options.domains.length) {
    body.include_domains = options.domains;
  }

  const response = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Web search failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return (payload.results || []).map((item) => ({
    title: item.title || "",
    snippet: item.content || item.snippet || "",
    url: item.url || "",
    date: item.published_date || item.date || null,
    score: item.score || null,
  }));
}

module.exports = {
  isWebSearchAvailable,
  searchWeb,
};

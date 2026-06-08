const API = "https://en.wikipedia.org/w/api.php";
const MAX_CHARS = 4000;
const DELAY_MS = 1500;
const MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WikiArticle {
  title: string;
  url: string;
  content: string;
}

async function fetchJson(url: string): Promise<unknown> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "wiki-questions/1.0 (educational project)" },
      });
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

async function searchTitles(query: string): Promise<string[]> {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "3",
    format: "json",
    origin: "*",
  });
  const data = (await fetchJson(`${API}?${params}`)) as {
    query?: { search?: { title: string }[] };
  };
  return (data.query?.search ?? []).map((r) => r.title);
}

async function fetchArticle(title: string): Promise<WikiArticle | null> {
  await sleep(DELAY_MS);
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    titles: title,
    explaintext: "true",
    exsectionformat: "plain",
    format: "json",
    origin: "*",
  });
  const data = (await fetchJson(`${API}?${params}`)) as {
    query?: { pages?: Record<string, { title: string; extract?: string; missing?: boolean }> };
  };

  const pages = data.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing || !page.extract) return null;

  const isDisambig =
    page.extract.includes("may refer to:") ||
    page.extract.includes("can refer to:");
  if (isDisambig) return null;

  return {
    title: page.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    content: page.extract.slice(0, MAX_CHARS),
  };
}

// Returns a WikiArticle on success, or an error string on failure.
export async function searchWikipedia(query: string): Promise<WikiArticle | string> {
  try {
    const titles = await searchTitles(query);
    if (titles.length === 0) {
      return `No Wikipedia articles found for: "${query}"`;
    }

    for (const title of titles) {
      const article = await fetchArticle(title);
      if (article) return article;
    }

    return `Could not retrieve content for any results matching: "${query}"`;
  } catch (err) {
    return `Wikipedia search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

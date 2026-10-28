import type { ChatRequest, ProviderSettings, Reference, SearchProviderId } from "../src/types";
import { classifySourceTier } from "./sourceTier";

/**
 * 自动网页搜索的供应商链。实现思路参考 Magpie 的 search_api.go：
 * 按顺序询问搜索 API，谁先返回页面就用谁；搜索摘要作为“有来源支持”，
 * 不冒充页面全文或事实认证。爬虫/页面抓取仍由本应用自己的 web.ts 负责。
 */

const SEARCH_HITS = 6;
const PAGE_TEXT = 1_500;
const SEARCH_TOTAL_TIMEOUT_MS = 25_000;
const SEARCH_AGENT = "zhixu-study/1";

export type SearchVendor = "tavily" | "brave" | "exa" | "firecrawl" | "deepseek" | "searxng" | "you";

export interface SearchProvider {
  vendor: SearchVendor;
  key: string;
  base: string;
}

export interface SearchHit {
  title: string;
  url: string;
  text: string;
  publishedAt?: string;
}

export class WebSearchError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}

const VENDOR_ENV: Record<SearchVendor, string | null> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  exa: "EXA_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  searxng: null,
  you: "YOU_API_KEY",
};

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function searchOrder(): SearchVendor[] {
  const configured = clean(process.env.ZHIXU_SEARCH_ORDER)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is SearchVendor => item in VENDOR_ENV);
  return configured.length ? configured : ["you", "tavily", "brave", "exa", "firecrawl", "deepseek", "searxng"];
}

const VENDOR_BASE: Record<Exclude<SearchVendor, "searxng" | "you">, string> = {
  tavily: "https://api.tavily.com",
  brave: "https://api.search.brave.com",
  exa: "https://api.exa.ai",
  firecrawl: "https://api.firecrawl.dev",
  deepseek: "https://api.deepseek.com",
};

function versionedProviderBase(id: SearchProviderId): string {
  return id === "you" ? "https://ydc-index.io" : VENDOR_BASE[id];
}

export function searchProvidersFromSettings(
  settings: Pick<ProviderSettings, "searchProvider" | "searchApiKey" | "searchFallbacks"> | undefined,
): SearchProvider[] {
  const providers: SearchProvider[] = [];
  const seen = new Set<string>();
  const add = (provider: SearchProviderId | undefined, rawKey: string | undefined): void => {
    const id = provider ?? "tavily";
    if (!["tavily", "brave", "exa", "firecrawl", "deepseek", "you"].includes(id)) {
      throw new WebSearchError(400, "search_provider_invalid", "搜索供应商不在支持列表内。");
    }
    const key = rawKey?.trim() ?? "";
    // 只有显式选择 You.com 才允许无 Key 的个人免费搜索；其它供应商空 Key 一律视为未配置。
    if (!key && id !== "you") return;
    const marker = `${id}:${key}`;
    if (seen.has(marker)) return;
    seen.add(marker);
    providers.push({
      vendor: id,
      key,
      base: id === "you" && !key ? "https://api.you.com" : versionedProviderBase(id),
    });
  };
  add(settings?.searchProvider, settings?.searchApiKey);
  for (const fallback of settings?.searchFallbacks ?? []) {
    add(fallback.provider, fallback.apiKey);
  }
  return providers;
}

export function webSearchProviders(): SearchProvider[] {
  const out: SearchProvider[] = [];
  for (const vendor of searchOrder()) {
    if (vendor === "you") {
      const key = clean(process.env.YOU_API_KEY);
      out.push({ vendor, key, base: key ? "https://ydc-index.io" : "https://api.you.com" });
      continue;
    }
    if (vendor === "searxng") {
      const base = clean(process.env.SEARXNG_URL);
      if (base) out.push({ vendor, key: "", base });
      continue;
    }
    const key = clean(process.env[VENDOR_ENV[vendor] ?? ""]);
    if (!key) continue;
    out.push({ vendor, key, base: versionedProviderBase(vendor) });
  }
  return out;
}

export function webSearchEnabled(): boolean {
  return process.env.ZHIXU_WEB_SEARCH?.trim().toLowerCase() === "true" && webSearchProviders().length > 0;
}

export function buildWebSearchQuery(request: ChatRequest): string {
  const latest = [...request.messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  return [request.goal, request.topic, latest].filter(Boolean).join("；").replace(/\s+/g, " ").slice(0, 500);
}

function clipText(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

function firstRunes(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function resultText(result: Record<string, unknown>): string {
  if (Array.isArray(result.snippets)) {
    const joined = result.snippets
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(" ");
    if (joined.trim()) return plainText(joined);
  }
  for (const key of ["content", "summary", "text", "description", "markdown", "snippet"]) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) return plainText(value);
  }
  return "";
}

function resultDate(result: Record<string, unknown>): string | undefined {
  for (const key of ["date", "page_age", "published_date", "publishedDate"]) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function resultUrl(result: Record<string, unknown>): string {
  const value = result.url ?? result.link;
  return typeof value === "string" ? value.trim() : "";
}

/** Parse the search replies of the vendors Magpie supports. */
export function parseSearchPayload(vendor: SearchVendor, payload: unknown): SearchHit[] {
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  let results: unknown[] = [];
  if (vendor === "brave") {
    const web = value.web;
    if (web && typeof web === "object" && Array.isArray((web as Record<string, unknown>).results)) {
      results = (web as Record<string, unknown>).results as unknown[];
    }
  } else if (vendor === "firecrawl") {
    const data = value.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const web = (data as Record<string, unknown>).web;
      if (Array.isArray(web)) results = web;
    } else if (Array.isArray(data)) {
      results = data;
    }
  } else if (vendor === "you") {
    const root = value.results;
    if (root && typeof root === "object") {
      const web = (root as Record<string, unknown>).web;
      const news = (root as Record<string, unknown>).news;
      if (Array.isArray(web)) results.push(...web);
      if (Array.isArray(news)) results.push(...news);
    }
  } else if (Array.isArray(value.results)) {
    results = value.results;
  }
  const hits: SearchHit[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as Record<string, unknown>;
    const url = resultUrl(result);
    if (!url) continue;
    const title = plainText(result.title) || url;
    const text = resultText(result);
    const publishedAt = resultDate(result);
    hits.push({
      title,
      url,
      text: clipText(text, PAGE_TEXT) || title,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return hits;
}

async function askProvider(provider: SearchProvider, query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": SEARCH_AGENT };
  let url = "";
  let init: RequestInit = { method: "GET", headers };
  const setAuth = () => {
    if (!provider.key) return;
    if (provider.vendor === "brave") headers["X-Subscription-Token"] = provider.key;
    else if (provider.vendor === "exa" || provider.vendor === "you") headers["X-API-Key"] = provider.key;
    else headers.Authorization = `Bearer ${provider.key}`;
  };
  const post = (path: string, body: unknown) => {
    url = joinUrl(provider.base, path);
    headers["Content-Type"] = "application/json";
    init = { method: "POST", headers, body: JSON.stringify(body) };
  };
  const get = (path: string, params: Record<string, string>) => {
    const target = new URL(joinUrl(provider.base, path));
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    url = target.toString();
    init = { method: "GET", headers };
  };
  switch (provider.vendor) {
    case "tavily":
      setAuth();
      post("/search", { query, max_results: SEARCH_HITS, search_depth: "basic" });
      break;
    case "brave":
      setAuth();
      get("/res/v1/web/search", { q: query, count: String(SEARCH_HITS) });
      break;
    case "exa":
      setAuth();
      post("/search", { query, numResults: SEARCH_HITS, contents: { text: { maxCharacters: PAGE_TEXT } } });
      break;
    case "firecrawl":
      setAuth();
      post("/v2/search", { query, limit: SEARCH_HITS });
      break;
    case "deepseek":
      setAuth();
      post("/v1/tools/search", { query: firstRunes(query, 128), count: SEARCH_HITS });
      break;
    case "searxng":
      get("/search", { q: query, format: "json" });
      break;
    case "you":
      if (provider.key) {
        setAuth();
        post("/v1/search", { query, count: SEARCH_HITS });
      } else {
        get("/v1/agents/search", { query, count: String(SEARCH_HITS) });
      }
      break;
  }
  if (!url) throw new WebSearchError(502, "search_vendor_invalid", `未知搜索供应商：${provider.vendor}`);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new WebSearchError(502, "search_network", `${provider.vendor} 搜索请求失败或超时。`);
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("联网搜索已取消。", "AbortError");
  if (!response.ok) {
    throw new WebSearchError(502, "search_http", `${provider.vendor} 搜索返回 HTTP ${response.status}。`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WebSearchError(502, "search_json", `${provider.vendor} 搜索返回了无法解析的 JSON。`);
  }
  return parseSearchPayload(provider.vendor, payload).slice(0, SEARCH_HITS);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("联网搜索已取消。", "AbortError");
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason ?? new DOMException("联网搜索已取消。", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface SearchEvidenceOptions {
  providers?: SearchProvider[];
  ask?: (provider: SearchProvider, query: string, signal?: AbortSignal) => Promise<SearchHit[]>;
  now?: () => Date;
  /** 外部取消信号：客户端断开时立即停止搜索并原样传播取消原因。 */
  signal?: AbortSignal;
  /** 整条供应商链的总时限；测试或上层可覆盖，默认 25 秒。 */
  timeoutMs?: number;
}

/** Try the configured providers in order; return source excerpts, never invented page text. */
export async function searchWebEvidence(
  query: string,
  options: SearchEvidenceOptions = {},
): Promise<Reference[]> {
  const externalSignal = options.signal;
  const totalTimeoutMs = Math.max(1, options.timeoutMs ?? SEARCH_TOTAL_TIMEOUT_MS);
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;
  const abortReason = (): unknown => {
    if (externalSignal?.aborted) {
      return externalSignal.reason ?? new DOMException("联网搜索已取消。", "AbortError");
    }
    if (deadline.aborted) {
      return new WebSearchError(
        504,
        "search_timeout",
        `联网搜索超过总时限（${Math.round(totalTimeoutMs / 1000)} 秒），已取消。`,
      );
    }
    return undefined;
  };
  const throwIfAborted = (): void => {
    const reason = abortReason();
    if (reason !== undefined) throw reason;
  };

  throwIfAborted();
  const providers = options.providers ?? webSearchProviders();
  if (!providers.length) {
    throw new WebSearchError(503, "search_not_configured", "未配置联网搜索供应商。请在 .env 设置 search key，或配置 SearXNG/You.com 免费搜索。");
  }
  const ask = options.ask ?? askProvider;
  const now = options.now ?? (() => new Date());
  const errors: string[] = [];
  for (const provider of providers) {
    throwIfAborted();
    let hits: SearchHit[];
    try {
      hits = await withAbort(ask(provider, query, signal), signal);
    } catch (error) {
      // 取消原因优先于供应商错误：晚到的失败同样不得掩盖客户端取消或总时限。
      throwIfAborted();
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    // 供应商忽略取消信号时，晚到结果也不得提交。
    throwIfAborted();
    if (!hits.length) {
      errors.push(`${provider.vendor} 没有找到结果`);
      continue;
    }
    const seen = new Set<string>();
    const references: Reference[] = [];
    for (const hit of hits) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(hit.url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
      } catch {
        continue;
      }
      const url = parsedUrl.toString();
      if (seen.has(url)) continue;
      seen.add(url);
      references.push({
        name: hit.title || parsedUrl.hostname,
        text: hit.text || hit.title,
        url,
        retrievedAt: now().toISOString(),
        verification: "search_snippet",
        sourceTier: classifySourceTier(url),
        ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
      });
    }
    if (references.length) return references;
  }
  throwIfAborted();
  throw new WebSearchError(502, "search_failed", `联网搜索没有返回可用来源：${errors.slice(0, 2).join("；") || "未知原因"}`);
}

import assert from "node:assert/strict";
import test from "node:test";
import type { ChatRequest } from "../src/types";
import { classifySourceTier } from "../server/sourceTier";
import {
  buildWebSearchQuery,
  parseSearchPayload,
  searchProvidersFromSettings,
  searchWebEvidence,
  webSearchEnabled,
  webSearchProviders,
  WebSearchError,
  type SearchHit,
  type SearchProvider,
} from "../server/webSearch";

const provider: SearchProvider = { vendor: "you", key: "", base: "https://api.you.com" };

test("来源等级只是域名启发式，并给未知域名留出明确状态", () => {
  assert.equal(classifySourceTier("https://docs.python.org/3/library/time.html"), "official");
  assert.equal(classifySourceTier("https://www.nasa.gov/mission"), "official");
  assert.equal(classifySourceTier("https://arxiv.org/abs/2601.00001"), "primary");
  assert.equal(classifySourceTier("https://en.wikipedia.org/wiki/Test"), "secondary");
  assert.equal(classifySourceTier("https://example.com/page"), "unknown");
  assert.equal(classifySourceTier("not a url"), "unknown");
});

test("各搜索供应商的响应结构解析为统一页面结果", () => {
  const one = [{ title: "Doc", url: "https://example.com/doc", content: "正文内容" }];
  assert.equal(parseSearchPayload("tavily", { results: one })[0].text, "正文内容");
  assert.equal(parseSearchPayload("brave", { web: { results: [{ title: "Doc", url: "https://example.com/doc", description: "Brave 摘要" }] } })[0].text, "Brave 摘要");
  assert.equal(parseSearchPayload("exa", { results: one })[0].url, "https://example.com/doc");
  assert.equal(parseSearchPayload("firecrawl", { data: { web: one } })[0].title, "Doc");
  assert.equal(parseSearchPayload("deepseek", { results: [{ title: "Doc", url: "https://example.com/doc", summary: "DeepSeek 摘要" }] })[0].text, "DeepSeek 摘要");
  assert.equal(parseSearchPayload("searxng", { results: one })[0].title, "Doc");
  assert.equal(parseSearchPayload("you", { results: { web: [{ title: "Doc", url: "https://example.com/doc", description: "You 摘要" }] } })[0].text, "You 摘要");
});

test("用户自带搜索密钥时只构造该用户的供应商，并使用备用顺序", () => {
  const providers = searchProvidersFromSettings({
    searchProvider: "brave",
    searchApiKey: "user-search-key",
    searchFallbacks: [
      { provider: "tavily", apiKey: "second-key" },
      { provider: "exa" },
    ],
  });
  assert.equal(providers.length, 2);
  assert.equal(providers[0].vendor, "brave");
  assert.equal(providers[0].key, "user-search-key");
  assert.equal(providers[1].vendor, "tavily");
  assert.equal(providers[1].key, "second-key");
  assert.equal(searchProvidersFromSettings({ searchProvider: "brave", searchApiKey: "" }).length, 0);
});

test("搜索证据保留 URL、来源等级、搜索摘要标记和发布日期", async () => {
  const references = await searchWebEvidence("Node.js LTS", {
    providers: [provider],
    now: () => new Date("2026-10-26T00:00:00.000Z"),
    ask: async () => [{
      title: "Node.js releases",
      url: "https://nodejs.org/en/about/previous-releases",
      text: "Node.js 24 is an LTS release.",
      publishedAt: "2026-10-20",
    }],
  });
  assert.equal(references.length, 1);
  assert.equal(references[0].verification, "search_snippet");
  assert.equal(references[0].sourceTier, "official");
  assert.equal(references[0].publishedAt, "2026-10-20");
  assert.equal(references[0].retrievedAt, "2026-10-26T00:00:00.000Z");
});

test("搜索供应商失败时按顺序回退，全部失败才报错", async () => {
  const providers: SearchProvider[] = [
    { vendor: "tavily", key: "bad", base: "https://api.tavily.com" },
    { vendor: "brave", key: "ok", base: "https://api.search.brave.com" },
  ];
  const references = await searchWebEvidence("q", {
    providers,
    ask: async (selected) => {
      if (selected.vendor === "tavily") throw new WebSearchError(502, "down", "tavily down");
      return [{ title: "Result", url: "https://example.com/result", text: "found" }];
    },
  });
  assert.equal(references[0].url, "https://example.com/result");
  await assert.rejects(
    searchWebEvidence("q", {
      providers,
      ask: async () => { throw new WebSearchError(502, "down", "all down"); },
    }),
    (error: unknown) => error instanceof WebSearchError && error.code === "search_failed",
  );
});

test("无搜索供应商时明确报未配置，不返回空结果冒充成功", async () => {
  await assert.rejects(
    searchWebEvidence("q", { providers: [] }),
    (error: unknown) => error instanceof WebSearchError && error.code === "search_not_configured",
  );
});

test("自动搜索查询包含目标、主题和本轮问题", () => {
  const request = {
    topic: "Python 循环",
    level: "从零开始",
    goal: "能解释 range 边界",
    action: "message",
    messages: [{ role: "user", content: "range(1,5) 为什么包含 1 不包含 5？" }],
  } as ChatRequest;
  const query = buildWebSearchQuery(request);
  assert.match(query, /range\(1,5\)/);
  assert.match(query, /Python 循环/);
  assert.ok(query.length <= 500);
});

test("自动搜索开关独立于网页抓取，You.com 无 Key 也可启用", () => {
  const snapshot = {
    ZHIXU_WEB_SEARCH: process.env.ZHIXU_WEB_SEARCH,
    ZHIXU_SEARCH_ORDER: process.env.ZHIXU_SEARCH_ORDER,
    YOU_API_KEY: process.env.YOU_API_KEY,
  };
  process.env.ZHIXU_WEB_SEARCH = "true";
  process.env.ZHIXU_SEARCH_ORDER = "you";
  delete process.env.YOU_API_KEY;
  try {
    assert.equal(webSearchEnabled(), true);
    const providers = webSearchProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].vendor, "you");
    assert.equal(providers[0].key, "");
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("显式选择 You.com 无 Key 时建立个人免费搜索，其它空 Key 供应商不放行", () => {
  const you = searchProvidersFromSettings({ searchProvider: "you", searchApiKey: "" });
  assert.equal(you.length, 1);
  assert.equal(you[0].vendor, "you");
  assert.equal(you[0].key, "");
  assert.equal(you[0].base, "https://api.you.com");
  assert.equal(searchProvidersFromSettings({ searchProvider: "tavily", searchApiKey: "   " }).length, 0);
  assert.equal(searchProvidersFromSettings({ searchProvider: "brave" }).length, 0);

  const mixed = searchProvidersFromSettings({
    searchProvider: "brave",
    searchApiKey: "user-search-key",
    searchFallbacks: [{ provider: "you" }, { provider: "exa" }, { provider: "you" }],
  });
  assert.deepEqual(mixed.map((item) => item.vendor), ["brave", "you"]);
  assert.equal(mixed[1].key, "");
});

test("外部取消信号传播到搜索供应商，晚到结果不提交", async () => {
  const controller = new AbortController();
  const reason = new DOMException("用户取消搜索", "AbortError");
  let received: AbortSignal | undefined;
  await assert.rejects(
    searchWebEvidence("q", {
      providers: [provider],
      signal: controller.signal,
      ask: async (_selected, _query, signal) => {
        received = signal;
        controller.abort(reason);
        return [{ title: "late", url: "https://example.com/late", text: "late" }];
      },
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(received?.aborted, true);
});

test("已取消的搜索不启动任何供应商", async () => {
  const controller = new AbortController();
  const reason = new DOMException("提前取消", "AbortError");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    searchWebEvidence("q", {
      providers: [provider],
      signal: controller.signal,
      ask: async () => {
        calls += 1;
        return [];
      },
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(calls, 0);
});

test("搜索按整条供应商链总时限取消，超时后不继续下一个供应商", async () => {
  let calls = 0;
  let received: AbortSignal | undefined;
  await assert.rejects(
    searchWebEvidence("q", {
      providers: [
        provider,
        { vendor: "brave", key: "key", base: "https://api.search.brave.com" },
      ],
      timeoutMs: 1,
      ask: async (_selected, _query, signal) => {
        calls += 1;
        received = signal;
        return Promise.withResolvers<SearchHit[]>().promise;
      },
    }),
    (error: unknown) =>
      error instanceof WebSearchError &&
      error.status === 504 &&
      error.code === "search_timeout",
  );
  assert.equal(calls, 1);
  assert.equal(received?.aborted, true);
});

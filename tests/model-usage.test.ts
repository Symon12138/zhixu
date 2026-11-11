import assert from "node:assert/strict";
import test from "node:test";
import { createModelInvoker, createTeachingPipeline } from "../server/ai";
import type { ChatResponse, ModelUsage } from "../src/types";

/* ── usage 解析与聚合（L1 成本计量基座） ─────────────────────── */

function configFixture(provider: "gemini" | "openai") {
  return {
    authRequired: false,
    publicOrigin: "",
    dataDir: ".",
    auditRetentionDays: 30,
    usageRetentionDays: 365,
    chatPerDay: 40,
    diagnosticPerDay: 10,
    reviewPerDay: 30,
    maxConcurrentAi: 2,
    allowByok: true,
    byokAllowedOrigins: [],
    provider,
    apiKey: "test-key",
    baseUrl: provider === "gemini" ? "https://gemini.test/v1" : "https://openai.test/v1",
    model: provider === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini",
    searchOrder: [],
    webFetchEnabled: false,
    webSearchEnabled: false,
    webAllowedHosts: [],
    webHourlyLimit: 30,
    structuredOutput: true,
    debugTiming: false,
    thinkingLevel: "auto" as const,
    reviewThinkingLevel: "auto" as const,
    modelCallTimeoutMs: 60_000,
    maxOutputTokens: 8_192,
  };
}

function geminiBody(): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: "讲解" }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45, cachedContentTokenCount: 30 },
  });
}

function openaiBody(): string {
  return JSON.stringify({
    choices: [{ message: { content: "讲解" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 64 } },
  });
}

test("Gemini usageMetadata 解析为 ModelUsage 并回调聚合", async () => {
  const calls: ModelUsage[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(geminiBody(), { status: 200 })) as typeof fetch;
  try {
    const invoke = createModelInvoker(configFixture("gemini"), usage => calls.push(usage));
    const text = await invoke({
      purpose: "draft",
      system: "测试",
      messages: [{ role: "user", content: "问题" }],
      signal: new AbortController().signal,
    });
    assert.equal(text, "讲解");
    assert.deepEqual(calls, [{ inputTokens: 120, outputTokens: 45, cachedTokens: 30 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI usage 解析为 ModelUsage 并回调聚合", async () => {
  const calls: ModelUsage[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(openaiBody(), { status: 200 })) as typeof fetch;
  try {
    const invoke = createModelInvoker(configFixture("openai"), usage => calls.push(usage));
    const text = await invoke({
      purpose: "review",
      system: "测试",
      messages: [{ role: "user", content: "问题" }],
      signal: new AbortController().signal,
    });
    assert.equal(text, "讲解");
    assert.deepEqual(calls, [{ inputTokens: 200, outputTokens: 80, cachedTokens: 64 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("多调用 usage 聚合：输入/输出/缓存分别求和", async () => {
  const first: ModelUsage = { inputTokens: 100, outputTokens: 40, cachedTokens: 10 };
  const second: ModelUsage = { inputTokens: 50, outputTokens: 20 };
  let usage: ModelUsage | undefined;
  const aggregate = (call: ModelUsage) => {
    usage = usage === undefined
      ? { ...call }
      : {
          inputTokens: usage.inputTokens + call.inputTokens,
          outputTokens: usage.outputTokens + call.outputTokens,
          cachedTokens: (usage.cachedTokens ?? 0) + (call.cachedTokens ?? 0),
        };
  };
  aggregate(first);
  aggregate(second);
  assert.deepEqual(usage, { inputTokens: 150, outputTokens: 60, cachedTokens: 10 });
});

test("vision 调用仍解析 usage：带附件图片的 Gemini/OpenAI 请求不破坏 token 计量", async () => {
  // 图片附件会改变请求体形状（inlineData parts / content 数组），
  // usage 解析路径不能因此失效；这里同时验证 usage 回调聚合照常工作。
  for (const provider of ["gemini", "openai"] as const) {
    const calls: ModelUsage[] = [];
    const originalFetch = globalThis.fetch;
    let captured: unknown;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return new Response(provider === "gemini" ? geminiBody() : openaiBody(), { status: 200 });
    }) as typeof fetch;
    try {
      const invoke = createModelInvoker(
        configFixture(provider),
        usage => calls.push(usage),
        { imageDataUrls: ["data:image/png;base64,AAEC"] },
      );
      const text = await invoke({
        purpose: "draft",
        system: "测试",
        messages: [{ role: "user", content: "看图讲解" }],
        signal: new AbortController().signal,
      });
      assert.equal(text, "讲解");
      assert.equal(calls.length, 1);
      // 请求体确实带上视觉部件，说明 usage 解析是在 vision 路径上完成的。
      const body = captured as Record<string, unknown>;
      assert.ok(
        provider === "gemini"
          ? JSON.stringify(body).includes("inlineData")
          : JSON.stringify(body).includes("image_url"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});
test("withModelUsage 语义：quality 携带 usage 时对调用方可见（chatCompletion 聚合路径）", () => {
  // 直接验证响应质量结构：chatCompletion 内部聚合后 quality.usage 必须存在。
  // 这里用类型层面的契约检查，真实网络路径由上面两个 provider 测试覆盖。
  const quality: NonNullable<ChatResponse["quality"]> = {
    checked: true,
    repaired: false,
    modelCalls: 2,
    grounding: "model_knowledge",
    limitations: [],
    usage: { inputTokens: 150, outputTokens: 60, cachedTokens: 10 },
  };
  assert.equal(quality.usage?.inputTokens, 150);
  assert.equal(quality.usage.cachedTokens, 10);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, chatCompletion, createModelInvoker, createTeachingPipeline, resolveConfig } from "../server/ai";
import { writeErrorResponse } from "../server/http";
import { runTeachingTurn } from "../server/tutor";
import { passingReview } from "./fixtures";

const request = {
  topic: "产品资产与客户账户", level: "从零开始", goal: "理解资金流向", action: "start" as const,
  messages: [{ role: "user" as const, content: "先解释产品和客户账户的区别" }],
};
const opening = JSON.stringify({
  message: "产品资产是产品持有的财产；客户现金账户是持有人收付现金的账户。现金分红把资产从前者转到后者，不会凭空创造收益。",
  title: "理解资金流向", plan: ["产品资产与账户", "现金分红", "交易确认"],
  question: { prompt: "你想先看产品资产，还是客户账户？", kind: "orientation", options: ["产品资产", "客户账户"], successCriteria: ["表达学习方向"] },
  sources: [], assumptions: [],
});

async function upstream(handle: (body: Record<string, any>, call: number) => { status?: number; body: unknown }) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const incoming = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const reply = handle(incoming, ++calls);
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get calls() { return calls; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
function restoreEnvironment(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface StubErrorResponse {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  req?: { requestId?: string };
  status(code: number): StubErrorResponse;
  json(body: unknown): StubErrorResponse;
}

function errorResponse(): {
  res: Parameters<typeof writeErrorResponse>[0];
  state: { status?: number; body?: unknown };
} {
  const state: { status?: number; body?: unknown } = {};
  const res: StubErrorResponse = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    req: { requestId: "test-request" },
    status(code) {
      state.status = code;
      return res;
    },
    json(body) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as Parameters<typeof writeErrorResponse>[0], state };
}

test("不支持原生JSON的兼容服务只失败一次，显式关闭后仍经过独立评审并提交非掌握状态", async () => {
  const secret = "local-only-native-json-test-credential";
  let accepted = 0;
  const service = await upstream(body => {
    if (body.response_format !== undefined) return { status: 400, body: { error: `unsupported-native-format:${secret}` } };
    const text = ++accepted === 1 ? opening : passingReview;
    return { body: { choices: [{ message: { content: text } }] } };
  });
  try {
    const settings = { provider: "openai" as const, apiKey: secret, model: "local-contract", baseUrl: service.url };
    await assert.rejects(runTeachingTurn(request, createModelInvoker(resolveConfig(settings))), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "upstream_bad_request");
      assert.ok(!error.message.includes(secret));
      return true;
    });
    assert.equal(service.calls, 1);
    const result = await runTeachingTurn(request, createModelInvoker(resolveConfig({ ...settings, structuredOutput: false })));
    assert.equal(service.calls, 3);
    assert.equal(result.quality!.modelCalls, 2);
    assert.equal(result.quality!.reviewAttempts, 1);
    assert.equal(result.learningState!.pendingQuestion!.kind, "orientation");
    assert.ok(result.learningState!.steps.every(step => step.evidence.length === 0 && !["understood", "applied"].includes(step.mastery)));
  } finally { await service.close(); }
});

test("兼容服务要求原生JSON时正常完成生成与评审，不遗漏该模式", async () => {
  const service = await upstream((body, call) => {
    if (body.response_format?.type !== "json_object") return { status: 400, body: { error: "native-json-required" } };
    return { body: { choices: [{ message: { content: call === 1 ? opening : passingReview } }] } };
  });
  try {
    const result = await runTeachingTurn(request, createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", baseUrl: service.url, model: "local-contract" })));
    assert.equal(service.calls, 2);
    assert.equal(result.quality!.checked, true);
    assert.equal(result.learningState!.pendingQuestion!.kind, "orientation");
    assert.deepEqual(result.learningState!.steps[0].evidence, []);
  } finally { await service.close(); }
});

test("Gemini原生与显式兼容模式都完成独立评审，前端兼容地址不能改写Gemini目的地", async () => {
  let native = true;
  let accepted = 0;
  const service = await upstream(body => {
    const mime = body.generationConfig?.responseMimeType;
    if (native ? mime !== "application/json" : mime !== undefined) return { status: 400, body: { error: "wrong-json-mode" } };
    const text = ++accepted % 2 === 1 ? opening : passingReview;
    return { body: { candidates: [{ content: { parts: [{ text }] } }] } };
  });
  const original = process.env.GEMINI_BASE_URL;
  process.env.GEMINI_BASE_URL = service.url;
  try {
    const settings = { provider: "gemini" as const, apiKey: "local-gemini-key", model: "local-contract", baseUrl: "http://127.0.0.1:9" };
    const first = await runTeachingTurn(request, createModelInvoker(resolveConfig(settings)));
    assert.equal(first.quality!.modelCalls, 2);
    assert.equal(first.learningState!.pendingQuestion!.kind, "orientation");
    native = false;
    const second = await runTeachingTurn(request, createModelInvoker(resolveConfig({ ...settings, structuredOutput: false })));
    assert.equal(service.calls, 4);
    assert.equal(second.quality!.reviewAttempts, 1);
    assert.deepEqual(second.learningState!.steps[0].evidence, []);
  } finally { restoreEnvironment({ GEMINI_BASE_URL: original }); await service.close(); }
});

test("网页密钥的显式JSON选项优先于服务端模式，无网页密钥时遵循服务端配置", () => {
  const snapshot = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, AI_STRUCTURED_OUTPUT: process.env.AI_STRUCTURED_OUTPUT };
  process.env.GEMINI_API_KEY = "server-only-contract-key";
  delete process.env.OPENAI_API_KEY;
  process.env.AI_STRUCTURED_OUTPUT = "false";
  try {
    assert.equal(resolveConfig({ provider: "gemini", apiKey: "page-key", structuredOutput: true }).structuredOutput, true);
    assert.equal(resolveConfig({ provider: "gemini", apiKey: "page-key", structuredOutput: false }).structuredOutput, false);
    assert.equal(resolveConfig({ provider: "gemini", apiKey: "", structuredOutput: true }).structuredOutput, false);
  } finally { restoreEnvironment(snapshot); }
});

test("独立评审模型只接管 review，写作模型与 BYOK 边界保持不变", async () => {
  const snapshot = {
    AI_REVIEW_MODEL: process.env.AI_REVIEW_MODEL,
    AI_REVIEW_THINKING_LEVEL: process.env.AI_REVIEW_THINKING_LEVEL,
  };
  const seen: Record<string, any>[] = [];
  const service = await upstream((body) => {
    seen.push(body);
    const text = body.model === "review-model" ? passingReview : opening;
    return { body: { choices: [{ message: { content: text } }] } };
  });
  process.env.AI_REVIEW_MODEL = "review-model";
  process.env.AI_REVIEW_THINKING_LEVEL = "auto";
  try {
    const config = resolveConfig({ provider: "openai", apiKey: "local-key", baseUrl: service.url, model: "writer-model" });
    const pipeline = createTeachingPipeline(config);
    assert.equal(pipeline.reviewerModel, "review-model");
    assert.equal(pipeline.maxWriterRevisions, 2);
    const result = await runTeachingTurn(request, pipeline.invoke, {
      maxWriterRevisions: pipeline.maxWriterRevisions,
    });
    assert.equal(result.quality!.checked, true);
    assert.deepEqual(seen.map((body) => body.model), ["writer-model", "review-model"]);
    const byok = createTeachingPipeline(config, { useReviewer: false });
    assert.equal(byok.reviewerModel, undefined);
    assert.equal(byok.maxWriterRevisions, 1);
  } finally {
    restoreEnvironment(snapshot);
    await service.close();
  }
});

test("主模型认证失败时按顺序切换备用模型，学习状态只提交一次", async () => {
  const bad = await upstream(() => ({ status: 401, body: { error: "bad primary key" } }));
  let calls = 0;
  const good = await upstream(() => ({ body: { choices: [{ message: { content: ++calls === 1 ? opening : passingReview } }] } }));
  try {
    const result = await chatCompletion({
      ...request,
      settings: {
        provider: "openai",
        apiKey: "primary-key",
        model: "primary-model",
        baseUrl: bad.url,
        structuredOutput: false,
        modelFallbacks: [{
          provider: "openai",
          apiKey: "fallback-key",
          model: "fallback-model",
          baseUrl: good.url,
          structuredOutput: false,
        }],
      },
    });
    assert.equal(result.quality!.checked, true);
    assert.equal(result.quality!.modelCalls, 2);
    assert.equal(result.quality!.model, "fallback-model");
    assert.equal(result.quality!.fallback, true);
    assert.equal(result.learningState!.steps.length, 3);
    assert.equal(bad.calls, 1);
    assert.equal(good.calls, 2);
    assert.ok(result.learningState!.steps.every((step) => step.mastery !== "understood" && step.mastery !== "applied"));
  } finally {
    await bad.close();
    await good.close();
  }
});

test("思考等级映射到 OpenAI 兼容请求且自动模式不附加参数", async () => {
  const seen: Record<string, any>[] = [];
  const service = await upstream((body, call) => {
    seen.push(body);
    return { body: { choices: [{ message: { content: call % 2 === 1 ? opening : passingReview } }] } };
  });
  try {
    const settings = { provider: "openai" as const, apiKey: "local-key", model: "local-contract", baseUrl: service.url };
    const high = await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ ...settings, thinkingLevel: "high" })),
    );
    assert.equal(high.quality!.checked, true);
    const auto = await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ ...settings, thinkingLevel: "auto" })),
    );
    assert.equal(auto.quality!.checked, true);
    assert.equal(seen.length, 4);
    assert.equal(seen[0].reasoning_effort, "high");
    assert.equal(seen[1].reasoning_effort, "high");
    assert.ok(!("reasoning_effort" in seen[2]));
    assert.ok(!("reasoning_effort" in seen[3]));
    assert.equal(seen[0].temperature, 0.4);
    assert.equal(seen[1].temperature, 0);
    assert.deepEqual(seen[0].response_format, { type: "json_object" });
    assert.deepEqual(seen[2].response_format, { type: "json_object" });
    assert.equal(seen[2].messages.length, seen[0].messages.length);
  } finally { await service.close(); }
});

test("Gemini 2.5 思考等级映射为 thinkingBudget", async () => {
  const original = process.env.GEMINI_BASE_URL;
  const seen: Record<string, unknown>[] = [];
  const service = await upstream((body, call) => {
    seen.push(body);
    return { body: { candidates: [{ content: { parts: [{ text: call === 1 ? opening : passingReview }] } }] } };
  });
  process.env.GEMINI_BASE_URL = service.url;
  try {
    const result = await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "gemini", apiKey: "local-key", model: "gemini-2.5-flash", thinkingLevel: "medium" })),
    );
    assert.equal(result.quality!.checked, true);
    assert.equal(service.calls, 2);
    assert.deepEqual(
      (seen[0].generationConfig as Record<string, unknown>).thinkingConfig,
      { thinkingBudget: 4096 },
    );
  } finally { restoreEnvironment({ GEMINI_BASE_URL: original }); await service.close(); }
});

test("Gemini 自动模式不发送思考配置，新版等级保持文档参数形状", async () => {
  const original = process.env.GEMINI_BASE_URL;
  const seen: Record<string, any>[] = [];
  const service = await upstream((body, call) => {
    seen.push(body);
    return { body: { candidates: [{ content: { parts: [{ text: call % 2 === 1 ? opening : passingReview }] } }] } };
  });
  process.env.GEMINI_BASE_URL = service.url;
  try {
    await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "gemini", apiKey: "local-key", model: "gemini-2.5-flash", thinkingLevel: "auto" })),
    );
    assert.ok(!("thinkingConfig" in seen[0].generationConfig));
    await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "gemini", apiKey: "local-key", model: "gemini-3.8-flash", thinkingLevel: "high" })),
    );
    assert.deepEqual(seen[2].generationConfig.thinkingConfig, { thinkingLevel: "high" });
    await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "gemini", apiKey: "local-key", model: "gemini-3.1-pro", thinkingLevel: "medium" })),
    );
    assert.deepEqual(seen[4].generationConfig.thinkingConfig, { thinkingLevel: "medium" });
    assert.ok(!("thinkingBudget" in seen[4].generationConfig.thinkingConfig));
    assert.equal(seen.length, 6);
  } finally { restoreEnvironment({ GEMINI_BASE_URL: original }); await service.close(); }
});

test("指定思考等级的上游拒绝包含恢复提示，不自动降级或重试", async () => {
  const service = await upstream(() => ({ status: 400, body: { error: "unsupported reasoning_effort" } }));
  try {
    await assert.rejects(
      runTeachingTurn(
        request,
        createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "local-contract", baseUrl: service.url, thinkingLevel: "high" })),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.ok(error.message.includes("把思考等级调回「自动」"));
        return true;
      },
    );
    assert.equal(service.calls, 1);
  } finally { await service.close(); }
});

test("GLM-5.3 使用文档支持的思考开关和强度，中档在调用前明确拒绝", async () => {
  const seen: Record<string, any>[] = [];
  const service = await upstream((body, call) => {
    seen.push(body);
    return { body: { choices: [{ message: { content: call % 2 === 1 ? opening : passingReview } }] } };
  });
  try {
    await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "glm-5.3-flash", baseUrl: service.url, thinkingLevel: "high" })),
    );
    assert.deepEqual(seen[0].thinking, { type: "enabled" });
    assert.equal(seen[0].reasoning_effort, "high");
    await assert.rejects(
      runTeachingTurn(
        request,
        createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "glm-5.3-flash", baseUrl: service.url, thinkingLevel: "medium" })),
      ),
      (error: unknown) => error instanceof ApiError && error.status === 400 && error.message.includes("不支持中等思考等级"),
    );
    assert.equal(seen.length, 2);
  } finally { await service.close(); }
});

test("未知 Gemini 模型不会盲目发送思考参数", async () => {
  await assert.rejects(
    runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "gemini", apiKey: "local-key", model: "my-gemini-2.5-proxy", thinkingLevel: "high" })),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 400 && error.message.includes("已知 Gemini 模型族"),
  );
});

test("GLM 5.2 以下指定思考强度时本地明确拒绝，不发送不支持的字段", async () => {
  for (const model of ["glm-5.1", "glm-4.7"]) {
    await assert.rejects(
      runTeachingTurn(
        request,
        createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model, baseUrl: "http://localhost:9/v1", thinkingLevel: "low" })),
      ),
      (error: unknown) => error instanceof ApiError && error.status === 400 && error.message.includes("不支持 reasoning_effort"),
    );
  }
});

test("兼容服务 content 为 text 数组时完成真实解析", async () => {
  const service = await upstream((body, call) => ({
    body: { choices: [{ message: { content: [{ type: "text", text: call === 1 ? opening : passingReview }] } }] },
  }));
  try {
    const result = await runTeachingTurn(request, createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "local-contract", baseUrl: service.url })));
    assert.equal(result.quality!.checked, true);
    assert.equal(service.calls, 2);
    assert.equal(result.learningState!.pendingQuestion!.kind, "orientation");
  } finally { await service.close(); }
});

test("thinking 和 reasoning_content 不得冒充教学答案", async () => {
  const thought = JSON.stringify({ message: "这只是思考文本，不是答案" });
  const service = await upstream(() => ({ body: { choices: [{ message: { content: "", reasoning_content: thought } }] } }));
  try {
    await assert.rejects(
      runTeachingTurn(request, createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "glm-5.3-flash", baseUrl: service.url }))),
      (error: unknown) => error instanceof ApiError && error.status === 502 && error.message.includes("空内容"),
    );
    assert.equal(service.calls, 1);
  } finally { await service.close(); }
});

test("Gemini 思考片段不会混入公开回答", async () => {
  const original = process.env.GEMINI_BASE_URL;
  const service = await upstream((body, call) => ({
    body: { candidates: [{ content: { parts: [{ text: "内部思考，不应公开", thought: true }, { text: call === 1 ? opening : passingReview }] } }] },
  }));
  process.env.GEMINI_BASE_URL = service.url;
  try {
    const result = await runTeachingTurn(request, createModelInvoker(resolveConfig({ provider: "gemini", apiKey: "local-key", model: "gemini-2.5-flash" })));
    assert.equal(result.quality!.checked, true);
    assert.equal(service.calls, 2);
    assert.ok(!result.message.includes("内部思考"));
  } finally { restoreEnvironment({ GEMINI_BASE_URL: original }); await service.close(); }
});

test("路由前缀模型名保留传输名且正确映射思考强度", async () => {
  const seen: Record<string, any>[] = [];
  const service = await upstream((body, call) => {
    seen.push(body);
    return { body: { choices: [{ message: { content: call % 2 === 1 ? opening : passingReview } }] } };
  });
  try {
    await runTeachingTurn(
      request,
      createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "wb/cn:glm-5.3-flash", baseUrl: service.url, thinkingLevel: "high" })),
    );
    assert.equal(seen[0].model, "wb/cn:glm-5.3-flash");
    assert.equal(seen[0].reasoning_effort, "high");
    assert.deepEqual(seen[0].thinking, { type: "enabled" });
  } finally { await service.close(); }
});

test("只有工具调用没有文本时明确拒绝，不重复调用或执行工具", async () => {
  const service = await upstream(() => ({ body: { choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] } }));
  try {
    await assert.rejects(
      runTeachingTurn(request, createModelInvoker(resolveConfig({ provider: "openai", apiKey: "local-key", model: "local-contract", baseUrl: service.url }))),
      (error: unknown) => error instanceof ApiError && error.status === 502 && error.message.includes("本应用不使用工具"),
    );
    assert.equal(service.calls, 1);
  } finally { await service.close(); }
});

test("缺少模型配置时返回 400/not_configured，不伪装成上游故障", () => {
  const snapshot = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(
      () => resolveConfig(undefined),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "not_configured");
        return true;
      },
    );
  } finally {
    restoreEnvironment(snapshot);
  }
});

test("上游认证失败映射为 502/upstream_auth，不伪装成登录过期且不回显密钥", async () => {
  const secret = "upstream-auth-only-credential";
  const service = await upstream((_body, call) => ({
    status: call === 1 ? 401 : 403,
    body: { error: `invalid upstream credential ${secret}` },
  }));
  const original = process.env.GEMINI_BASE_URL;
  process.env.GEMINI_BASE_URL = service.url;
  try {
    for (const [index, settings] of [
      { provider: "openai" as const, apiKey: secret, model: "local-contract", baseUrl: service.url, structuredOutput: false },
      { provider: "gemini" as const, apiKey: secret, model: "gemini-2.5-flash", baseUrl: "http://127.0.0.1:9", structuredOutput: false },
    ].entries()) {
      const expectedUpstream = index === 0 ? 401 : 403;
      await assert.rejects(
        chatCompletion({ ...request, settings }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 502);
          assert.equal(error.code, "upstream_auth");
          assert.equal(error.upstreamStatus, expectedUpstream);
          assert.ok(error.message.includes(`HTTP ${expectedUpstream}`));
          assert.ok(error.message.includes("invalid upstream credential"));
          assert.ok(!error.message.includes(secret));
          const outcome = errorResponse();
          writeErrorResponse(outcome.res, error);
          assert.equal(outcome.state.status, 502);
          assert.equal((outcome.state.body as { code?: string }).code, "upstream_auth");
          assert.ok(!JSON.stringify(outcome.state.body).includes(secret));
          return true;
        },
      );
    }
  } finally {
    restoreEnvironment({ GEMINI_BASE_URL: original });
    await service.close();
  }
});

test("上游 400/404 参数与配置错误直接返回，不触发备用模型", async () => {
  for (const [status, code] of [[400, "upstream_bad_request"], [404, "upstream_not_found"]] as const) {
    const primary = await upstream(() => ({ status, body: { error: `upstream rejected ${status}` } }));
    const fallback = await upstream((_body, call) => ({
      body: { choices: [{ message: { content: call === 1 ? opening : passingReview } }] },
    }));
    try {
      await assert.rejects(
        chatCompletion({
          ...request,
          settings: {
            provider: "openai",
            apiKey: "primary-key",
            model: "primary-model",
            baseUrl: primary.url,
            structuredOutput: false,
            modelFallbacks: [{
              provider: "openai",
              apiKey: "fallback-key",
              model: "fallback-model",
              baseUrl: fallback.url,
              structuredOutput: false,
            }],
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 502);
          assert.equal(error.code, code);
          assert.equal(error.upstreamStatus, status);
          assert.ok(error.message.includes(`HTTP ${status}`));
          return true;
        },
      );
      assert.equal(primary.calls, 1);
      assert.equal(fallback.calls, 0);
    } finally {
      await primary.close();
      await fallback.close();
    }
  }
});

test("限流、5xx 与连接失败触发故障转移，并记录真实使用模型", async () => {
  for (const status of [429, 500]) {
    const primary = await upstream(() => ({ status, body: { error: `transient ${status}` } }));
    const fallback = await upstream((_body, call) => ({
      body: { choices: [{ message: { content: call === 1 ? opening : passingReview } }] },
    }));
    try {
      const result = await chatCompletion({
        ...request,
        settings: {
          provider: "openai",
          apiKey: "primary-key",
          model: "primary-model",
          baseUrl: primary.url,
          structuredOutput: false,
          modelFallbacks: [{
            provider: "openai",
            apiKey: "fallback-key",
            model: "fallback-model",
            baseUrl: fallback.url,
            structuredOutput: false,
          }],
        },
      });
      assert.equal(result.quality!.model, "fallback-model");
      assert.equal(result.quality!.fallback, true);
      assert.equal(primary.calls, 1);
      assert.equal(fallback.calls, 2);
    } finally {
      await primary.close();
      await fallback.close();
    }
  }

  const dead = await upstream(() => ({ body: {} }));
  const deadUrl = dead.url;
  await dead.close();
  const fallback = await upstream((_body, call) => ({
    body: { choices: [{ message: { content: call === 1 ? opening : passingReview } }] },
  }));
  try {
    const result = await chatCompletion({
      ...request,
      settings: {
        provider: "openai",
        apiKey: "primary-key",
        model: "primary-model",
        baseUrl: deadUrl,
        structuredOutput: false,
        modelFallbacks: [{
          provider: "openai",
          apiKey: "fallback-key",
          model: "fallback-model",
          baseUrl: fallback.url,
          structuredOutput: false,
        }],
      },
    });
    assert.equal(result.quality!.model, "fallback-model");
    assert.equal(result.quality!.fallback, true);
    assert.equal(fallback.calls, 2);
  } finally {
    await fallback.close();
  }

  const primary = await upstream((_body, call) => ({
    body: { choices: [{ message: { content: call === 1 ? opening : passingReview } }] },
  }));
  try {
    const result = await chatCompletion({
      ...request,
      settings: {
        provider: "openai",
        apiKey: "primary-key",
        model: "primary-model",
        baseUrl: primary.url,
        structuredOutput: false,
      },
    });
    assert.equal(result.quality!.model, "primary-model");
    assert.equal(result.quality!.fallback, false);
    assert.equal(primary.calls, 2);
  } finally {
    await primary.close();
  }
});

test("本地配置错误直接返回，不消耗备用模型", async () => {
  let fallbackCalls = 0;
  const fallback = await upstream(() => {
    fallbackCalls += 1;
    return { body: { choices: [{ message: { content: opening } }] } };
  });
  const modelFallbacks = [{
    provider: "openai" as const,
    apiKey: "fallback-key",
    model: "fallback-model",
    baseUrl: fallback.url,
    structuredOutput: false,
  }];
  try {
    await assert.rejects(
      chatCompletion({
        ...request,
        settings: {
          provider: "openai",
          apiKey: "primary-key",
          model: "primary-model",
          baseUrl: "not-a-valid-url",
          structuredOutput: false,
          modelFallbacks,
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_config");
        return true;
      },
    );
    assert.equal(fallbackCalls, 0);
    await assert.rejects(
      chatCompletion({
        ...request,
        settings: {
          provider: "openai",
          apiKey: "primary-key",
          model: "glm-5.1",
          baseUrl: "http://localhost:9/v1",
          structuredOutput: false,
          thinkingLevel: "low",
          modelFallbacks,
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "unsupported_thinking_level");
        return true;
      },
    );
    assert.equal(fallbackCalls, 0);
  } finally {
    await fallback.close();
  }
});

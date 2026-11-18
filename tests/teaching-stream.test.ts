import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createApp, validateChatRequest } from "../server/index";
import { ZhixuDatabase } from "../server/db";
import { getSystemPrompts, runTeachingTurn, TeachingQualityError, PHASE_LABELS } from "../server/tutor";
import { publicErrorPayload } from "../server/http";
import { ApiError } from "../server/ai";
import {
  isEventStream,
  parseSseFrame,
  readChatStream,
  splitSseFrames,
} from "../src/lib/chatStream";
import type { ChatRequest, ChatResponse, PhaseEvent } from "../src/types";
import type { ChatStreamOutcome } from "../src/lib/chatStream";

/* ── 固定夹具：与既有 provider-output 测试一致的一轮通过管线 ─────────── */

const request: ChatRequest = {
  topic: "产品资产与客户账户",
  level: "从零开始",
  goal: "理解资金流向",
  action: "start",
  messages: [{ role: "user", content: "先解释产品和客户账户的区别" }],
};

const opening = JSON.stringify({
  message: "产品资产是产品持有的财产；客户现金账户是持有人收付现金的账户。现金分红把资产从前者转到后者，不会凭空创造收益。",
  title: "理解资金流向",
  plan: ["产品资产与账户", "现金分红", "交易确认"],
  question: { prompt: "你想先看产品资产，还是客户账户？", kind: "orientation", options: ["产品资产", "客户账户"], successCriteria: ["表达学习方向"] },
  sources: [],
  assumptions: [],
});

const passingReview = JSON.stringify({
  verdict: "pass",
  checks: { responsive: true, assessment: true, scaffolding: true, continuity: true, calibration: true },
  issues: [],
});

function openaiEnvelope(content: string): Record<string, unknown> {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

/* ── 1. SSE 帧解析（纯函数） ─────────────────────────────────────────── */

test("parseSseFrame：解析 event/data、忽略注释与心跳、合并多行 data", () => {
  assert.deepEqual(
    parseSseFrame('event: phase\ndata: {"phase":"draft","label":"生成草稿"}'),
    { event: "phase", data: '{"phase":"draft","label":"生成草稿"}' },
  );
  assert.deepEqual(
    parseSseFrame(": keep-alive\ndata: 甲\ndata: 乙"),
    { event: "message", data: "甲\n乙" },
  );
  assert.equal(parseSseFrame(": keep-alive"), null, "纯注释帧不产生事件");
  assert.equal(parseSseFrame(""), null);
});

test("splitSseFrames：按空行切完整帧，保留末尾不完整帧", () => {
  const first = 'event: phase\ndata: {"phase":"draft"}\n\n';
  const partial = 'event: result\ndata: {"message":"半';
  const { frames, rest } = splitSseFrames(first + partial);
  assert.deepEqual(frames, ['event: phase\ndata: {"phase":"draft"}']);
  assert.equal(rest, partial);
  assert.deepEqual(splitSseFrames("a\r\n\r\nb").frames, ["a"]);
  assert.equal(splitSseFrames("a\r\n\r\nb").rest, "b");
});

test("isEventStream：只按响应 Content-Type 判断，前置 JSON 错误不被误判为流", () => {
  const response = (type: string) =>
    ({ headers: new Headers({ "content-type": type }) }) as Pick<Response, "headers">;
  assert.equal(isEventStream(response("text/event-stream; charset=utf-8")), true);
  assert.equal(isEventStream(response("application/json")), false);
  assert.equal(isEventStream(response("")), false);
});

function sseResponse(body: string, type = "text/event-stream; charset=utf-8"): Response {
  const encoder = new TextEncoder();
  const mid = Math.floor(body.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, mid)));
      controller.enqueue(encoder.encode(body.slice(mid)));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": type } });
}
function resultOf(outcome: ChatStreamOutcome): ChatResponse {
  assert.equal(outcome.kind, "result");
  assert.ok("response" in outcome);
  return outcome.response;
}

function errorOf(outcome: ChatStreamOutcome): { status: number; body: Record<string, unknown> } {
  assert.equal(outcome.kind, "error");
  assert.ok("body" in outcome);
  return { status: outcome.status, body: outcome.body };
}

test("readChatStream：逐帧分发真实阶段、返回完整 result、忽略心跳与未知事件", async () => {
  const phases: PhaseEvent[] = [];
  const body =
    ": keep-alive\n\n" +
    'event: phase\ndata: {"phase":"draft","label":"正在生成讲解草稿"}\n\n' +
    'event: phase\ndata: {"phase":"review","label":"独立评审正在检查讲解"}\n\n' +
    'event: phase\ndata: {"phase":"bogus","label":"伪造阶段"}\n\n' +
    'event: result\ndata: {"message":"讲清了"}\n\n';
  const outcome = await readChatStream(sseResponse(body), (phase) => phases.push(phase));
  assert.equal(resultOf(outcome).message, "讲清了");
  assert.deepEqual(phases.map((p) => p.phase), ["draft", "review"], "未知/伪造阶段被丢弃");
});

test("readChatStream：error 事件携带 status 与公开 body，流截断明确标记", async () => {
  const errorBody = 'event: error\ndata: {"status":422,"error":"质检未通过","code":"X","issues":[]}\n\n';
  const error = errorOf(await readChatStream(sseResponse(errorBody)));
  assert.equal(error.status, 422);
  assert.equal(error.body.error, "质检未通过");

  const truncated = await readChatStream(
    sseResponse('event: phase\ndata: {"phase":"repair","label":"修订"}\n\n'),
  );
  assert.equal(truncated.kind, "truncated", "只收阶段、没有 result 必须视为未提交");

  const empty = await readChatStream(new Response(null, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(empty.kind, "truncated");
});

/* ── 2. 阶段来自真实模型调用边界；教学偏好只追加 writer ─────────────── */

test("runTeachingTurn：onPhase 按 draft→review→publish 顺序发出真实阶段", async () => {
  const phases: TeachingQualityError["status"][] = [];
  const phaseNames: string[] = [];
  const invoke = async (input: { purpose: string }): Promise<string> => {
    if (input.purpose === "draft") return opening;
    if (input.purpose === "review") return passingReview;
    return opening;
  };
  const response = await runTeachingTurn(request, invoke, {
    onPhase: (event) => {
      phaseNames.push(event.phase);
      phases.push(PHASE_LABELS[event.phase] ? 1 : 0);
    },
  });
  assert.equal(typeof response.message, "string");
  assert.deepEqual(phaseNames, ["draft", "review", "publish"]);
  assert.ok(phases.every((v) => v === 1), "每个阶段都带中文说明");
});

test("runTeachingTurn：teachingInstructions 只进 writer system，不进 review system", async () => {
  const systems: Record<string, string> = {};
  const invoke = async (input: { purpose: string; system: string }): Promise<string> => {
    systems[input.purpose] = input.system;
    if (input.purpose === "draft") return opening;
    if (input.purpose === "review") return passingReview;
    return opening;
  };
  await runTeachingTurn(
    { ...request, teachingInstructions: "多用生活类比，先给反例" },
    invoke,
  );
  assert.match(systems.draft, /【学习者补充偏好】/);
  assert.match(systems.draft, /多用生活类比，先给反例/);
  assert.match(systems.draft, /不得改变 JSON 输出结构/);
  assert.doesNotMatch(systems.review, /多用生活类比/);
  assert.doesNotMatch(systems.review, /【学习者补充偏好】/);
});

/* ── 3. 系统提示只读端点与请求校验 ─────────────────────────────────── */

test("getSystemPrompts 返回三套系统提示全文，不含任何密钥字段", () => {
  const prompts = getSystemPrompts();
  assert.ok(prompts.writer.length > 200 && prompts.writer.includes("只返回合法JSON"));
  assert.ok(prompts.review.length > 200 && prompts.review.includes("独立、严格的教学质量评审员"));
  assert.ok(prompts.bookWriter.length > 50);
  assert.doesNotMatch(JSON.stringify(prompts), /apiKey|api_key|secret|Bearer/i);
});

test("validateChatRequest：teachingInstructions 合法/过长/非字符串/控制字符", () => {
  const base = { action: "start", topic: "极限", level: "初学", goal: "理解", messages: [{ role: "user", content: "开始" }] };
  const ok = validateChatRequest({ ...base, teachingInstructions: "  多用类比  " });
  assert.equal(ok.teachingInstructions, "多用类比", "两端空白被规范化");
  assert.equal(validateChatRequest(base).teachingInstructions, undefined);

  assert.throws(() => validateChatRequest({ ...base, teachingInstructions: 123 }), /必须是字符串/);
  assert.throws(() => validateChatRequest({ ...base, teachingInstructions: "x".repeat(2001) }), /过长/);
  assert.throws(() => validateChatRequest({ ...base, teachingInstructions: "含\u0000控制符" }), /控制字符/);
});

test("publicErrorPayload：JSON 与 SSE error 共用同一公开映射口径", () => {
  const quality = publicErrorPayload(new TeachingQualityError(422, "QUALITY", [{ code: "x", detail: "内部细节" }], "质检未通过"));
  assert.equal(quality.status, 422);
  assert.equal(quality.body.code, "QUALITY");
  assert.doesNotMatch(JSON.stringify(quality.body), /内部细节/, "issues 走公开清洗");

  const api = publicErrorPayload(new ApiError(502, "上游失败", { code: "upstream_error" }));
  assert.equal(api.status, 502);
  assert.equal(api.body.error, "上游失败");

  const unknown = publicErrorPayload(new Error("secret=abc"));
  assert.equal(unknown.status, 500);
  assert.doesNotMatch(JSON.stringify(unknown.body), /secret/);
});

/* ── 4. 真实 HTTP：/api/prompts 与 /api/chat SSE 双模式 ─────────────── */

const config = {
  production: false,
  port: 3001,
  host: "127.0.0.1",
  authRequired: false,
  allowByok: true,
  cookieSecure: false,
  publicOrigin: null,
  trustProxy: false,
  quotas: { chatPerDay: 40, diagnosticPerDay: 10, reviewPerDay: 30 },
  maxConcurrentAi: 2,
  auditRetentionDays: 90,
  usageRetentionDays: 90,
  byokAllowedOrigins: [] as string[],
  allowInsecureLocal: false,
  dataDir: "",
};

interface FakeUpstream {
  url: string;
  calls: () => number;
  close: () => Promise<void>;
}

/** 按请求里的 system 提示判别 draft/review，而不是靠全局调用计数（多请求会串号）。 */
async function fakeUpstream(
  respond: (purpose: "draft" | "review", call: number) => { status?: number; body: unknown },
): Promise<FakeUpstream> {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const incoming = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { role: string; content: string }[] };
    const system = incoming.messages?.find((m) => m.role === "system")?.content ?? "";
    const purpose = system.includes("独立、严格的教学质量评审员") ? "review" : "draft";
    const reply = respond(purpose, ++calls);
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await ready;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    close: () => {
      const { promise, resolve: done, reject: failed } = Promise.withResolvers<void>();
      server.close((e) => (e ? failed(e) : done()));
      return promise;
    },
  };
}

function envSnapshot() {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    AI_REVIEW_MODEL: process.env.AI_REVIEW_MODEL,
    AI_STRUCTURED_OUTPUT: process.env.AI_STRUCTURED_OUTPUT,
  };
}

function restoreEnv(saved: ReturnType<typeof envSnapshot>) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startApp(): Promise<{ base: string; db: ZhixuDatabase; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-stream-"));
  const db = new ZhixuDatabase(path.join(dir, "zhixu.db"));
  const app = createApp({ config: { ...config, dataDir: dir }, db, serveStatic: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    db,
    close: async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      server.closeAllConnections();
      await promise;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const chatHeaders = {
  "Content-Type": "application/json",
  "X-Zhixu-Request": "1",
  Accept: "text/event-stream",
};

test("GET /api/prompts 返回三套提示，不含密钥", async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/api/prompts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { writer: string; review: string; bookWriter: string };
    assert.deepEqual(body, getSystemPrompts());
    assert.doesNotMatch(JSON.stringify(body), /apiKey|secret|token/i);
  } finally {
    await app.close();
  }
});

test("POST /api/chat SSE：真实阶段事件 + 完整 result，默认 JSON 仍兼容", async () => {
  const saved = envSnapshot();
  const upstream = await fakeUpstream((purpose) => ({
    body: openaiEnvelope(purpose === "draft" ? opening : passingReview),
  }));
  process.env.GEMINI_API_KEY = "";
  process.env.GEMINI_BASE_URL = "";
  process.env.AI_REVIEW_MODEL = "";
  process.env.OPENAI_API_KEY = "test-server-key";
  process.env.OPENAI_BASE_URL = upstream.url;
  const app = await startApp();
  try {
    const chatBody = { action: "start", topic: "二分查找", level: "初学", goal: "理解边界", messages: [{ role: "user", content: "开始学习" }] };
    // SSE 模式：响应 Content-Type 为 text/event-stream，帧内含真实阶段与完整 result。
    const streamed = await fetch(`${app.base}/api/chat`, { method: "POST", headers: chatHeaders, body: JSON.stringify(chatBody) });
    assert.equal(streamed.status, 200);
    assert.equal(isEventStream(streamed), true);
    const phases: string[] = [];
    const outcome = await readChatStream(streamed, (e) => phases.push(e.phase));
    assert.equal(typeof resultOf(outcome).message, "string");
    assert.deepEqual(phases, ["draft", "review", "publish"], "阶段来自服务端真实模型调用边界");

    // 不带 Accept 的旧客户端仍拿到单一 JSON（兼容契约未破坏）。
    const legacy = await fetch(`${app.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zhixu-Request": "1" },
      body: JSON.stringify(chatBody),
    });
    assert.equal(isEventStream(legacy), false);
    assert.equal(legacy.status, 200);
    const legacyBody = (await legacy.json()) as { message: string };
    assert.equal(typeof legacyBody.message, "string");
  } finally {
    await app.close();
    await upstream.close();
    restoreEnv(saved);
  }
});

test("POST /api/chat SSE：前置校验错误仍是普通 JSON，不伪装成流", async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/api/chat`, {
      method: "POST",
      headers: chatHeaders,
      body: JSON.stringify({ action: "start" }), // 缺 topic/messages
    });
    assert.equal(res.status, 400);
    assert.equal(isEventStream(res), false);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0);
  } finally {
    await app.close();
  }
});

test("POST /api/chat SSE：响应头发出后的模型失败用 error 事件承载与 JSON 一致的公开 payload", async () => {
  const saved = envSnapshot();
  const upstream = await fakeUpstream(() => ({ status: 500, body: { error: { message: "boom" } } }));
  process.env.GEMINI_API_KEY = "";
  process.env.GEMINI_BASE_URL = "";
  process.env.AI_REVIEW_MODEL = "";
  process.env.OPENAI_API_KEY = "test-server-key";
  process.env.OPENAI_BASE_URL = upstream.url;
  const app = await startApp();
  try {
    const chatBody = { action: "start", topic: "二分查找", level: "初学", goal: "理解边界", messages: [{ role: "user", content: "开始学习" }] };
    // SSE 流：响应头已发，失败只能用 error 事件，不能改 HTTP 状态。
    const res = await fetch(`${app.base}/api/chat`, { method: "POST", headers: chatHeaders, body: JSON.stringify(chatBody) });
    assert.equal(isEventStream(res), true);
    const error = errorOf(await readChatStream(res));
    assert.ok(error.status >= 500);
    assert.equal(typeof error.body.error, "string");

    // 旧 JSON 路径：同样失败应得到同一套公开字段（status 之外逐字段一致）。
    const legacy = await fetch(`${app.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zhixu-Request": "1" },
      body: JSON.stringify(chatBody),
    });
    assert.equal(legacy.status, error.status);
    const legacyBody = (await legacy.json()) as Record<string, unknown>;
    const { status: _status, ...streamError } = error.body;
    assert.deepEqual(streamError, legacyBody, "SSE error 事件复用 publicErrorPayload，不另造口径");
    // 上游返回体可以带诊断文本，但个人密钥绝不能回显到任何一种响应。
    assert.doesNotMatch(JSON.stringify(streamError), /test-server-key/);
    assert.doesNotMatch(JSON.stringify(legacyBody), /test-server-key/);
  } finally {
    await app.close();
    await upstream.close();
    restoreEnv(saved);
  }
});

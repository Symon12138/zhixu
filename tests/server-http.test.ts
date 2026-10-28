import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import type { QuizQuestion } from "../src/types";
import { ApiError } from "../server/ai";
import { BookContextError } from "../server/books";
import {
  BODY_LIMIT,
  HttpError,
  assertAllowedModelEndpoints,
  parseProviderSettings,
  writeErrorResponse,
} from "../server/http";
import { LearningProtocolError } from "../server/learning";
import { TeachingQualityError } from "../server/tutor";
import { searchProvidersFromSettings } from "../server/webSearch";
import {
  DIAGNOSTIC_QUESTION_COUNT,
  selectDiagnosticQuestions,
} from "../server/diagnostic";

interface StubResponse {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  req?: { requestId?: string };
  status(code: number): StubResponse;
  json(body: unknown): StubResponse;
}

function stubResponse(
  overrides: Partial<
    Pick<StubResponse, "headersSent" | "writableEnded" | "destroyed">
  > & { requestId?: string } = {},
): { res: Response; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {};
  const res: StubResponse = {
    headersSent: overrides.headersSent ?? false,
    writableEnded: overrides.writableEnded ?? false,
    destroyed: overrides.destroyed ?? false,
    ...(overrides.requestId === undefined
      ? {}
      : { req: { requestId: overrides.requestId } }),
    status(code) {
      state.status = code;
      return res;
    },
    json(body) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error;
  }
  assert.fail("预期抛出 ApiError");
}

/** 捕获 writeErrorResponse 的单行 JSON 日志；测试结束恢复 console.error。 */
function captureErrorLogs(fn: () => void): Array<Record<string, unknown>> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
    // logErrorResponse 的序列化结果，字段由本文件断言覆盖。
    return parsed as Record<string, unknown>;
  });
}

test("settings：缺省或 null 表示走环境变量配置", () => {
  assert.equal(parseProviderSettings(undefined), undefined);
  assert.equal(parseProviderSettings(null), undefined);
});

test("settings：合法值被规范化，不丢失结构化输出与思考等级", () => {
  assert.deepEqual(
    parseProviderSettings({
      provider: "openai",
      apiKey: "sk-test",
      model: " glm-4.6 ",
      baseUrl: "https://example.test/v1",
      structuredOutput: false,
      thinkingLevel: "high",
    }),
    {
      provider: "openai",
      apiKey: "sk-test",
      model: " glm-4.6 ",
      baseUrl: "https://example.test/v1",
      structuredOutput: false,
      thinkingLevel: "high",
    },
  );
  assert.deepEqual(parseProviderSettings({ provider: "gemini" }), {
    provider: "gemini",
    apiKey: "",
    model: "",
    baseUrl: "",
  });
});

test("settings：非法 provider 直接 400，不回退到环境密钥", () => {
  for (const provider of [undefined, "glm", "OPENAI", "", 1, null]) {
    const error = apiError(() => parseProviderSettings({ provider }));
    assert.equal(error.status, 400);
    assert.match(error.message, /provider/);
  }
});

test("settings：非法 thinkingLevel 直接 400", () => {
  for (const thinkingLevel of ["max", "medium ", 1, true]) {
    const error = apiError(() =>
      parseProviderSettings({ provider: "gemini", thinkingLevel }),
    );
    assert.equal(error.status, 400);
    assert.match(error.message, /thinkingLevel/);
  }
});

test("settings：非法 apiKey / baseUrl / model 类型直接 400", () => {
  for (const [key, value] of [
    ["apiKey", 123],
    ["apiKey", { secret: "x" }],
    ["baseUrl", 42],
    ["baseUrl", ["https://example.test"]],
    ["model", 7],
    ["baseUrl", ""],
    ["model", "   "],
    ["apiKey", "k".repeat(4001)],
    ["baseUrl", `https://example.test/${"a".repeat(2000)}`],
  ] as const) {
    const error = apiError(() =>
      parseProviderSettings({ provider: "openai", [key]: value }),
    );
    assert.equal(error.status, 400, `settings.${key} 应被拒绝`);
    assert.match(error.message, new RegExp(key));
  }
});

test("settings：搜索供应商与密钥被独立解析，非法值直接 400", () => {
  assert.deepEqual(
    parseProviderSettings({
      provider: "openai",
      searchProvider: "brave",
      searchApiKey: " search-key ",
    }),
    {
      provider: "openai",
      apiKey: "",
      model: "",
      baseUrl: "",
      searchProvider: "brave",
      searchApiKey: "search-key",
    },
  );
  for (const searchProvider of ["google", "searxng", 1, true, null]) {
    const error = apiError(() =>
      parseProviderSettings({ provider: "openai", searchProvider }),
    );
    assert.equal(error.status, 400);
    assert.match(error.message, /searchProvider/);
  }
  for (const searchApiKey of [123, { key: "x" }, "k".repeat(4001)]) {
    const error = apiError(() =>
      parseProviderSettings({ provider: "openai", searchApiKey }),
    );
    assert.equal(error.status, 400);
    assert.match(error.message, /searchApiKey/);
  }
});

test("settings：备用模型与备用搜索按顺序解析并限制数量", () => {
  const parsed = parseProviderSettings({
    provider: "openai",
    apiKey: "primary-key",
    model: "primary-model",
    baseUrl: "https://example.test/v1",
    searchProvider: "tavily",
    searchApiKey: "primary-search",
    modelFallbacks: [{
      provider: "gemini",
      model: "gemini-2.5-flash",
      baseUrl: "",
      apiKey: "fallback-model-key",
      thinkingLevel: "low",
    }],
    searchFallbacks: [{ provider: "brave", apiKey: "fallback-search" }],
  });
  assert.equal(parsed?.modelFallbacks?.[0].provider, "gemini");
  assert.equal(parsed?.modelFallbacks?.[0].apiKey, "fallback-model-key");
  assert.equal(parsed?.searchFallbacks?.[0].provider, "brave");
  assert.equal(parsed?.searchFallbacks?.[0].apiKey, "fallback-search");
  for (const key of ["modelFallbacks", "searchFallbacks"] as const) {
    const error = apiError(() =>
      parseProviderSettings({ provider: "openai", [key]: key === "modelFallbacks" ? Array(4).fill({}) : Array(6).fill({}) }),
    );
    assert.equal(error.status, 400);
    assert.match(error.message, new RegExp(key));
  }
});

test("settings：structuredOutput 必须是布尔值，settings 本身必须是对象", () => {
  const flagError = apiError(() =>
    parseProviderSettings({ provider: "gemini", structuredOutput: "yes" }),
  );
  assert.equal(flagError.status, 400);
  assert.match(flagError.message, /structuredOutput/);

  for (const value of [[], "settings", 1]) {
    const error = apiError(() => parseProviderSettings(value));
    assert.equal(error.status, 400);
    assert.match(error.message, /settings/);
  }
});

test("错误映射：TeachingQualityError 保留 422/504、code 与公开 issues", () => {
  const issues = [
    { code: "answer_revealed", detail: "秘密答案 42 已泄露" },
    { code: "review_missing", detail: "评审原始细节" },
  ];
  const unprocessable = stubResponse();
  writeErrorResponse(
    unprocessable.res,
    new TeachingQualityError(422, "TEACHING_QUALITY", issues, "质量未通过"),
  );
  assert.equal(unprocessable.state.status, 422);
  assert.deepEqual(unprocessable.state.body, {
    error: "质量未通过",
    code: "TEACHING_QUALITY",
    issues: [
      {
        code: "answer_revealed",
        detail: "本轮讲解或判定过早给出了未解出的结果，已拦截且未推进学习。",
      },
      {
        code: "review_missing",
        detail: "独立评审的结果或格式未通过检查，本轮草稿未发布。",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(unprocessable.state.body),
    /秘密答案|评审原始细节/,
  );

  const timedOut = stubResponse();
  writeErrorResponse(
    timedOut.res,
    new TeachingQualityError(504, "TURN_TIMEOUT", [], "整轮超时"),
  );
  assert.equal(timedOut.state.status, 504);
  assert.deepEqual(timedOut.state.body, {
    error: "整轮超时",
    code: "TURN_TIMEOUT",
    issues: [],
  });
});

test("错误映射：LearningProtocolError → 422 且不回显协议细节", () => {
  const outcome = stubResponse();
  writeErrorResponse(
    outcome.res,
    new LearningProtocolError([
      { code: "missing_question_field", detail: "内部协议字段缺失" },
    ]),
  );
  assert.equal(outcome.state.status, 422);
  assert.deepEqual(outcome.state.body, {
    error: "教学内容与服务端约定不符，本轮未提交任何进度。",
    code: "TEACHING_PROTOCOL",
    issues: [
      {
        code: "missing_question_field",
        detail: "本轮教学内容或理解证据尚未满足发布条件，未提交学习进度。",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(outcome.state.body),
    /内部协议字段缺失/,
  );
});

test("错误映射：BookContextError / ApiError 保留原状态与说明", () => {
  const book = stubResponse();
  writeErrorResponse(book.res, new BookContextError("书籍上下文不合法"));
  assert.equal(book.state.status, 400);
  assert.deepEqual(book.state.body, { error: "书籍上下文不合法" });

  const api = stubResponse();
  writeErrorResponse(api.res, new ApiError(502, "上游失败"));
  assert.equal(api.state.status, 502);
  assert.deepEqual(api.state.body, { error: "上游失败" });
});

test("错误映射：未知异常 500 且不泄露内部信息或密钥", () => {
  const outcome = stubResponse();
  writeErrorResponse(outcome.res, new Error("apiKey=sk-secret 数据库连接串"));
  assert.equal(outcome.state.status, 500);
  assert.deepEqual(outcome.state.body, { error: "服务器内部错误，请稍后重试。" });
  assert.doesNotMatch(JSON.stringify(outcome.state.body), /sk-secret|数据库/);
});

test("错误映射：请求体过大与非法 JSON 使用统一中文提示", () => {
  const tooLarge = stubResponse();
  writeErrorResponse(tooLarge.res, { type: "entity.too.large" });
  assert.equal(tooLarge.state.status, 413);
  assert.deepEqual(tooLarge.state.body, {
    error: `请求体过大，最大允许 ${BODY_LIMIT}。`,
  });

  const malformed = stubResponse();
  writeErrorResponse(malformed.res, { type: "entity.parse.failed" });
  assert.equal(malformed.state.status, 400);
  assert.deepEqual(malformed.state.body, {
    error: "请求体不是合法的 JSON。",
  });
});

test("错误映射：连接已断开或响应已发出时不再写响应", () => {
  for (const overrides of [
    { destroyed: true },
    { writableEnded: true },
    { headersSent: true },
  ]) {
    const outcome = stubResponse(overrides);
    writeErrorResponse(outcome.res, new ApiError(400, "不应写入"));
    assert.equal(outcome.state.status, undefined);
    assert.equal(outcome.state.body, undefined);
  }
});

test("BYOK 端点策略：官方 OpenAI 默认地址始终允许，第三方端点需要白名单", () => {
  const official = parseProviderSettings({
    provider: "openai",
    apiKey: "sk-personal",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.ok(official);
  assert.doesNotThrow(() => assertAllowedModelEndpoints(official, []));

  const defaultBase = parseProviderSettings({
    provider: "openai",
    apiKey: "sk-personal",
    model: "gpt-4o-mini",
  });
  assert.ok(defaultBase);
  assert.doesNotThrow(() => assertAllowedModelEndpoints(defaultBase, []));

  const custom = parseProviderSettings({
    provider: "openai",
    apiKey: "sk-personal",
    model: "gpt-4o-mini",
    baseUrl: "https://relay.example.test/v1",
  });
  assert.ok(custom);
  let denied: unknown;
  try {
    assertAllowedModelEndpoints(custom, []);
  } catch (error) {
    denied = error;
  }
  assert.ok(denied instanceof HttpError);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "byok_endpoint_not_allowed");
  assert.match(denied.message, /ZHIXU_BYOK_BASEURLS/);
  assert.match(denied.message, /官方 OpenAI 端点/);

  assert.doesNotThrow(() =>
    assertAllowedModelEndpoints(custom, ["https://relay.example.test"]),
  );

  const gemini = parseProviderSettings({
    provider: "gemini",
    apiKey: "gemini-key",
    model: "gemini-2.5-flash",
    baseUrl: "https://relay.example.test/v1",
  });
  assert.ok(gemini);
  assert.doesNotThrow(() => assertAllowedModelEndpoints(gemini, []));

  const fallback = parseProviderSettings({
    provider: "gemini",
    apiKey: "gemini-key",
    modelFallbacks: [{
      provider: "openai",
      apiKey: "sk-fallback",
      model: "gpt-4o-mini",
      baseUrl: "https://fallback.example.test/v1",
    }],
  });
  assert.ok(fallback);
  assert.throws(() => assertAllowedModelEndpoints(fallback, []), /ZHIXU_BYOK_BASEURLS/);

  // 空 Key 的备用模型不会参与请求，也不应因其自定义地址而触发白名单拒绝。
  const ignoredFallback = parseProviderSettings({
    provider: "openai",
    apiKey: "sk-personal",
    modelFallbacks: [{
      provider: "openai",
      apiKey: "  ",
      model: "gpt-4o-mini",
      baseUrl: "https://ignored.example.test/v1",
    }],
  });
  assert.ok(ignoredFallback);
  assert.doesNotThrow(() => assertAllowedModelEndpoints(ignoredFallback, []));
});

test("设置语义：空 Key 的备用搜索不生效，显式 You.com 可免 Key", () => {
  assert.deepEqual(
    searchProvidersFromSettings({
      searchProvider: "tavily",
      searchApiKey: "",
      searchFallbacks: [{ provider: "brave", apiKey: "  " }],
    }),
    [],
  );
  const you = searchProvidersFromSettings({ searchProvider: "you", searchApiKey: "" });
  assert.equal(you.length, 1);
  assert.equal(you[0]?.vendor, "you");
  assert.equal(you[0]?.key, "");
  assert.equal(you[0]?.base, "https://api.you.com");
  assert.deepEqual(
    searchProvidersFromSettings({
      searchProvider: "tavily",
      searchApiKey: "tvly-key",
      searchFallbacks: [{ provider: "you", apiKey: "" }],
    }).map((provider) => provider.vendor),
    ["tavily", "you"],
  );
});

test("错误日志：5xx 模型失败带 requestId、错误类别与上游状态且不泄露密钥", () => {
  const outcome = stubResponse({ requestId: "trace-12345678" });
  const error = new ApiError(
    502,
    "AI 服务返回错误（HTTP 401）：apiKey=sk-secret Bearer abcdefghijkl",
    { code: "upstream_auth", upstreamStatus: 401 },
  );
  const logs = captureErrorLogs(() => writeErrorResponse(outcome.res, error));
  assert.equal(logs.length, 1);
  const record = logs[0];
  assert.equal(record.requestId, "trace-12345678");
  assert.equal(record.level, "error");
  assert.equal(record.event, "http.error");
  assert.equal(record.errorType, "upstream_auth");
  assert.equal(record.httpStatus, 502);
  assert.equal(record.upstreamStatus, 401);
  assert.equal(typeof record.ts, "number");
  assert.equal("stack" in record, false);
  assert.match(String(record.message), /\[redacted\]/);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /sk-secret|abcdefghijkl/);
  // 客户端仍得到原有的 502，不因日志改变错误映射。
  assert.equal(outcome.state.status, 502);
});

test("错误日志：普通 4xx 不记录，未知 500 只记录脱敏摘要", () => {
  const invalid = stubResponse({ requestId: "trace-4xx" });
  const ignored = captureErrorLogs(() =>
    writeErrorResponse(invalid.res, new ApiError(400, "settings 不合法")),
  );
  assert.deepEqual(ignored, []);

  const internal = stubResponse({ requestId: "trace-500" });
  const logs = captureErrorLogs(() =>
    writeErrorResponse(internal.res, new Error("apiKey=sk-super-secret 数据库连接失败")),
  );
  assert.equal(logs.length, 1);
  const record = logs[0];
  assert.equal(record.requestId, "trace-500");
  assert.equal(record.errorType, "internal");
  assert.equal(record.httpStatus, 500);
  assert.equal("upstreamStatus" in record, false);
  assert.equal("stack" in record, false);
  assert.doesNotMatch(JSON.stringify(record), /sk-super-secret/);
});

function quizQuestion(id: string, correctIndex: number): QuizQuestion {
  return {
    id,
    question: `问题 ${id}`,
    options: ["甲", "乙", "丙"],
    correctIndex,
    explanation: `解析 ${id}`,
    hint: `提示 ${id}`,
  };
}

test("诊断限 3 题：按原顺序截取，不随机、不改正确项", () => {
  const quiz = [
    quizQuestion("a", 2),
    quizQuestion("b", 0),
    quizQuestion("c", 1),
    quizQuestion("d", 2),
    quizQuestion("e", 0),
  ];
  const selected = selectDiagnosticQuestions(quiz);
  assert.equal(selected.length, DIAGNOSTIC_QUESTION_COUNT);
  assert.deepEqual(
    selected.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    selected.map((item) => item.correctIndex),
    [2, 0, 1],
  );
  assert.equal(selected[0], quiz[0]);
  // 原始列表不被修改。
  assert.equal(quiz.length, 5);
});

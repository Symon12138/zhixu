import type { Response } from "express";
import type { ModelFallback, ProviderSettings, SearchFallback, SearchProviderId, ThinkingLevel } from "../src/types";
import { ApiError } from "./ai";
import { BookContextError } from "./books";
import { LearningProtocolError } from "./learning";
import { publicTeachingIssues } from "./protocol";
import { TeachingQualityError } from "./tutor";

/** 全站请求体上限；错误信息与 express.json 必须使用同一个值。 */
export const BODY_LIMIT = "1mb";

/**
 * 认证/工作区/额度等 HTTP 层错误：状态码 + 稳定错误码 + 可公开的附加字段。
 * 与 ApiError 分开，避免把内部异常细节泄给客户端；details 只放调用方明确公开的数据。
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    options: { code?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (options.code) this.code = options.code;
    if (options.details) this.details = options.details;
  }
}

const THINKING_LEVELS: ThinkingLevel[] = ["auto", "low", "medium", "high"];
const SEARCH_PROVIDERS: SearchProviderId[] = ["tavily", "brave", "exa", "firecrawl", "deepseek", "you"];

/**
 * 解析前端传入的模型设置。provider 与各字段类型必须完全合法：
 * 非法值直接 400，绝不交给 resolveConfig 猜测后再静默回退到环境变量密钥。
 */
export function parseProviderSettings(
  value: unknown,
): ProviderSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "settings 必须是对象。");
  }
  const s = value as Record<string, unknown>;
  const provider = s.provider;
  if (provider !== "gemini" && provider !== "openai") {
    throw new ApiError(400, "settings.provider 必须是 gemini 或 openai。");
  }
  if (
    s.structuredOutput !== undefined &&
    typeof s.structuredOutput !== "boolean"
  ) {
    throw new ApiError(400, "settings.structuredOutput 必须是布尔值。");
  }
  for (const [key, max] of [
    ["apiKey", 4000],
    ["model", 300],
    ["baseUrl", 2000],
  ] as const) {
    if (
      s[key] !== undefined &&
      (typeof s[key] !== "string" || (s[key] as string).length > max)
    ) {
      throw new ApiError(
        400,
        `settings.${key} 必须是长度不超过${max}的字符串。`,
      );
    }
  }
  if (s.model !== undefined && !(s.model as string).trim()) {
    throw new ApiError(400, "settings.model 不能为空。");
  }
  if (s.baseUrl !== undefined && !(s.baseUrl as string).trim()) {
    throw new ApiError(400, "settings.baseUrl 不能为空。");
  }
  const thinkingLevel = s.thinkingLevel;
  if (
    thinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)
  ) {
    throw new ApiError(
      400,
      "settings.thinkingLevel 必须是 auto、low、medium 或 high。",
    );
  }
  const searchProvider = s.searchProvider;
  if (
    searchProvider !== undefined &&
    !SEARCH_PROVIDERS.includes(searchProvider as SearchProviderId)
  ) {
    throw new ApiError(400, "settings.searchProvider 不是支持的搜索供应商。");
  }
  if (
    s.searchApiKey !== undefined &&
    (typeof s.searchApiKey !== "string" || s.searchApiKey.length > 4000)
  ) {
    throw new ApiError(400, "settings.searchApiKey 必须是长度不超过4000的字符串。");
  }

  const parseModelFallback = (raw: unknown, index: number): ModelFallback => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, `settings.modelFallbacks[${index}] 必须是对象。`);
    }
    const item = raw as Record<string, unknown>;
    if (item.provider !== "gemini" && item.provider !== "openai") {
      throw new ApiError(400, `settings.modelFallbacks[${index}].provider 无效。`);
    }
    if (typeof item.model !== "string" || !item.model.trim() || item.model.length > 300) {
      throw new ApiError(400, `settings.modelFallbacks[${index}].model 无效。`);
    }
    if (typeof item.baseUrl !== "string" || item.baseUrl.length > 2000) {
      throw new ApiError(400, `settings.modelFallbacks[${index}].baseUrl 无效。`);
    }
    if (item.apiKey !== undefined && (typeof item.apiKey !== "string" || item.apiKey.length > 4000)) {
      throw new ApiError(400, `settings.modelFallbacks[${index}].apiKey 无效。`);
    }
    if (item.structuredOutput !== undefined && typeof item.structuredOutput !== "boolean") {
      throw new ApiError(400, `settings.modelFallbacks[${index}].structuredOutput 无效。`);
    }
    if (item.thinkingLevel !== undefined && !THINKING_LEVELS.includes(item.thinkingLevel as ThinkingLevel)) {
      throw new ApiError(400, `settings.modelFallbacks[${index}].thinkingLevel 无效。`);
    }
    return {
      provider: item.provider,
      model: item.model.trim(),
      baseUrl: item.baseUrl.trim(),
      ...(item.apiKey === undefined ? {} : { apiKey: (item.apiKey as string).trim() }),
      ...(item.structuredOutput === undefined ? {} : { structuredOutput: item.structuredOutput as boolean }),
      ...(item.thinkingLevel === undefined ? {} : { thinkingLevel: item.thinkingLevel as ThinkingLevel }),
    };
  };

  const parseSearchFallback = (raw: unknown, index: number): SearchFallback => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, `settings.searchFallbacks[${index}] 必须是对象。`);
    }
    const item = raw as Record<string, unknown>;
    if (!SEARCH_PROVIDERS.includes(item.provider as SearchProviderId)) {
      throw new ApiError(400, `settings.searchFallbacks[${index}].provider 无效。`);
    }
    if (item.apiKey !== undefined && (typeof item.apiKey !== "string" || item.apiKey.length > 4000)) {
      throw new ApiError(400, `settings.searchFallbacks[${index}].apiKey 无效。`);
    }
    return {
      provider: item.provider as SearchProviderId,
      ...(item.apiKey === undefined ? {} : { apiKey: (item.apiKey as string).trim() }),
    };
  };

  let modelFallbacks: ModelFallback[] = [];
  if (s.modelFallbacks !== undefined) {
    if (!Array.isArray(s.modelFallbacks) || s.modelFallbacks.length > 2) {
      throw new ApiError(400, "settings.modelFallbacks 必须是最多2项的数组。");
    }
    modelFallbacks = s.modelFallbacks.map(parseModelFallback);
  }
  let searchFallbacks: SearchFallback[] = [];
  if (s.searchFallbacks !== undefined) {
    if (!Array.isArray(s.searchFallbacks) || s.searchFallbacks.length > 5) {
      throw new ApiError(400, "settings.searchFallbacks 必须是最多5项的数组。");
    }
    searchFallbacks = s.searchFallbacks.map(parseSearchFallback);
  }

  return {
    provider,
    apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
    model: typeof s.model === "string" ? s.model : "",
    baseUrl: typeof s.baseUrl === "string" ? s.baseUrl : "",
    ...(searchProvider === undefined
      ? {}
      : { searchProvider: searchProvider as SearchProviderId }),
    ...(s.searchApiKey === undefined
      ? {}
      : { searchApiKey: (s.searchApiKey as string).trim() }),
    ...(modelFallbacks.length ? { modelFallbacks } : {}),
    ...(searchFallbacks.length ? { searchFallbacks } : {}),
    ...(s.structuredOutput === undefined
      ? {}
      : { structuredOutput: s.structuredOutput as boolean }),
    ...(thinkingLevel === undefined
      ? {}
      : { thinkingLevel: thinkingLevel as ThinkingLevel }),
  };
}

/** 官方 OpenAI 端点：BYOK 默认 baseUrl 指向这里，不能因为白名单为空而被永久拒绝。 */
const OFFICIAL_OPENAI_ORIGIN = "https://api.openai.com";
const OFFICIAL_OPENAI_BASE_URL = `${OFFICIAL_OPENAI_ORIGIN}/v1`;

/**
 * 带个人 Key 的 OpenAI 兼容端点必须在部署白名单内；Gemini 使用固定官方端点。
 * 空 baseUrl 与前端默认值使用官方 OpenAI 端点，始终允许；第三方兼容端点才需要
 * ZHIXU_BYOK_BASEURLS，避免“空白名单”把唯一可用的官方端点也一起拒掉。
 */
export function assertAllowedModelEndpoints(
  settings: ProviderSettings,
  allowedOrigins: readonly string[],
): void {
  const models = [
    ...(settings.apiKey
      ? [{ provider: settings.provider, baseUrl: settings.baseUrl }]
      : []),
    ...(settings.modelFallbacks ?? [])
      .filter((item) => item.apiKey)
      .map((item) => ({ provider: item.provider, baseUrl: item.baseUrl })),
  ];
  for (const model of models) {
    if (model.provider !== "openai") continue;
    const rawBaseUrl = model.baseUrl.trim() || OFFICIAL_OPENAI_BASE_URL;
    let origin = "";
    try {
      origin = new URL(rawBaseUrl).origin;
    } catch {
      origin = "";
    }
    if (origin === OFFICIAL_OPENAI_ORIGIN || allowedOrigins.includes(origin)) {
      continue;
    }
    const hint =
      allowedOrigins.length === 0
        ? "当前部署未配置 ZHIXU_BYOK_BASEURLS，只允许官方 OpenAI 端点。请管理员把该兼容端点 origin 加入该变量后再试。"
        : "该自定义模型地址不在部署白名单内。请联系管理员把该兼容端点 origin 加入 ZHIXU_BYOK_BASEURLS，或改用官方 OpenAI 端点。";
    throw new HttpError(403, hint, { code: "byok_endpoint_not_allowed" });
  }
}

export interface ClientAbort {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * 客户端断开（res close）时中止上游模型请求，避免继续计费与等待。
 * 正常写完响应后 close 也会触发，但 writableEnded 已为 true，不会中止。
 */
export function abortOnClientClose(res: Response): ClientAbort {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  return {
    signal: controller.signal,
    dispose: () => res.off("close", onClose),
  };
}

/** 把 body-parser 的字节上限格式化成用户可读的中文单位。 */
function formatBodyLimit(limit: unknown): string {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return BODY_LIMIT;
  }
  if (limit >= 1024 * 1024) {
    const mb = limit / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(limit / 1024))} KB`;
}

/** 错误日志脱敏：只处理错误摘要，绝不记录请求体、提示词、对话正文或密钥。 */
function sanitizeLogMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(
      /(api[-_]?key|password|passwd|secret|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi,
      "$1$2[redacted]",
    )
    .replace(
      /("(?:apiKey|searchApiKey|api_key|password|token)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** 与下方响应分支保持一致；仅用于日志分类，不改变响应体。 */
function errorResponseStatus(error: unknown): number {
  if (error instanceof TeachingQualityError) return error.status;
  if (error instanceof LearningProtocolError) return 422;
  if (error instanceof BookContextError) return 400;
  if (error instanceof HttpError) return error.status;
  if (error instanceof ApiError) return error.status;
  const anyErr = typeof error === "object" && error !== null ? error : undefined;
  if (anyErr && "type" in anyErr && anyErr.type === "entity.too.large") return 413;
  if (anyErr && "type" in anyErr && anyErr.type === "entity.parse.failed") return 400;
  return 500;
}

function errorLogType(error: unknown): string {
  if (error instanceof TeachingQualityError) return error.code || "teaching_quality";
  if (error instanceof LearningProtocolError) return "teaching_protocol";
  if (error instanceof BookContextError) return "book_context";
  if (error instanceof HttpError) return error.code || "http";
  if (error instanceof ApiError) return error.code || "model";
  const anyErr = typeof error === "object" && error !== null ? error : undefined;
  if (anyErr && "type" in anyErr && anyErr.type === "entity.too.large") {
    return "request_too_large";
  }
  if (anyErr && "type" in anyErr && anyErr.type === "entity.parse.failed") {
    return "invalid_json";
  }
  return "internal";
}

function errorLogMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  const anyErr = typeof error === "object" && error !== null ? error : undefined;
  if (anyErr && "type" in anyErr && anyErr.type === "entity.too.large") {
    return "request body too large";
  }
  if (anyErr && "type" in anyErr && anyErr.type === "entity.parse.failed") {
    return "invalid JSON body";
  }
  return "unknown error";
}

function isModelFailure(error: unknown, status: number): boolean {
  if (!(error instanceof ApiError)) return false;
  const code = error.code ?? "";
  return (
    status >= 500 ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    error.upstreamStatus !== undefined ||
    code.startsWith("upstream_")
  );
}

/**
 * 5xx 与模型失败统一输出单行 JSON：requestId 可串联响应头，errorType 是稳定类别，
 * upstreamStatus 只在确属上游 HTTP 响应时出现。不输出 stack、提示或密钥。
 * 不依赖 NODE_ENV，非 Docker 的 `npm start` 同样能看到生产错误日志。
 */
function logErrorResponse(res: Response, error: unknown, status: number): void {
  if (status < 500 && !isModelFailure(error, status)) return;
  const requestId = res.req?.requestId ?? "unknown";
  const record: Record<string, unknown> = {
    ts: Date.now(),
    requestId,
    level: "error",
    event: "http.error",
    errorType: errorLogType(error),
    httpStatus: status,
  };
  if (error instanceof ApiError && error.upstreamStatus !== undefined) {
    record.upstreamStatus = error.upstreamStatus;
  }
  record.message = sanitizeLogMessage(errorLogMessage(error));
  console.error(JSON.stringify(record));
}

/**
 * 统一错误映射，三条模型路由与 express 错误中间件共用：
 * - TeachingQualityError 保留原 status（422/504）、code 与公开 issues；
 * - LearningProtocolError → 422，不发布草稿细节；
 * - BookContextError / HttpError / ApiError 保留既有状态与稳定错误码；
 * - 其他未知异常 → 不泄密的 500。
 * 连接已断开或响应已发出时绝不再次写响应。
 */
export function writeErrorResponse(res: Response, error: unknown): void {
  const status = errorResponseStatus(error);
  logErrorResponse(res, error, status);
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  if (error instanceof TeachingQualityError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      issues: publicTeachingIssues(error.issues),
    });
    return;
  }
  if (error instanceof LearningProtocolError) {
    res.status(422).json({
      error: "教学内容与服务端约定不符，本轮未提交任何进度。",
      code: "TEACHING_PROTOCOL",
      issues: publicTeachingIssues(error.issues),
    });
    return;
  }
  if (error instanceof BookContextError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof HttpError) {
    const body: Record<string, unknown> = { error: error.message };
    if (error.code) body.code = error.code;
    if (error.details) {
      for (const [key, value] of Object.entries(error.details)) {
        if (key !== "error" && key !== "code") body[key] = value;
      }
    }
    res.status(error.status).json(body);
    return;
  }
  if (error instanceof ApiError) {
    const body: Record<string, unknown> = { error: error.message };
    if (error.code) body.code = error.code;
    res.status(error.status).json(body);
    return;
  }
  const anyErr = error as { type?: unknown; limit?: unknown } | undefined;
  if (anyErr && typeof anyErr === "object") {
    if (anyErr.type === "entity.too.large") {
      res.status(413).json({
        error: `请求体过大，最大允许 ${formatBodyLimit(anyErr.limit)}。`,
      });
      return;
    }
    if (anyErr.type === "entity.parse.failed") {
      res.status(400).json({ error: "请求体不是合法的 JSON。" });
      return;
    }
  }
  // 未知异常不回显任何内容，避免泄漏内部信息或密钥。
  res.status(500).json({ error: "服务器内部错误，请稍后重试。" });
}

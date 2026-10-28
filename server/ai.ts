import type {
  ChatRequest,
  ChatResponse,
  Provider,
  ProviderSettings,
  ThinkingLevel,
} from "../src/types";
import {
  runTeachingTurn,
  type ModelInvoker,
  type ModelInvocation,
} from "./tutor";
import { getModelCallTimeoutMs, getModelMaxOutputTokens, modelTimingEnabled } from "./modelLimits";
import { buildWebSearchQuery, searchProvidersFromSettings, searchWebEvidence, WebSearchError, webSearchEnabled } from "./webSearch";

const GEMINI_DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

export interface ResolvedConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string;
  /** 原生 JSON 输出开关：Gemini 用 responseMimeType，OpenAI 兼容用 response_format。 */
  structuredOutput: boolean;
  thinkingLevel: ThinkingLevel;
}

/** 兼容服务不支持原生 JSON 时的恢复提示（出现在上游 HTTP 错误信息中，不回显密钥）。 */
const STRUCTURED_OUTPUT_HINT =
  "若该服务不支持原生 JSON 输出，可在「模型与设置」中取消勾选原生 JSON（或在服务端设置 AI_STRUCTURED_OUTPUT=false）后重试。";
const THINKING_LEVEL_HINT =
  "若该模型不支持指定思考等级，可在「模型与设置」中把思考等级调回「自动」后重试。";

export class ApiError extends Error {
  status: number;
  /** 稳定错误码：客户端与日志据此区分本地参数错误与上游故障，不依赖状态码猜测。 */
  code?: string;
  /** 上游真实 HTTP 状态；仅上游响应错误携带，本地配置/网络错误为 undefined。 */
  upstreamStatus?: number;

  constructor(
    status: number,
    message: string,
    options: { code?: string; upstreamStatus?: number } = {},
  ) {
    super(message);
    this.status = status;
    if (options.code) this.code = options.code;
    if (options.upstreamStatus !== undefined) {
      this.upstreamStatus = options.upstreamStatus;
    }
  }
}

/** 上游错误分类：只有认证、限流、连接/超时与 5xx 允许故障转移。 */
const UPSTREAM_FAILOVER_CODES: Record<string, true> = {
  upstream_auth: true,
  upstream_rate_limit: true,
  upstream_network: true,
  upstream_timeout: true,
  upstream_server: true,
};

function upstreamErrorCode(status: number): string {
  if (status === 401 || status === 403) return "upstream_auth";
  if (status === 429) return "upstream_rate_limit";
  if (status === 408) return "upstream_timeout";
  if (status === 404) return "upstream_not_found";
  if (status >= 400 && status < 500) return "upstream_bad_request";
  return "upstream_server";
}

function upstreamErrorStatus(status: number): number {
  // 上游 401/403 属于供应商凭据问题，绝不能伪装成用户登录过期；429 保留为限流。
  return status === 429 ? 429 : 502;
}

function upstreamErrorMessage(
  status: number,
  bodyText: string,
  config: ResolvedConfig,
): string {
  const reason = redactSecrets(bodyText, config.apiKey).slice(0, 500);
  const detail = reason ? `：${reason}` : "。";
  return `AI 服务返回错误（HTTP ${status}）${detail}${
    config.structuredOutput && status === 400 ? STRUCTURED_OUTPUT_HINT : ""
  }${config.thinkingLevel !== "auto" && status === 400 ? THINKING_LEVEL_HINT : ""}`;
}

/** 读取上游响应体；中途断开同样属于连接故障，必须保留可读原因并允许故障转移。 */
async function readUpstreamBody(
  response: Response,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new ApiError(
      502,
      `无法连接 AI 服务：${redactSecrets(String(error), config.apiKey)}`,
      { code: "upstream_network" },
    );
  }
}

/** 从任意错误文本中抹去密钥，避免上游错误信息泄密。 */
export function redactSecrets(
  text: string,
  ...secrets: (string | undefined)[]
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}
/**
 /**
  * 不发起网络请求的模型/搜索配置校验：与后续真实调用使用同一批本地规则，
  * 供路由在扣减额度前拒绝可预判的配置错误。
  */
 export function validateModelConfig(settings: ProviderSettings | undefined): void {
   const config = resolveConfig(settings);
   if (config.provider === "gemini") geminiThinkingConfig(config);
   else openAiThinkingConfig(config);
 }

 /** 校验 baseUrl：允许 HTTPS，HTTP 仅允许 localhost / 127.0.0.1 / [::1]；
 * 禁止 username/password/query/hash，避免密钥意外进入请求地址。
 */
export function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, `baseUrl 不是合法的 URL：${raw}`, { code: "invalid_config" });
  }
  if (url.username || url.password) {
    throw new ApiError(400, "baseUrl 不允许包含用户名或密码。", { code: "invalid_config" });
  }
  if (url.search || url.hash) {
    throw new ApiError(400, "baseUrl 不允许包含查询参数或片段。", { code: "invalid_config" });
  }
  if (url.protocol === "https:") return raw.replace(/\/+$/, "");
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1";
    if (!isLocal) {
      throw new ApiError(
        400,
        "出于安全考虑，HTTP 仅允许 localhost 地址，请使用 HTTPS。",
        { code: "invalid_config" },
      );
    }
    return raw.replace(/\/+$/, "");
  }
  throw new ApiError(400, `不支持的协议：${url.protocol}，请使用 HTTPS。`, { code: "invalid_config" });
}

function cleanEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const THINKING_LEVELS: ThinkingLevel[] = ["auto", "low", "medium", "high"];

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)
    ? value as ThinkingLevel
    : "auto";
}



/**
 * settings 优先，否则回退到 dotenv 注入的环境变量。
 * GEMINI_API_KEY / GEMINI_MODEL / GEMINI_BASE_URL / AI_STRUCTURED_OUTPUT
 * OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL
 * structuredOutput：settings 携带密钥时取 settings.structuredOutput !== false；
 * 走环境变量密钥时取 AI_STRUCTURED_OUTPUT=false 关闭；默认开启。
 */
export function resolveConfig(
  settings?: Partial<ProviderSettings> | null,
): ResolvedConfig {
  if (settings && typeof settings === "object") {
    const provider: Provider =
      settings.provider === "openai" ? "openai" : "gemini";
    const apiKey =
      typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
    if (apiKey) {
      if (provider === "gemini") {
        // 前端的 settings.baseUrl 是 OpenAI 兼容字段；Gemini 固定用官方地址，
        // 或仅从服务端环境变量 GEMINI_BASE_URL 覆盖，绝不采用 settings.baseUrl。
        return {
          provider,
          apiKey,
          model:
            typeof settings.model === "string" && settings.model.trim()
              ? settings.model.trim()
              : GEMINI_DEFAULT_MODEL,
          baseUrl: validateBaseUrl(
            cleanEnv(process.env.GEMINI_BASE_URL) || GEMINI_DEFAULT_BASE_URL,
          ),
          structuredOutput: settings.structuredOutput !== false,
          thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
        };
      }
      const model =
        typeof settings.model === "string" && settings.model.trim()
          ? settings.model.trim()
          : OPENAI_DEFAULT_MODEL;
      const baseUrl =
        typeof settings.baseUrl === "string" && settings.baseUrl.trim()
          ? validateBaseUrl(settings.baseUrl.trim())
          : OPENAI_DEFAULT_BASE_URL;
      return {
        provider,
        apiKey,
        model,
        baseUrl,
        structuredOutput: settings.structuredOutput !== false,
        thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
      };
    }
  }

  const geminiKey = cleanEnv(process.env.GEMINI_API_KEY);
  const openaiKey = cleanEnv(process.env.OPENAI_API_KEY);
  const structuredOutput =
    cleanEnv(process.env.AI_STRUCTURED_OUTPUT).toLowerCase() !== "false";
  const thinkingLevel = normalizeThinkingLevel(process.env.AI_THINKING_LEVEL);
  if (geminiKey) {
    return {
      provider: "gemini",
      apiKey: geminiKey,
      model: cleanEnv(process.env.GEMINI_MODEL) || GEMINI_DEFAULT_MODEL,
      baseUrl: validateBaseUrl(
        cleanEnv(process.env.GEMINI_BASE_URL) || GEMINI_DEFAULT_BASE_URL,
      ),
      structuredOutput,
      thinkingLevel,
    };
  }
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: cleanEnv(process.env.OPENAI_MODEL) || OPENAI_DEFAULT_MODEL,
      baseUrl: validateBaseUrl(
        cleanEnv(process.env.OPENAI_BASE_URL) || OPENAI_DEFAULT_BASE_URL,
      ),
      structuredOutput,
      thinkingLevel,
    };
  }
  throw new ApiError(
    400,
    "尚未配置 AI 服务：请在页面设置中填写 API Key，或在服务端环境变量中配置 GEMINI_API_KEY（或 OPENAI_API_KEY）。",
    { code: "not_configured" },
  );
}

/** 仅供 /api/config 使用：绝不返回 apiKey。 */
export function resolveEnvStatus(): {
  configured: boolean;
  provider: Provider;
  model: string;
} {
  const geminiKey = cleanEnv(process.env.GEMINI_API_KEY);
  const openaiKey = cleanEnv(process.env.OPENAI_API_KEY);
  if (geminiKey) {
    return {
      configured: true,
      provider: "gemini",
      model: cleanEnv(process.env.GEMINI_MODEL) || GEMINI_DEFAULT_MODEL,
    };
  }
  if (openaiKey) {
    return {
      configured: true,
      provider: "openai",
      model: cleanEnv(process.env.OPENAI_MODEL) || OPENAI_DEFAULT_MODEL,
    };
  }
  return { configured: false, provider: "gemini", model: GEMINI_DEFAULT_MODEL };
}

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

function geminiText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object" || !("candidates" in parsed)) {
    throw new ApiError(502, "AI 服务未返回任何候选内容，请重试。", { code: "upstream_malformed" });
  }
  const candidates = parsed.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!first || typeof first !== "object" || !("content" in first)) {
    throw new ApiError(502, "AI 服务返回了空内容，请重试。", { code: "upstream_malformed" });
  }
  const content = first.content;
  const parts =
    content && typeof content === "object" && "parts" in content
      ? content.parts
      : undefined;
  const text = Array.isArray(parts)
    ? parts
        .map((p: unknown) =>
          p !== null &&
          typeof p === "object" &&
          "text" in p &&
          typeof p.text === "string" &&
          (!("thought" in p) || p.thought !== true)
            ? p.text
            : "",
        )
        .join("")
    : "";
  if (!text.trim()) {
    throw new ApiError(502, "AI 服务返回了空内容，请重试。", { code: "upstream_malformed" });
  }
  return text;
}

function openaiText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object" || !("choices" in parsed)) {
    throw new ApiError(502, "AI 服务未返回任何候选内容，请重试。", { code: "upstream_malformed" });
  }
  const choices = parsed.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message =
    first && typeof first === "object" && "message" in first
      ? first.message
      : undefined;
  const rawContent = message && typeof message === "object" ? message.content : undefined;
  const content = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part: unknown) =>
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string" &&
          (!("type" in part) || part.type === "text")
            ? part.text
            : "",
        ).join("")
      : "";
  if (!content.trim()) {
    if (message && typeof message === "object" && "tool_calls" in message && Array.isArray(message.tool_calls) && message.tool_calls.length)
      throw new ApiError(502, "AI 服务请求了工具调用。本应用不使用工具，请关闭工具模式或更换支持直接文本回答的模型。", { code: "upstream_malformed" });
    throw new ApiError(502, "AI 服务返回了空内容，请重试。", { code: "upstream_malformed" });
  }
  return content;
}

const THINKING_BUDGETS = { low: 1024, medium: 4096, high: 8192 } as const;

function geminiThinkingConfig(config: ResolvedConfig): Record<string, unknown> {
  if (config.thinkingLevel === "auto") return {};
  if (/^gemini-2\.5(?:-|$)/i.test(config.model))
    return { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[config.thinkingLevel] } };
  if (/^gemini-(?:3(?:\.[1-9]\d*)?|4)(?:-|$)/i.test(config.model))
    return { thinkingConfig: { thinkingLevel: config.thinkingLevel } };
  throw new ApiError(400, "当前仅对已知 Gemini 模型族映射思考等级。此模型请使用「自动」，避免发送不支持的思考参数。", { code: "unsupported_thinking_level" });
}

function openAiThinkingConfig(config: ResolvedConfig): Record<string, unknown> {
  if (config.thinkingLevel === "auto") return {};
  const model = config.model.toLowerCase();
  if (/(?:^|[:/])glm-5\.3(?:-|$)/i.test(model)) {
    if (config.thinkingLevel === "medium")
      throw new ApiError(400, "GLM-5.3 系列不支持中等思考等级；请选择低、高或自动。", { code: "unsupported_thinking_level" });
    return { thinking: { type: "enabled" }, reasoning_effort: config.thinkingLevel };
  }
  if (/(?:^|[:/])glm-5\.2(?:-|$)/i.test(model))
    return { thinking: { type: "enabled" }, reasoning_effort: config.thinkingLevel };
  if (/(?:^|[:/])glm-5(?:\.1)?(?:-|$)/i.test(model))
    throw new ApiError(400, "GLM-5/5.1 不支持 reasoning_effort 强度控制；请使用「自动」，由模型决定思考方式。", { code: "unsupported_thinking_level" });
  if (/(?:^|[:/])glm-4\.[6-9](?:-|$)/i.test(model))
    throw new ApiError(400, "GLM-4.x 官方仅支持 thinking.type 开关，不支持 reasoning_effort；请使用「自动」。", { code: "unsupported_thinking_level" });
  return { reasoning_effort: config.thinkingLevel };
}

async function callGemini(
  config: ResolvedConfig,
  system: string,
  history: HistoryTurn[],
  signal: AbortSignal,
  temperature: number,
): Promise<string> {
  const url = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`;
  const contents = history.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content }],
  }));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature,
          ...(config.structuredOutput
            ? { responseMimeType: "application/json" }
            : {}),
          ...geminiThinkingConfig(config),
        }
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal.aborted) throw signal.reason ?? err;
    throw new ApiError(
      502,
      `无法连接 AI 服务：${redactSecrets(String(err), config.apiKey)}`,
      { code: "upstream_network" },
    );
  }
  const bodyText = await readUpstreamBody(res, config, signal);
  if (!res.ok) {
    throw new ApiError(
      upstreamErrorStatus(res.status),
      upstreamErrorMessage(res.status, bodyText, config),
      { code: upstreamErrorCode(res.status), upstreamStatus: res.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ApiError(502, "AI 服务返回了无法解析的响应，请重试。", { code: "upstream_malformed" });
  }
  return geminiText(parsed);
}

async function callOpenAI(
  config: ResolvedConfig,
  system: string,
  history: HistoryTurn[],
  signal: AbortSignal,
  temperature: number,
): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "system", content: system }, ...history],
        temperature,
        max_tokens: getModelMaxOutputTokens(),
        ...(config.structuredOutput
          ? { response_format: { type: "json_object" } }
          : {}),
        ...openAiThinkingConfig(config),
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal.aborted) throw signal.reason ?? err;
    throw new ApiError(
      502,
      `无法连接 AI 服务：${redactSecrets(String(err), config.apiKey)}`,
      { code: "upstream_network" },
    );
  }
  const bodyText = await readUpstreamBody(res, config, signal);
  if (!res.ok) {
    throw new ApiError(
      upstreamErrorStatus(res.status),
      upstreamErrorMessage(res.status, bodyText, config),
      { code: upstreamErrorCode(res.status), upstreamStatus: res.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ApiError(502, "AI 服务返回了无法解析的响应，请重试。", { code: "upstream_malformed" });
  }
  if (modelTimingEnabled()) {
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
    const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
    const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0;
    const content = typeof message.content === "string" ? message.content.length : 0;
    console.info(`[ai-response] finish=${String(choice.finish_reason ?? "unknown")} promptTokens=${String(usage.prompt_tokens ?? "?")} completionTokens=${String(usage.completion_tokens ?? "?")} reasoningChars=${reasoning} contentChars=${content}`);
  }
  const firstChoice = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).choices)
    ? ((parsed as Record<string, unknown>).choices as unknown[])[0]
    : undefined;
  if (firstChoice && typeof firstChoice === "object" && (firstChoice as Record<string, unknown>).finish_reason === "length") {
    const limit = getModelMaxOutputTokens();
    const advice = limit >= 8_192
      ? "请降低思考等级、缩短材料或拆分问题后重试；当前配置已使用应用允许的最大输出上限。"
      : "请提高 AI_MAX_OUTPUT_TOKENS，或在模型设置中降低思考等级后重试。";
    throw new ApiError(502, `AI 服务输出达到 ${limit} token 上限，思维链或回答被截断。${advice}`, { code: "upstream_output_truncated" });
  }
  return openaiText(parsed);
}

/** 组装教学质量编排使用的模型调用器：每次调用受传入 signal 与固定超时双重约束。 */
export function createModelInvoker(config: ResolvedConfig): ModelInvoker {
  return async (input: ModelInvocation): Promise<string> => {
    const timeoutMs = getModelCallTimeoutMs();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const history: HistoryTurn[] = input.messages.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
    const temperature = input.purpose === "review" ? 0 : 0.4;
    try {
      return await (config.provider === "gemini"
        ? callGemini(config, input.system, history, signal, temperature)
        : callOpenAI(config, input.system, history, signal, temperature));
    } catch (error) {
      // 客户端/编排层取消必须原样传播；仅固定调用超时属于供应商连接故障，允许故障转移。
      if (input.signal.aborted) throw input.signal.reason ?? error;
      if (error instanceof ApiError && error.code !== "upstream_network") throw error;
      if (timeout.aborted) {
        throw new ApiError(
          504,
          `AI 服务响应超时（单次上限 ${Math.round(timeoutMs / 1000)} 秒），请重试或更换模型。`,
          { code: "upstream_timeout" },
        );
      }
      throw error;
    }
  };
}

export interface TeachingPipeline {
  invoke: ModelInvoker;
  maxWriterRevisions: number;
  /** 只在服务端显式配置了不同评审模型时存在；否则由写作模型自评。 */
  reviewerModel?: string;
}

/**
 * 写作与评审可使用同一端点上的不同模型。独立评审模型能避免长思维链拖死复审，
 * 并允许一次额外的针对性修订；未配置或配置同名模型时完全保持原有单模型流程。
 */
export function createTeachingPipeline(
  config: ResolvedConfig,
  options?: { useReviewer?: boolean },
): TeachingPipeline {
  const writer = createModelInvoker(config);
  const reviewModel = options?.useReviewer === false ? "" : cleanEnv(process.env.AI_REVIEW_MODEL);
  if (!reviewModel || reviewModel === config.model) {
    return { invoke: writer, maxWriterRevisions: 1 };
  }
  const reviewer = createModelInvoker({
    ...config,
    model: reviewModel,
    thinkingLevel: normalizeThinkingLevel(process.env.AI_REVIEW_THINKING_LEVEL),
  });
  return {
    invoke: (input) => input.purpose === "review" ? reviewer(input) : writer(input),
    maxWriterRevisions: 2,
    reviewerModel: reviewModel,
  };
}

function modelProfiles(settings: ProviderSettings | undefined): Partial<ProviderSettings>[] {
  if (!settings) return [{}];
  const primary: Partial<ProviderSettings> = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: settings.baseUrl,
    structuredOutput: settings.structuredOutput,
    thinkingLevel: settings.thinkingLevel,
  };
  const fallbacks = (settings.modelFallbacks ?? [])
    .filter((item) => item.apiKey?.trim())
    .map((item) => ({
      provider: item.provider,
      apiKey: item.apiKey,
      model: item.model,
      baseUrl: item.baseUrl,
      structuredOutput: item.structuredOutput,
      thinkingLevel: item.thinkingLevel,
    }));
  return [primary, ...fallbacks];
}

function isModelFailover(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code) return UPSTREAM_FAILOVER_CODES[error.code] === true;
  // 未带稳定码的旧错误仅按真正的供应商故障状态回退；400/404 等参数与配置错误绝不重试。
  return [401, 403, 408, 429, 500, 502, 503, 504].includes(error.status);
}

function withModelUsage(
  response: ChatResponse,
  model: string,
  fallback: boolean,
): ChatResponse {
  if (!response.quality) return response;
  return {
    ...response,
    quality: {
      ...response.quality,
      model,
      fallback,
    },
  };
}

/**
 * 执行一次教学回合：草稿 -> 独立评审 ->（必要时针对性修订 + 复审），全部质量编排见 tutor.ts。
 * options.signal 由 HTTP 层传入：客户端断开时中止上游请求。
 * 主模型与备用模型按顺序尝试，仅供应商类错误触发切换。
 */
export async function chatCompletion(
  req: ChatRequest,
  options?: { signal?: AbortSignal },
): Promise<ChatResponse> {
  let request = req;
  if (req.webSearch) {
    const personalProviders = searchProvidersFromSettings(req.settings);
    if (!personalProviders.length && !webSearchEnabled()) {
      throw new ApiError(403, "当前部署未开启自动联网搜索，且未提供个人搜索 API Key。", { code: "web_search_disabled" });
    }
    if (req.bookContext) {
      throw new ApiError(400, "书籍陪读的来源由当前原书决定，不能同时自动联网搜索。", { code: "invalid_request" });
    }
    try {
      const searchReferences = await searchWebEvidence(buildWebSearchQuery(req), {
        ...(personalProviders.length ? { providers: personalProviders } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const existing = req.references ?? [];
      const seen = new Set(searchReferences.map((reference) => reference.url));
      request = {
        ...req,
        references: [
          ...searchReferences,
          ...existing.filter((reference) => !reference.url || !seen.has(reference.url)),
        ],
      };
    } catch (error) {
      if (error instanceof WebSearchError) {
        throw new ApiError(error.status, error.message, { code: error.code });
      }
      throw error;
    }
  }
  const profiles = modelProfiles(req.settings);
  let lastError: unknown;
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    try {
      const config = resolveConfig(profile);
      const pipeline = createTeachingPipeline(config, {
        // 网页临时密钥只发送到用户选择的模型；服务端评审模型不额外接管 BYOK 请求。
        useReviewer: !profile.apiKey?.trim(),
      });
      const response = await runTeachingTurn(request, pipeline.invoke, {
        signal: options?.signal,
        maxWriterRevisions: pipeline.maxWriterRevisions,
      });
      return withModelUsage(response, config.model, index > 0);
    } catch (error) {
      lastError = error;
      if (!isModelFailover(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError(502, "所有模型配置均不可用，请检查密钥与接口。");
}

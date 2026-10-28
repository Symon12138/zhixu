import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { ChatRequest, ServerConfig } from "../src/types";
import { ApiError, chatCompletion, resolveEnvStatus, validateModelConfig } from "./ai";
import { attachUser, registerAuthRoutes, requireAuth } from "./auth";
import { LearningProtocolError, parseLearningState } from "./learning";
import { BookContextError, parseBookContext, parseBookSourceLocation } from "./books";
import { authConfig, loadConfig, type AppConfig } from "./config";
import { ZhixuDatabase } from "./db";
import { generateDiagnostic, explainReviewItem } from "./diagnostic";
import {
  BODY_LIMIT,
  HttpError,
  abortOnClientClose,
  assertAllowedModelEndpoints,
  parseProviderSettings,
  writeErrorResponse,
} from "./http";
import { UserCredentialStore, registerCredentialRoutes } from "./credentials";
import { acquireAiConcurrency, enforceQuota } from "./quota";
import {
  isLibraryBodyRoute,
  isLibraryDeleteRoute,
  isLibraryOriginalUpload,
  registerLibraryRoutes,
} from "./library";
import {
  auditRequest,
  noStore,
  requestGuard,
  requestId,
  securityHeaders,
} from "./security";
import { accountBinding, registerWorkspaceRoutes } from "./workspace";
import { fetchWebSource, WebFetchError, webFetchEnabled } from "./web";
import { webSearchEnabled, searchProvidersFromSettings } from "./webSearch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 输入校验 ─────────────────────────────────────────────────────────────
const MAX_MESSAGE_CHARS = 24_000;
const MAX_MESSAGES = 200;
const ACTIONS: ChatRequest["action"][] = [
  "start",
  "message",
  "continue",
  "hint",
  "example",
  "quiz",
  "summary",
  "flashcards",
  "resume",
];

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function validateChatRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "请求体必须是一个 JSON 对象。");
  }
  const b = body as Record<string, unknown>;

  const action = b.action as ChatRequest["action"];
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new ApiError(400, `action 必须是以下之一：${ACTIONS.join("、")}。`);
  }

  const messages = b.messages;
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) {
    throw new ApiError(400, `messages 必须是数组，且最多 ${MAX_MESSAGES} 条。`);
  }
  const normalizedMessages: ChatRequest["messages"] = messages.map((m, i) => {
    if (!m || typeof m !== "object") {
      throw new ApiError(400, `第 ${i + 1} 条消息格式不正确。`);
    }
    const msg = m as Record<string, unknown>;
    const role = msg.role;
    const content = msg.content;
    if (role !== "user" && role !== "assistant") {
      throw new ApiError(
        400,
        `第 ${i + 1} 条消息的 role 必须是 user 或 assistant。`,
      );
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ApiError(400, `第 ${i + 1} 条消息的内容不能为空。`);
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new ApiError(
        400,
        `第 ${i + 1} 条消息过长（${content.length} 字符，上限 ${MAX_MESSAGE_CHARS}）。请拆分或精简后再发送，服务端不会自动截断消息。`,
      );
    }
    return { role, content };
  });

  const topic = asTrimmedString(b.topic);
  if (!topic) throw new ApiError(400, "缺少学习主题（topic）。");
  if (topic.length > 2000)
    throw new ApiError(
      400,
      `学习主题过长（${topic.length} 字符，上限 2000）。服务端不会自动截断，请精简后再试。`,
    );

  const level = asTrimmedString(b.level) ?? "";
  const goal = asTrimmedString(b.goal) ?? "";
  if (level.length > 200)
    throw new ApiError(400, `水平描述过长（上限 200 字符）。`);
  if (goal.length > 2000)
    throw new ApiError(400, `学习目标过长（上限 2000 字符）。`);

  let references: ChatRequest["references"] = undefined;
  if (b.references !== undefined && b.references !== null) {
    if (!Array.isArray(b.references) || b.references.length > 20) {
      throw new ApiError(400, "references 必须是数组，且最多 20 份资料。");
    }
    references = b.references.map((r, i) => {
      if (!r || typeof r !== "object") {
        throw new ApiError(400, `第 ${i + 1} 份资料格式不正确。`);
      }
      const ref = r as Record<string, unknown>;
      const name = asTrimmedString(ref.name);
      const text = typeof ref.text === "string" ? ref.text : "";
      if (!name || name.length > 300)
        throw new ApiError(400, `第 ${i + 1} 份资料需有300字符以内的名称。`);
      if (text.length > 200_000) {
        throw new ApiError(
          400,
          `第 ${i + 1} 份资料过长（${text.length} 字符，上限 200000）。服务端不会自动截断，请精简后再试。`,
        );
      }
      let url: string | undefined;
      if (ref.url !== undefined && ref.url !== null) {
        if (typeof ref.url !== "string" || ref.url.length > 2048)
          throw new ApiError(400, `第 ${i + 1} 份网页资料地址不合法。`);
        try {
          const parsed = new URL(ref.url);
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
            throw new Error("unsafe");
          url = parsed.toString();
        } catch {
          throw new ApiError(400, `第 ${i + 1} 份网页资料地址不合法。`);
        }
      }
      const retrievedAt =
        typeof ref.retrievedAt === "string" &&
        ref.retrievedAt.length <= 40 &&
        Number.isFinite(Date.parse(ref.retrievedAt))
          ? new Date(ref.retrievedAt).toISOString()
          : undefined;
      const verification =
        ref.verification === "page_fetched" ||
        ref.verification === "claim_matched" ||
        ref.verification === "search_snippet"
          ? ref.verification
          : undefined;
      const verifiedQuote =
        typeof ref.verifiedQuote === "string" && ref.verifiedQuote.length <= 2000
          ? ref.verifiedQuote
          : undefined;
      const publishedAt =
        typeof ref.publishedAt === "string" &&
        ref.publishedAt.length <= 80
          ? ref.publishedAt
          : undefined;
      const sourceTier =
        ref.sourceTier === "official" || ref.sourceTier === "primary" || ref.sourceTier === "secondary" || ref.sourceTier === "unknown"
          ? ref.sourceTier
          : undefined;
      return {
        name,
        text,
        ...(ref.location === undefined
          ? {}
          : { location: parseBookSourceLocation(ref.location) }),
        ...(url ? { url } : {}),
        ...(retrievedAt ? { retrievedAt } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(verification ? { verification } : {}),
        ...(verifiedQuote ? { verifiedQuote } : {}),
        ...(sourceTier ? { sourceTier } : {}),
      };
    });
  }

  const settings = parseProviderSettings(b.settings);

  let learningState: ChatRequest["learningState"] = undefined;
  if (b.learningState !== undefined && b.learningState !== null) {
    try {
      learningState = parseLearningState(b.learningState);
    } catch (err) {
      if (err instanceof LearningProtocolError) {
        throw new ApiError(
          400,
          `附带的学习状态不合法：${err.issues.map((issue) => issue.detail).join("；")}`,
        );
      }
      throw err;
    }
  }
  let bookContext: ChatRequest["bookContext"];
  try {
    bookContext = parseBookContext(b.bookContext, references);
  } catch (cause) {
    if (cause instanceof BookContextError) throw new ApiError(400, cause.message);
    throw cause;
  }
  return {
    settings,
    topic,
    level,
    goal,
    messages: normalizedMessages,
    action,
    references,
    ...(b.webSearch === true ? { webSearch: true } : {}),
    learningState,
    ...(bookContext ? { bookContext } : {}),
  };
}

// ── 应用装配 ─────────────────────────────────────────────────────────────

export interface CreateAppOptions {
  config: AppConfig;
  db: ZhixuDatabase;
  /** 默认跟随 config.production；测试可关闭静态托管。 */
  serveStatic?: boolean;
}

/**
 * 构建完整 Express 应用（不监听端口）。测试传入临时 SQLite 与显式配置，
 * 生产入口在同一套装配上启动监听，避免测试与线上行为分叉。
 */
export function createApp(options: CreateAppOptions): Express {
  const { config, db } = options;
  const serveStatic = options.serveStatic ?? config.production;
  const credentialStore = new UserCredentialStore(db, config.dataDir);
  const app = express();

  app.disable("x-powered-by");
  // 默认不信任 X-Forwarded-For（防伪造）；正式部署在同一台机器的反向代理后时，
  // 通过 ZHIXU_TRUST_PROXY=true 信任一层代理，限流才能拿到真实客户端地址。
  app.set("trust proxy", config.trustProxy === true ? 1 : false);

  app.use(securityHeaders(config));
  app.use(requestId());
  app.use("/api", noStore());

  // 书架原文件是唯一的二进制写请求，DELETE 又没有请求体：守卫仍负责
  // Host/CSRF/Origin/跨站检查，只对这两类请求放宽 JSON 内容类型要求。
  const guard = requestGuard(config);
  app.use((req, res, next) => {
    if (!isLibraryOriginalUpload(req) && !isLibraryDeleteRoute(req)) {
      guard(req, res, next);
      return;
    }
    const contentType = req.headers["content-type"];
    req.headers["content-type"] = "application/json";
    guard(req, res, (error?: unknown) => {
      if (contentType === undefined) delete req.headers["content-type"];
      else req.headers["content-type"] = contentType;
      next(error);
    });
  });
  app.use("/api", attachUser(db));

  // 先鉴权再解析工作区大请求体，避免未登录客户端反复上传 25 MB。
  app.use("/api/workspace", (req, _res, next) => {
    if (!req.authUser) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    next();
  });

  // 工作区与书架的写请求体由各自路由在鉴权/限流/并发门禁之后解析；
  // 其余请求仍使用 1 MB 上限，避免在门禁前读取 25 MB / 30 MB。
  const parseDefaultJson = express.json({ limit: BODY_LIMIT, inflate: false });
  app.use((req, res, next) => {
    if (isLibraryBodyRoute(req)) {
      next();
      return;
    }
    const pathname = req.path.replace(/\/+$/, "").toLowerCase();
    if (req.method === "PUT" && pathname === "/api/workspace") {
      next();
      return;
    }
    parseDefaultJson(req, res, next);
  });

  // ── GET /api/config：只暴露 provider/model，绝不返回 apiKey ──────────────
  app.get("/api/config", (_req, res) => {
    const status: ServerConfig = {
      ...resolveEnvStatus(),
      ...authConfig(config),
      webFetchEnabled: webFetchEnabled(),
      webSearchEnabled: webSearchEnabled(),
    };
    res.json(status);
  });

  // ── 健康检查：health 只看进程，ready 还要求数据库可用 ───────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: Date.now() });
  });

  app.get("/api/ready", (_req, res) => {
    try {
      if (!db.ping()) throw new Error("database ping failed");
      const schema = db.schemaHealth();
      if (!schema.ok) {
        res.status(503).json({ ok: false, error: "数据库结构或迁移版本不可用，请先完成升级检查。", schema });
        return;
      }
      const credentials = credentialStore.health();
      if (!credentials.ok) {
        res.status(503).json({ ok: false, error: "个人凭据密钥不可用，请从完整备份恢复 credentials.key。", credentialKeyStatus: credentials.status });
        return;
      }
      res.json({ ok: true, db: true, credentials: credentials.status, time: Date.now() });
    } catch {
      res.status(503).json({ ok: false, error: "数据库暂不可用，请稍后重试。" });
    }
  });

  // ── 认证与工作区 ────────────────────────────────────────────────────────
  const api = express.Router();
  registerAuthRoutes(api, config, db);
  registerWorkspaceRoutes(api, db);
  registerLibraryRoutes(api, db);
  registerCredentialRoutes(api, config, db, credentialStore);
  app.use("/api", api);

  // ── 模型调用：认证、并发闸门、BYOK 策略、每日额度 ───────────────────────
  const aiAuth: RequestHandler[] = config.authRequired ? [requireAuth()] : [];
  const webAuth: RequestHandler[] = config.authRequired ? [requireAuth()] : [];
  const webHits = new Map<string, { count: number; resetAt: number }>();
  const webHourlyLimit = Math.max(1, Math.min(500, Number(process.env.ZHIXU_WEB_HOURLY_LIMIT) || 30));

  function cleanupWebHits(now = Date.now()): void {
    for (const [key, hit] of webHits) {
      if (hit.resetAt <= now) webHits.delete(key);
    }
  }
  const webHitsCleanupTimer = setInterval(cleanupWebHits, 60_000);
  webHitsCleanupTimer.unref();

  function allowWebFetch(req: Request): boolean {
    const key = req.authUser?.id ?? req.ip ?? "local";
    const now = Date.now();
    cleanupWebHits(now);
    const current = webHits.get(key);
    if (!current || current.resetAt <= now) {
      webHits.set(key, { count: 1, resetAt: now + 3_600_000 });
      return true;
    }
    if (current.count >= webHourlyLimit) return false;
    current.count += 1;
    return true;
  }

  /** 同一账户最多同时进行 config.maxConcurrentAi 个模型请求；释放幂等。 */
  const aiConcurrency: RequestHandler = (req, res, next) => {
    const userId = req.authUser?.id;
    if (!userId) {
      next();
      return;
    }
    const release = acquireAiConcurrency(userId, config.maxConcurrentAi);
    if (!release) {
      auditRequest(db, req, "ai.concurrency", "denied", "concurrency_limit");
      res.setHeader("Retry-After", "5");
      res.status(429).json({
        error: "同时在进行的 AI 请求过多，请等待当前回复完成后再试。",
        code: "concurrency_limit",
        resetAt: Date.now() + 5_000,
      });
      return;
    }
    res.once("finish", release);
    res.once("close", release);
    next();
  };

  /** 公共模式默认禁止请求内 apiKey；只有 ZHIXU_ALLOW_BYOK=true 才放行。 */
  function assertProviderKeyPolicy(req: Request, settings: ChatRequest["settings"]): void {
    const hasPersonalKey =
      !!settings?.apiKey ||
      !!settings?.searchApiKey ||
      !!settings?.modelFallbacks?.some((item) => item.apiKey) ||
      !!settings?.searchFallbacks?.some((item) => item.apiKey);
    if (!hasPersonalKey) return;
    if (!req.authUser) {
      auditRequest(db, req, "ai.byok", "denied", "login_required");
      throw new HttpError(401, "登录后才能配置个人模型或搜索 API Key。", { code: "auth_required" });
    }
    if (!config.allowByok) {
      auditRequest(db, req, "ai.byok", "denied", "byok_not_allowed");
      throw new HttpError(
        403,
        "当前部署不允许使用浏览器提供的 API Key，请清空密钥后使用服务端配置。",
        { code: "byok_not_allowed" },
      );
    }
    if (!settings) return;
    assertAllowedModelEndpoints(settings, config.byokAllowedOrigins);
  }

  /**
   * 已登录且允许 BYOK 时，模型/搜索只能使用该账户服务端保存的个人 Key。
   * 没有个人模型 Key 直接拒绝，绝不回退到服务端共享密钥；搜索请求还要求个人搜索 Key。
   * 未登录或关闭 BYOK 的部署保持原有服务端配置路径。
   */
  function requireStoredCredentials(
    req: Request,
    fallback: ChatRequest["settings"],
    needSearch: boolean,
  ): ChatRequest["settings"] {
    if (!req.authUser || !config.allowByok) return fallback;
    let saved: ChatRequest["settings"];
    try {
      saved = credentialStore.get(req.authUser.id)?.settings;
    } catch {
      auditRequest(db, req, "ai.byok", "denied", "credentials_unavailable");
      throw new HttpError(
        500,
        "个人配置读取失败，请联系管理员检查服务端凭据密钥。",
        { code: "credentials_unavailable" },
      );
    }
    if (!saved?.apiKey?.trim()) {
      auditRequest(db, req, "ai.byok", "denied", "credentials_required");
      throw new HttpError(
        409,
        "请先在「模型与设置」中配置并保存个人模型 Key。",
        { code: "personal_credentials_required" },
      );
    }
    if (needSearch && searchProvidersFromSettings(saved).length === 0) {
      auditRequest(db, req, "ai.byok", "denied", "personal_search_required");
      throw new HttpError(
        409,
        "请先在「模型与设置」中配置并保存个人搜索 Key。",
        { code: "personal_search_required" },
      );
    }
    assertAllowedModelEndpoints(saved, config.byokAllowedOrigins);
    return saved;
  }

  /**
     * 在任何 provider 字段解析之前拒绝被禁止的请求内密钥。
     * 不允许未登录请求携带个人模型或搜索密钥，避免密钥在无身份请求中被使用。
     */
  function assertRawProviderKeyPolicy(req: Request, body: unknown): void {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const raw = (body as Record<string, unknown>).settings;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const apiKey = (raw as Record<string, unknown>).apiKey;
    const searchApiKey = (raw as Record<string, unknown>).searchApiKey;
    const modelFallbacks = (raw as Record<string, unknown>).modelFallbacks;
    const searchFallbacks = (raw as Record<string, unknown>).searchFallbacks;
    const hasPersonalKey =
      (typeof apiKey === "string" && apiKey.trim().length > 0) ||
      (typeof searchApiKey === "string" && searchApiKey.trim().length > 0) ||
      (Array.isArray(modelFallbacks) &&
        modelFallbacks.some((item) =>
          item && typeof item === "object" && typeof (item as Record<string, unknown>).apiKey === "string" && ((item as Record<string, unknown>).apiKey as string).trim().length > 0)) ||
      (Array.isArray(searchFallbacks) &&
        searchFallbacks.some((item) =>
          item && typeof item === "object" && typeof (item as Record<string, unknown>).apiKey === "string" && ((item as Record<string, unknown>).apiKey as string).trim().length > 0));
    if (!hasPersonalKey) return;
    if (!req.authUser) {
      auditRequest(db, req, "ai.byok", "denied", "login_required");
      throw new HttpError(401, "登录后才能配置个人模型或搜索 API Key。", { code: "auth_required" });
    }
    if (!config.allowByok) {
      auditRequest(db, req, "ai.byok", "denied", "byok_not_allowed");
      throw new HttpError(
        403,
        "当前部署不允许使用浏览器提供的 API Key，请清空密钥后使用服务端配置。",
        { code: "byok_not_allowed" },
      );
    }
  }

  app.post("/api/chat", ...aiAuth, accountBinding(), aiConcurrency, async (req, res) => {
    const client = abortOnClientClose(res);
    try {
      assertRawProviderKeyPolicy(req, req.body);
      const chatReq = validateChatRequest(req.body);
      assertProviderKeyPolicy(req, chatReq.settings);
      const effective = {
        ...chatReq,
        settings: requireStoredCredentials(
          req,
          chatReq.settings,
          chatReq.webSearch === true,
        ),
      };
      // 本地可预判的配置错误必须先拒绝，不能消耗当日额度。
      validateModelConfig(effective.settings);
      if (!enforceQuota(req, res, db, config.quotas, "chat")) return;
      const response = await chatCompletion(effective, { signal: client.signal });
      if (!res.writableEnded && !res.destroyed) res.json(response);
    } catch (err) {
      // 客户端已断开：不再尝试写任何响应。
      if (client.signal.aborted) return;
      writeErrorResponse(res, err);
    } finally {
      client.dispose();
    }
  });

  app.post("/api/web/verify", ...webAuth, async (req, res) => {
    try {
      if (!webFetchEnabled()) {
        throw new HttpError(403, "当前部署未开启联网来源核验。", { code: "web_fetch_disabled" });
      }
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const claim = typeof body.claim === "string" ? body.claim : undefined;
      if (!url) throw new HttpError(400, "请填写要核验的网页地址。", { code: "web_url_required" });
      if (url.length > 2048) throw new HttpError(400, "网页地址过长。", { code: "web_url_too_long" });
      if (!allowWebFetch(req)) {
        res.setHeader("Retry-After", "3600");
        throw new HttpError(429, "联网核验请求过多，请稍后再试。", { code: "web_rate_limit" });
      }
      const evidence = await fetchWebSource(url, claim);
      auditRequest(db, req, "web.fetch", "ok", evidence.publisher);
      res.json(evidence);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof WebFetchError) {
        auditRequest(db, req, "web.fetch", "denied", error.code);
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      writeErrorResponse(res, error);
    }
  });

  app.post("/api/diagnostic", ...aiAuth, accountBinding(), aiConcurrency, async (req, res) => {
    const client = abortOnClientClose(res);
    try {
      assertRawProviderKeyPolicy(req, req.body);
      const body =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      if (
        typeof body.topic !== "string" ||
        typeof body.level !== "string" ||
        typeof body.goal !== "string"
      )
        throw new ApiError(400, "诊断需要 topic、level、goal 文本字段。");
      // 与 /api/chat 完全一致：非法设置直接 400，绝不静默回退到环境密钥。
      const requested = parseProviderSettings(body.settings);
      assertProviderKeyPolicy(req, requested);
      const settings = requireStoredCredentials(req, requested, false);
      if (!(body.topic as string).trim()) throw new ApiError(400, "请先填写诊断主题。");
      validateModelConfig(settings);
      if (!enforceQuota(req, res, db, config.quotas, "diagnostic")) return;
      const result = await generateDiagnostic(
        body.topic.slice(0, 2000),
        body.level.slice(0, 200),
        body.goal.slice(0, 2000),
        settings,
        client.signal,
      );
      if (!res.writableEnded && !res.destroyed) res.json(result);
    } catch (error) {
      if (client.signal.aborted) return;
      writeErrorResponse(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post("/api/review/explain", ...aiAuth, accountBinding(), aiConcurrency, async (req, res) => {
    const client = abortOnClientClose(res);
    try {
      assertRawProviderKeyPolicy(req, req.body);
      const body =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      for (const key of ["topic", "prompt", "explanation", "level"]) {
        if (typeof body[key] !== "string")
          throw new ApiError(400, `复习补讲需要 ${key} 字段。`);
      }
      // 与 /api/chat 完全一致：非法设置直接 400，绝不静默回退到环境密钥。
      const requested = parseProviderSettings(body.settings);
      assertProviderKeyPolicy(req, requested);
      const settings = requireStoredCredentials(req, requested, false);
      if (
        !(body.topic as string).trim() ||
        !(body.prompt as string).trim() ||
        !(body.explanation as string).trim()
      ) {
        throw new ApiError(400, "复习项缺少主题、题面或原解析，不能补讲。");
      }
      validateModelConfig(settings);
      if (!enforceQuota(req, res, db, config.quotas, "review")) return;
      const result = await explainReviewItem(
        (body.topic as string).slice(0, 2000),
        (body.prompt as string).slice(0, 4000),
        (body.explanation as string).slice(0, 6000),
        typeof body.learnerQuote === "string"
          ? body.learnerQuote.slice(0, 2000)
          : undefined,
        (body.level as string).slice(0, 200),
        settings,
        client.signal,
      );
      if (!res.writableEnded && !res.destroyed) res.json(result);
    } catch (error) {
      if (client.signal.aborted) return;
      writeErrorResponse(res, error);
    } finally {
      client.dispose();
    }
  });

  // ── 未知 API 一律 JSON 404，避免回落到 SPA HTML ────────────────────────
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "接口不存在。" });
  });

  // ── 生产：静态托管 dist + SPA fallback ─────────────────────────────────
  if (serveStatic) {
    const distDir = path.resolve(__dirname, "..", "dist");
    if (fs.existsSync(path.join(distDir, "index.html"))) {
      app.use(express.static(distDir, { index: "index.html" }));
      app.get(/^(?!\/api\/).*/, (_req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    } else {
      // 入口 main() 会在生产模式启动前硬性拒绝缺失的构建产物；
      // 直接装配 createApp 的测试/工具仍可只使用 API。
      console.warn(
        `未找到前端构建产物：${path.join(distDir, "index.html")}，当前仅提供 API 服务。`,
      );
    }
  }

  // ── 统一错误处理（HttpError/ApiError → 明确中文错误；其他 → 不泄密 500） ──
  function errorMiddleware(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    writeErrorResponse(res, err);
  }
  app.use(errorMiddleware);

  return app;
}

/**
 * 兼容旧入口的 app 绑定：真正运行（entry）时在 main() 中被替换为已装配应用；
 * 仅作为库导入（如测试）时保持未装配的空应用，不读取 .env、不打开数据库。
 */
export let app: Express = express();
export { app as default };

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const metaMain = (import.meta as ImportMeta & { main?: boolean }).main;
const isEntry =
  metaMain === true ||
  (entryPath !== "" &&
    entryPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase());

/**
 * 24 小时运维清理：过期会话 + 审计/额度/限流 + 书架墓碑与 pending 中间态。
 * 单独导出以便测试验证定时任务的实际清理范围。
 */
export function runOperationalCleanup(
  db: ZhixuDatabase,
  retention: {
    auditDays: number;
    usageDays: number;
    tombstoneDays?: number;
    pendingLibraryHours?: number;
  },
): {
  sessions: number;
  audit: number;
  usage: number;
  rateLimits: number;
  tombstones: number;
  pendingLibraryBooks: number;
} {
  const sessions = db.cleanupExpiredSessions();
  return { sessions, ...db.cleanupExpiredData(retention) };
}

async function main(): Promise<void> {
  // 静态 import 会在测试导入 createApp 时也读取 .env，破坏临时配置隔离；
  // 因此只在真实入口动态加载，加载完成后再 loadConfig。
  await import("dotenv/config");
  const production = process.argv.includes("--production");
  const config = loadConfig(production);
  if (config.production) {
    const distDir = path.resolve(__dirname, "..", "dist");
    if (!fs.existsSync(path.join(distDir, "index.html"))) {
      throw new Error(
        `未找到前端构建产物：${path.join(distDir, "index.html")}，请先运行 npm run build。`,
      );
    }
  }
  const db = new ZhixuDatabase(path.join(config.dataDir, "zhixu.db"));
  const cleanupOperationalData = () => {
    try {
      const removed = runOperationalCleanup(db, {
        auditDays: config.auditRetentionDays,
        usageDays: config.usageRetentionDays,
      });
      if (
        removed.sessions ||
        removed.audit ||
        removed.usage ||
        removed.rateLimits ||
        removed.tombstones ||
        removed.pendingLibraryBooks
      ) {
        console.log(
          `已清理运维数据：会话 ${removed.sessions}、审计 ${removed.audit}、日用量 ${removed.usage}、限流 ${removed.rateLimits}、书架墓碑 ${removed.tombstones}、未完成书目 ${removed.pendingLibraryBooks}。`,
        );
      }
    } catch (error) {
      console.error(
        `定期数据清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  cleanupOperationalData();
  const cleanupTimer = setInterval(cleanupOperationalData, 24 * 60 * 60 * 1000);
  cleanupTimer.unref();

  app = (() => {
    try {
      return createApp({ config, db });
    } catch (error) {
      db.close();
      throw error;
    }
  })();
  const server = app.listen(config.port, config.host, () => {
    const envStatus = resolveEnvStatus();
    console.log(`知序服务已启动：http://${config.host}:${config.port}`);
    console.log(
      `模式：${config.production ? "公共正式版（单节点 SQLite）" : "本地开发"}；` +
        `登录要求：${config.authRequired ? "必须登录" : "可选"}；` +
        `BYOK：${config.allowByok ? "允许" : "禁止"}`,
    );
    console.log(
      `AI 配置：${
        envStatus.configured
          ? `已就绪（${envStatus.provider} / ${envStatus.model}）`
          : "未配置服务端密钥"
      }`,
    );
    console.log(
      `每日额度（UTC）：对话 ${config.quotas.chatPerDay}、诊断 ${config.quotas.diagnosticPerDay}、复习补讲 ${config.quotas.reviewPerDay}`,
    );
    console.log(`数据目录：${config.dataDir}（单节点 SQLite，不支持多实例共享）`);
    if (config.trustProxy) {
      console.log("已信任一层反向代理的 X-Forwarded-For（ZHIXU_TRUST_PROXY=true）。");
    }
    if (config.publicOrigin) {
      console.log(`公网来源：${config.publicOrigin}`);
    }
  });

  server.on("error", (error: Error) => {
    console.error(`知序服务启动失败：${error.message}`);
    process.exitCode = 1;
    try {
      db.close();
    } catch {
      // 已在关闭中。
    }
  });

  const shutdown = (signal: string): void => {
    console.log(`收到 ${signal}，正在关闭……`);
    clearInterval(cleanupTimer);
    const forceExit = setTimeout(() => process.exit(1), 5000);
    server.close(() => {
      clearTimeout(forceExit);
      try {
        db.close();
      } finally {
        process.exit(0);
      }
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (isEntry) {
  void main().catch((error: unknown) => {
    console.error(
      `知序服务启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

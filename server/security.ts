import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { AuthUser } from "../src/types";
import type { AppConfig } from "./config";
import type { ZhixuDatabase } from "./db";

/**
 * 请求上下文与边界安全：
 * - 请求 ID（可追踪，不信任任意入站值）；
 * - Host / Origin 白名单与 JSON + CSRF 标记校验；
 * - 安全响应头与 /api 禁止缓存；
 * - 脱敏审计（绝不写入邮箱、密码、密钥、恢复码或对话正文）。
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 每个请求唯一的追踪 ID。 */
      requestId?: string;
      /** attachUser 解析出的登录用户。 */
      authUser?: AuthUser;
      /** 当前会话 token 的哈希（用于退出登录）。 */
      sessionTokenHash?: string;
    }
  }
}

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "[::1]": true,
  "::1": true,
};
const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

/** 请求 ID：只接受格式受限的入站值，否则生成新的 UUID。 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
        ? incoming
        : crypto.randomUUID();
    req.requestId = id;
    res.setHeader("X-Request-Id", id);
    next();
  };
}

function requestHostName(host: string): { hostname: string; port: string } | null {
  if (!host || /[\s/@\\]/.test(host)) return null;
  // IPv6：[::1]:3001
  const ipv6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(host);
  if (ipv6) return { hostname: `[${ipv6[1].toLowerCase()}]`, port: ipv6[2] ?? "" };
  const index = host.lastIndexOf(":");
  if (index === -1) return { hostname: host.toLowerCase(), port: "" };
  const hostname = host.slice(0, index).toLowerCase();
  const port = host.slice(index + 1);
  if (!/^\d{1,5}$/.test(port)) return null;
  return { hostname, port };
}

/**
 * Host 白名单：
 * - 任意端口的本机回环（开发代理、健康检查、测试）；
 * - 配置的监听地址（非 0.0.0.0 / ::）；
 * - 生产公网来源的 host（Host 头 + 可能的默认端口）。
 * 这不是认证，只是阻断 DNS rebinding 与错误虚拟主机。
 */
export function isAllowedHost(hostHeader: string | undefined, config: AppConfig): boolean {
  if (!hostHeader) return false;
  const parsed = requestHostName(hostHeader);
  if (!parsed) return false;
  if (LOOPBACK_HOSTS[parsed.hostname] === true) return true;

  if (config.publicOrigin) {
    try {
      const origin = new URL(config.publicOrigin);
      if (parsed.hostname === origin.hostname.toLowerCase()) return true;
      if (hostHeader.toLowerCase() === origin.host.toLowerCase()) return true;
    } catch {
      // 配置非法时只按监听地址/回环判断，不因每次请求抛 500。
    }
  }

  const listenHost = config.host.trim().toLowerCase();
  if (listenHost && listenHost !== "0.0.0.0" && listenHost !== "::" && listenHost !== "[::]") {
    if (parsed.hostname === listenHost) return true;
  }
  return false;
}

/**
 * Origin 白名单：
 * - 生产只接受 ZHIXU_PUBLIC_ORIGIN；
 * - 开发额外接受任意端口的本机回环（Vite 5173 与 API 3001）；
 * - 未配置公网来源的开发模式允许回环来源，便于本地代理。
 */
export function isAllowedOrigin(origin: string, config: AppConfig): boolean {
  if (config.publicOrigin) {
    if (origin === config.publicOrigin) return true;
    if (config.production) return false;
  }
  if (config.production) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.pathname !== "/" || url.search || url.hash) return false;
  return LOOPBACK_HOSTS[url.hostname.toLowerCase()] === true;
}

/** 安全响应头：生产额外加 HSTS（仅当 Cookie 被视为安全时）。 */
export function securityHeaders(config: AppConfig): RequestHandler {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' blob:",
  ].join("; ");

  return (_req, res, next) => {
    // 非 Docker 的 `npm start` 不一定设置 NODE_ENV=production；以 --production
    // 实际加载的配置为准，让审计日志在两种部署方式下都输出到 stdout。
    res.locals.zhixuProduction = config.production;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
    if (config.production && config.cookieSecure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

/** /api 响应绝不缓存，避免中间代理缓存登录态或学习数据。 */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    next();
  };
}

/**
 * 写请求边界：
 * 1. Host 必须是白名单（所有方法）；
 * 2. 非安全方法必须有 `X-Zhixu-Request: 1` 或可信 Origin（浏览器同源写请求）；
 * 3. 非安全方法必须是 application/json；
 * 4. Origin 存在时必须在白名单内，且拒绝 Sec-Fetch-Site: cross-site。
 * SameSite=Strict 的会话 Cookie 是最后一道防线。
 */
export function requestGuard(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!isAllowedHost(req.headers.host, config)) {
      res.status(403).json({ error: "请求主机不合法，已拒绝。" });
      return;
    }
    if (SAFE_METHODS[req.method.toUpperCase()] === true) {
      next();
      return;
    }

    const origin = req.headers.origin;
    const originValue = typeof origin === "string" ? origin : "";
    const csrf = req.headers["x-zhixu-request"];
    const csrfOk = typeof csrf === "string" && csrf.trim() === "1";
    // 浏览器同源写请求可能不带自定义头，但一定带 Origin；两者至少有其一。
    const originOk = originValue !== "" && isAllowedOrigin(originValue, config);
    if (!csrfOk && !originOk) {
      res.status(403).json({ error: "缺少 CSRF 标记，请从知序页面发起请求。" });
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      res.status(415).json({ error: "请求必须使用 application/json 内容类型。" });
      return;
    }

    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite.toLowerCase() === "cross-site") {
      res.status(403).json({ error: "拒绝了来自其他网站的跨站写请求。" });
      return;
    }

    if (originValue !== "") {
      if (originValue.includes(",") || !isAllowedOrigin(originValue, config)) {
        res.status(403).json({ error: "拒绝了来自其他网站的跨站写请求。" });
        return;
      }
    }
    next();
  };
}

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const SECRET_ASSIGNMENT =
  /(api[-_]?key|password|passwd|secret|token|authorization|recovery[-_]?code)\s*[:=]\s*\S+/gi;

/**
 * 审计详情脱敏：去邮箱、去 `password=...` 一类赋值、限长。
 * 调用方只传事件摘要，绝不传请求体/对话正文。
 */
export function sanitizeAuditDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const cleaned = detail
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(EMAIL_PATTERN, "[email]")
    .slice(0, 300);
  return cleaned;
}

/** 审计写入绝不因数据库异常影响主流程。 */
export function auditRequest(
  db: ZhixuDatabase,
  req: Request,
  event: string,
  result: "ok" | "denied" | "failed",
  detail?: string,
): void {
  const requestId = req.requestId ?? "unknown";
  const userId = req.authUser?.id;
  const safeDetail = sanitizeAuditDetail(detail);
  try {
    db.audit(event, result, requestId, userId, safeDetail);
  } catch {
    // 审计失败不能导致业务请求失败。
  }
  // 生产容器把脱敏审计输出到 stdout，供集中日志采集；不含邮箱、正文、密钥。
  // 非 Docker 部署通常没有 NODE_ENV=production，因此同时读取本次请求的配置模式。
  const production =
    req.res?.locals?.zhixuProduction === true ||
    process.env.NODE_ENV === "production";
  if (production) {
    console.log(
      `[audit] ${JSON.stringify({
        ts: Date.now(),
        requestId,
        event,
        result,
        ...(userId ? { userId } : {}),
        ...(safeDetail ? { detail: safeDetail } : {}),
      })}`,
    );
  }
}

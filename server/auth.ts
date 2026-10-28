import crypto from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import type { AuthResult, AuthUser, CloudWorkspace, StudyBackup } from "../src/types";
import type { AppConfig } from "./config";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  newId,
  type UserRow,
  type ZhixuDatabase,
} from "./db";
import { HttpError } from "./http";
import { auditRequest } from "./security";

/**
 * 账户与会话：
 * - scrypt 加盐（参数写入哈希串），时序安全比较；
 * - 会话与恢复码只存 SHA-256 哈希，明文只在响应/Cookie 出现一次；
 * - 恢复码一次性、成功后轮换并撤销全部会话；
 * - 认证尝试限流落 SQLite（邮箱与来源 IP 分别计数），429 带 Retry-After。
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;
const MAX_RECOVERY_INPUT_LENGTH = 64;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;
const RECOVERY_CODE_BYTES = 15; // 120 bit → 24 个 Crockford 字符
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUP_SIZE = 4;
const DUMMY_SALT = "0000000000000000000000000000000000000000000000000000000000000000";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export interface RateLimitPolicy {
  windowMs: number;
  maxFailures: number;
  blockMs: number;
}

export const LOGIN_EMAIL_POLICY: RateLimitPolicy = {
  windowMs: 10 * 60_000,
  maxFailures: 8,
  blockMs: 15 * 60_000,
};
export const LOGIN_IP_POLICY: RateLimitPolicy = {
  windowMs: 10 * 60_000,
  maxFailures: 50,
  blockMs: 15 * 60_000,
};
export const RECOVER_EMAIL_POLICY: RateLimitPolicy = {
  windowMs: 15 * 60_000,
  maxFailures: 5,
  blockMs: 30 * 60_000,
};
export const RECOVER_IP_POLICY: RateLimitPolicy = {
  windowMs: 15 * 60_000,
  maxFailures: 20,
  blockMs: 30 * 60_000,
};
export const REGISTER_IP_POLICY: RateLimitPolicy = {
  windowMs: 60 * 60_000,
  maxFailures: 30,
  blockMs: 60 * 60_000,
};
export const ACCOUNT_DELETE_POLICY: RateLimitPolicy = {
  windowMs: 15 * 60_000,
  maxFailures: 5,
  blockMs: 30 * 60_000,
};

/* ── 基础校验与规范化 ─────────────────────────────────────────── */

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "请输入邮箱地址。");
  }
  const email = value.trim().toLowerCase();
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new HttpError(400, "请输入有效的邮箱地址。");
  }
  return email;
}

function validateNewPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "请输入密码。");
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`);
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `密码过长，最多 ${MAX_PASSWORD_LENGTH} 个字符。`);
  }
  return value;
}

function normalizeName(value: unknown, email: string): string {
  const raw = typeof value === "string" ? value.replace(CONTROL_CHARS, "").trim() : "";
  const fallback = email.split("@")[0] || "学习者";
  const name = raw || fallback;
  return name.slice(0, MAX_NAME_LENGTH);
}

/* ── 密码哈希（scrypt） ───────────────────────────────────────── */

function deriveKey(
  password: string,
  salt: string,
  n = SCRYPT_N,
  r = SCRYPT_R,
  p = SCRYPT_P,
): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  crypto.scrypt(
    password,
    salt,
    SCRYPT_KEY_LENGTH,
    { N: n, r, p, maxmem: SCRYPT_MAX_MEM },
    (error, key) => (error ? reject(error) : resolve(key)),
  );
  return promise;
}

export interface PasswordDigest {
  passwordHash: string;
  passwordSalt: string;
}

export async function hashPassword(password: string): Promise<PasswordDigest> {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const key = await deriveKey(password, passwordSalt);
  return {
    passwordHash: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${key.toString("base64")}`,
    passwordSalt,
  };
}

/** 校验密码；哈希格式非法或长度不符一律返回 false，绝不抛给调用方。 */
export async function verifyPassword(
  password: string,
  user: Pick<UserRow, "passwordHash" | "passwordSalt">,
): Promise<boolean> {
  const parts = user.passwordHash.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(parts[4], "base64");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;
  let derived: Buffer;
  try {
    derived = await deriveKey(password, user.passwordSalt, n, r, p);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

/** 用户不存在时也执行一次同成本 scrypt，避免用响应时间枚举邮箱。 */
async function burnPasswordCheck(password: string): Promise<void> {
  try {
    const derived = await deriveKey(password, DUMMY_SALT);
    crypto.timingSafeEqual(derived, Buffer.alloc(SCRYPT_KEY_LENGTH));
  } catch {
    // 仅用于拉平耗时，失败无需处理。
  }
}

/* ── 令牌、恢复码与 Cookie ────────────────────────────────────── */

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function newSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  const chars: string[] = [];
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars.push(RECOVERY_ALPHABET[(value >>> bits) & 31]);
    }
  }
  if (bits > 0) chars.push(RECOVERY_ALPHABET[(value << (5 - bits)) & 31]);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(chars.slice(i, i + RECOVERY_GROUP_SIZE).join(""));
  }
  return groups.join("-");
}

/** 恢复码规范化：忽略大小写、空格与分隔符，兼容用户手抄格式。 */
export function normalizeRecoveryCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "请输入恢复码。");
  }
  const code = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!code || code.length > MAX_RECOVERY_INPUT_LENGTH) {
    throw new HttpError(400, "恢复码格式不正确。");
  }
  return code;
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export function sessionCookie(token: string, config: AppConfig): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    `Expires=${new Date(Date.now() + SESSION_TTL_MS).toUTCString()}`,
  ];
  if (config.cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(config: AppConfig): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (config.cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

function readSessionToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    const raw = part.slice(index + 1).trim();
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/* ── 中间件 ───────────────────────────────────────────────────── */

/** 解析会话 Cookie；数据库错误交给错误中间件，不伪装成未登录。 */
export function attachUser(db: ZhixuDatabase): RequestHandler {
  return (req, _res, next) => {
    const token = readSessionToken(req);
    if (!token) {
      next();
      return;
    }
    try {
      const tokenHash = hashToken(token);
      const session = db.sessionByTokenHash(tokenHash);
      if (!session) {
        next();
        return;
      }
      const row = db.userById(session.userId);
      if (!row) {
        db.deleteSession(tokenHash);
        next();
        return;
      }
      req.authUser = toAuthUser(row);
      req.sessionTokenHash = tokenHash;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    if (!req.authUser) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    next();
  };
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt,
  };
}

/* ── 工作区快照（登录响应复用） ───────────────────────────────── */

function parseWorkspaceData(raw: string | null): StudyBackup | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as StudyBackup) : null;
  } catch {
    return null;
  }
}

export function workspaceSnapshot(
  db: ZhixuDatabase,
  userId: string,
): CloudWorkspace {
  const row = db.getWorkspace(userId);
  if (!row) return { revision: 0, data: null };
  return { revision: row.revision, data: parseWorkspaceData(row.data) };
}

type AuthResultWithServerTime = AuthResult & { serverTime: number };

function authResult(
  db: ZhixuDatabase,
  row: UserRow,
  recoveryCode?: string,
): AuthResultWithServerTime {
  return {
    user: toAuthUser(row),
    ...workspaceSnapshot(db, row.id),
    ...(recoveryCode ? { recoveryCode } : {}),
    // 登录/注册/恢复密码响应也带服务端时间，客户端首次同步前即可校准本机时钟，
    // 避免错误设备时钟把本地旧快照伪装成最新更新。
    serverTime: Date.now(),
  };
}

/* ── 限流 ─────────────────────────────────────────────────────── */

function hashSubject(prefix: string, kind: "email" | "ip" | "user", value: string): string {
  return `${prefix}:${kind}:${hashToken(value)}`;
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export interface RateLimitDecision {
  blocked: boolean;
  retryAfterSeconds: number;
  resetAt: number;
}

export function checkRateLimit(
  db: ZhixuDatabase,
  subject: string,
  policy: RateLimitPolicy,
  now = Date.now(),
): RateLimitDecision {
  const row = db.getRateLimit(subject);
  if (row && row.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((row.blockedUntil - now) / 1000)),
      resetAt: row.blockedUntil,
    };
  }
  return { blocked: false, retryAfterSeconds: 0, resetAt: 0 };
}

/** 记录一次失败/消耗；窗口过期自动重新计数，达到上限后进入封禁。 */
export function recordRateFailure(
  db: ZhixuDatabase,
  subject: string,
  policy: RateLimitPolicy,
  now = Date.now(),
): RateLimitDecision {
  const row = db.getRateLimit(subject);
  const expired = !row || now - row.windowStart >= policy.windowMs;
  const windowStart = expired ? now : row.windowStart;
  const failures = (expired ? 0 : row.failures) + 1;
  const blockedUntil =
    failures >= policy.maxFailures ? Math.max(now + policy.blockMs, row?.blockedUntil ?? 0) : 0;
  db.setRateLimit(subject, windowStart, failures, blockedUntil);
  if (blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
      resetAt: blockedUntil,
    };
  }
  return { blocked: false, retryAfterSeconds: 0, resetAt: 0 };
}

function worstDecision(decisions: RateLimitDecision[]): RateLimitDecision | undefined {
  let worst: RateLimitDecision | undefined;
  for (const decision of decisions) {
    if (!decision.blocked) continue;
    if (!worst || decision.resetAt > worst.resetAt) worst = decision;
  }
  return worst;
}

/** 成功后清理限流计数是附属操作，失败不应让已完成的认证/删除返回 500。 */
function clearRateLimitQuietly(db: ZhixuDatabase, subject: string): void {
  try {
    db.clearRateLimit(subject);
  } catch {
    // 主流程（会话/密码/账户）已经完成，忽略清理失败。
  }
}

function sendRateLimited(res: Response, decision: RateLimitDecision): void {
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  res.status(429).json({
    error: "尝试次数过多，请稍后再试。",
    code: "rate_limited",
    resetAt: decision.resetAt,
  });
}

function auditSubject(email: string): string {
  return `email_hash=${hashToken(email).slice(0, 12)}`;
}

/* ── 请求体 ───────────────────────────────────────────────────── */

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "请求体必须是一个 JSON 对象。");
  }
  return body as Record<string, unknown>;
}

/* ── 路由 ─────────────────────────────────────────────────────── */

export function registerAuthRoutes(
  router: Router,
  config: AppConfig,
  db: ZhixuDatabase,
): void {
  router.post("/auth/register", async (req, res) => {
    const body = bodyObject(req);
    const email = normalizeEmail(body.email);
    const password = validateNewPassword(body.password);
    const name = normalizeName(body.name, email);
    const ipSubject = hashSubject("register", "ip", clientIp(req));
    const registrationLimit = checkRateLimit(db, ipSubject, REGISTER_IP_POLICY);
    if (registrationLimit.blocked) {
      auditRequest(db, req, "auth.register", "denied", "rate_limited");
      sendRateLimited(res, registrationLimit);
      return;
    }

    if (db.userByEmail(email)) {
      auditRequest(db, req, "auth.register", "denied", "duplicate_email");
      throw new HttpError(409, "该邮箱已注册，请直接登录。", { code: "email_taken" });
    }

    const digest = await hashPassword(password);
    const userId = newId();
    const session = newSessionToken();
    const recoveryCode = generateRecoveryCode();
    try {
      db.transaction(() => {
        db.createUser({
          id: userId,
          email,
          name,
          passwordHash: digest.passwordHash,
          passwordSalt: digest.passwordSalt,
        });
        db.initWorkspace(userId);
        db.createSession(userId, session.tokenHash);
        db.createRecoveryCode(userId, hashRecoveryCode(normalizeRecoveryCode(recoveryCode)));
      });
    } catch (error) {
      if (db.userByEmail(email)) {
        auditRequest(db, req, "auth.register", "denied", "duplicate_email");
        throw new HttpError(409, "该邮箱已注册，请直接登录。", { code: "email_taken" });
      }
      throw error;
    }
    recordRateFailure(db, ipSubject, REGISTER_IP_POLICY);

    const row = db.userById(userId);
    if (!row) throw new HttpError(500, "账户创建失败，请稍后重试。");
    res.setHeader("Set-Cookie", sessionCookie(session.token, config));
    auditRequest(db, req, "auth.register", "ok", auditSubject(email));
    res.status(200).json(authResult(db, row, recoveryCode));
  });

  router.post("/auth/login", async (req, res) => {
    const body = bodyObject(req);
    const email = normalizeEmail(body.email);
    if (typeof body.password !== "string" || body.password.length === 0) {
      throw new HttpError(400, "请输入密码。");
    }
    if (body.password.length > MAX_PASSWORD_LENGTH) {
      throw new HttpError(401, "邮箱或密码不正确。");
    }
    const password: string = body.password;

    const emailSubject = hashSubject("login", "email", email);
    const ipSubject = hashSubject("login", "ip", clientIp(req));
    const limit = worstDecision([
      checkRateLimit(db, emailSubject, LOGIN_EMAIL_POLICY),
      checkRateLimit(db, ipSubject, LOGIN_IP_POLICY),
    ]);
    if (limit) {
      auditRequest(db, req, "auth.login", "denied", "rate_limited");
      sendRateLimited(res, limit);
      return;
    }

    const row = db.userByEmail(email);
    const valid = row ? await verifyPassword(password, row) : false;
    if (!row) await burnPasswordCheck(password);
    if (!row || !valid) {
      // 只为已存在的账户记录邮箱维度失败，避免随机邮箱把限流表撑大；
      // 不存在的邮箱仍受来源 IP 限流约束。
      if (row) recordRateFailure(db, emailSubject, LOGIN_EMAIL_POLICY);
      recordRateFailure(db, ipSubject, LOGIN_IP_POLICY);
      auditRequest(db, req, "auth.login", "denied", auditSubject(email));
      throw new HttpError(401, "邮箱或密码不正确。", { code: "invalid_credentials" });
    }

    clearRateLimitQuietly(db, emailSubject);
    const session = newSessionToken();
    db.createSession(row.id, session.tokenHash);
    req.authUser = toAuthUser(row);
    res.setHeader("Set-Cookie", sessionCookie(session.token, config));
    auditRequest(db, req, "auth.login", "ok", auditSubject(email));
    res.status(200).json(authResult(db, row));
  });

  router.post("/auth/logout", (req, res) => {
    if (req.sessionTokenHash) {
      db.deleteSession(req.sessionTokenHash);
      auditRequest(db, req, "auth.logout", "ok");
    }
    res.setHeader("Set-Cookie", clearSessionCookie(config));
    res.status(200).json({ ok: true });
  });

  router.post("/auth/logout-all", requireAuth(), (req, res, next) => {
    const user = req.authUser;
    if (!user) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    db.deleteSessionsForUser(user.id);
    res.setHeader("Set-Cookie", clearSessionCookie(config));
    auditRequest(db, req, "auth.logout_all", "ok");
    res.status(200).json({ ok: true });
  });

  router.get("/auth/me", requireAuth(), (req, res) => {
    res.status(200).json(req.authUser);
  });

  router.post("/auth/recover", async (req, res) => {
    const body = bodyObject(req);
    const email = normalizeEmail(body.email);
    const recoveryInput = normalizeRecoveryCode(body.recoveryCode);
    const newPassword = validateNewPassword(body.password);

    const emailSubject = hashSubject("recover", "email", email);
    const ipSubject = hashSubject("recover", "ip", clientIp(req));
    const limit = worstDecision([
      checkRateLimit(db, emailSubject, RECOVER_EMAIL_POLICY),
      checkRateLimit(db, ipSubject, RECOVER_IP_POLICY),
    ]);
    if (limit) {
      auditRequest(db, req, "auth.recover", "denied", "rate_limited");
      sendRateLimited(res, limit);
      return;
    }

    const row = db.userByEmail(email);
    const codeHash = hashRecoveryCode(recoveryInput);
    const code = db.recoveryByCodeHash(codeHash);
    if (!row || !code || code.userId !== row.id) {
      // 与登录相同，失败路径也执行一次同成本 scrypt，降低邮箱/恢复码枚举的时间信号。
      await burnPasswordCheck(newPassword);
      if (row) recordRateFailure(db, emailSubject, RECOVER_EMAIL_POLICY);
      recordRateFailure(db, ipSubject, RECOVER_IP_POLICY);
      auditRequest(db, req, "auth.recover", "denied", auditSubject(email));
      throw new HttpError(401, "邮箱或恢复码不正确。", { code: "invalid_recovery" });
    }

    const digest = await hashPassword(newPassword);
    const session = newSessionToken();
    const nextRecoveryCode = generateRecoveryCode();
    db.transaction(() => {
      // 先确认用户与恢复码仍然存在：并发两次提交同一恢复码时，
      // 后提交者必须在事务内被拒绝，保证一次性语义。
      if (!db.userById(row.id)) throw new Error("user vanished during recovery");
      const stillValid = db.recoveryByCodeHash(codeHash);
      if (!stillValid || stillValid.userId !== row.id) {
        throw new HttpError(401, "邮箱或恢复码不正确。", { code: "invalid_recovery" });
      }
      db.deleteRecoveryCode(codeHash);
      db.deleteRecoveryCodesForUser(row.id);
      db.updatePassword(row.id, digest.passwordHash, digest.passwordSalt);
      db.deleteSessionsForUser(row.id);
      db.createSession(row.id, session.tokenHash);
      db.createRecoveryCode(row.id, hashRecoveryCode(normalizeRecoveryCode(nextRecoveryCode)));
    });

    clearRateLimitQuietly(db, emailSubject);
    clearRateLimitQuietly(db, ipSubject);
    // 恢复码已验证所有权，同时解除该邮箱的登录封禁。
    clearRateLimitQuietly(db, hashSubject("login", "email", email));
    req.authUser = toAuthUser(row);
    res.setHeader("Set-Cookie", sessionCookie(session.token, config));
    auditRequest(db, req, "auth.recover", "ok", auditSubject(email));
    res.status(200).json(authResult(db, row, nextRecoveryCode));
  });

  router.post("/auth/recovery-code", requireAuth(), async (req, res, next) => {
    const user = req.authUser;
    if (!user) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    const body = bodyObject(req);
    if (typeof body.password !== "string" || !body.password) {
      throw new HttpError(400, "请输入当前密码以生成新的恢复码。");
    }
    const subject = hashSubject("recovery-rotate", "user", user.id);
    const limit = checkRateLimit(db, subject, ACCOUNT_DELETE_POLICY);
    if (limit.blocked) {
      auditRequest(db, req, "auth.recovery_code", "denied", "rate_limited");
      sendRateLimited(res, limit);
      return;
    }
    const row = db.userById(user.id);
    const valid = row ? await verifyPassword(body.password, row) : false;
    if (!row || !valid) {
      await burnPasswordCheck(body.password);
      recordRateFailure(db, subject, ACCOUNT_DELETE_POLICY);
      auditRequest(db, req, "auth.recovery_code", "denied", "password_mismatch");
      throw new HttpError(401, "密码不正确，无法生成新的恢复码。", { code: "invalid_credentials" });
    }
    const recoveryCode = generateRecoveryCode();
    db.transaction(() => {
      db.deleteRecoveryCodesForUser(user.id);
      db.createRecoveryCode(user.id, hashRecoveryCode(normalizeRecoveryCode(recoveryCode)));
    });
    clearRateLimitQuietly(db, subject);
    auditRequest(db, req, "auth.recovery_code", "ok");
    res.status(200).json({ recoveryCode });
  });

  router.delete("/account", requireAuth(), async (req, res, next) => {
    const user = req.authUser;
    if (!user) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    const body = bodyObject(req);
    if (typeof body.password !== "string" || body.password.length === 0) {
      throw new HttpError(400, "请输入当前密码以确认删除账户。");
    }
    const password: string = body.password;
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new HttpError(401, "密码不正确，无法删除账户。", { code: "invalid_credentials" });
    }
    const subject = hashSubject("account", "user", user.id);
    const limit = checkRateLimit(db, subject, ACCOUNT_DELETE_POLICY);
    if (limit.blocked) {
      auditRequest(db, req, "account.delete", "denied", "rate_limited");
      sendRateLimited(res, limit);
      return;
    }

    const row = db.userById(user.id);
    const valid = row ? await verifyPassword(password, row) : false;
    if (!row || !valid) {
      recordRateFailure(db, subject, ACCOUNT_DELETE_POLICY);
      auditRequest(db, req, "account.delete", "denied", "password_mismatch");
      throw new HttpError(401, "密码不正确，无法删除账户。", { code: "invalid_credentials" });
    }

    db.deleteUser(user.id);
    clearRateLimitQuietly(db, hashSubject("login", "email", user.email));
    clearRateLimitQuietly(db, hashSubject("recover", "email", user.email));
    clearRateLimitQuietly(db, subject);
    res.setHeader("Set-Cookie", clearSessionCookie(config));
    auditRequest(db, req, "account.delete", "ok");
    res.status(200).json({ ok: true });
  });
}

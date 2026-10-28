import type { Request, Response } from "express";
import type { QuotaLimits } from "./config";
import { utcDay, type UsageKind, type ZhixuDatabase } from "./db";
import { auditRequest } from "./security";

/**
 * 每用户每日（UTC）额度：
 * - 在模型调用前原子扣减，超限返回 429 + Retry-After + resetAt；
 * - 未登录的本地开发模式不计额度（公共模式已由 requireAuth 拦截）；
 * - 额度表按 user_id + UTC 日期隔离。
 */

export const QUOTA_LABELS: Record<UsageKind, string> = {
  chat: "对话",
  diagnostic: "诊断",
  review: "复习补讲",
};

/**
 * 单节点进程内并发闸门：同一账户最多同时进行 N 个 AI 请求。
 * 日额度只限制总量，若不限制并发，一个账户仍可瞬间发起数十次高价调用。
 * 返回幂等 release；达到上限时返回 undefined。多实例部署不共享此状态，
 * 因此仍明确只支持单节点（运维文档已声明）。
 */
const activeRequests = new Map<string, number>();

/** 通用单进程并发槽位（AI 与大型工作区写入共用实现）。 */
export function acquireConcurrencySlot(
  subject: string,
  limit: number,
): (() => void) | undefined {
  const active = activeRequests.get(subject) ?? 0;
  if (active >= limit) return undefined;
  activeRequests.set(subject, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeRequests.get(subject) ?? 1) - 1;
    if (remaining <= 0) activeRequests.delete(subject);
    else activeRequests.set(subject, remaining);
  };
}

export function acquireAiConcurrency(
  userId: string,
  limit: number,
): (() => void) | undefined {
  return acquireConcurrencySlot(`ai:${userId}`, limit);
}

/** 测试与运维诊断用：当前在途数量，不暴露用户标识。 */
export function activeAiRequestCount(): number {
  let total = 0;
  for (const [subject, count] of activeRequests) {
    if (subject.startsWith("ai:")) total += count;
  }
  return total;
}

export function nextUtcResetAt(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function quotaLimitFor(limits: QuotaLimits, kind: UsageKind): number {
  if (kind === "chat") return limits.chatPerDay;
  if (kind === "diagnostic") return limits.diagnosticPerDay;
  return limits.reviewPerDay;
}

export interface QuotaDecision {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export function consumeQuota(
  db: ZhixuDatabase,
  userId: string,
  kind: UsageKind,
  limits: QuotaLimits,
  now = Date.now(),
): QuotaDecision {
  const limit = quotaLimitFor(limits, kind);
  const resetAt = nextUtcResetAt(now);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  const day = utcDay(now);

  if (limit <= 0) {
    return {
      allowed: false,
      limit: 0,
      used: db.usage(userId, day)[kind],
      remaining: 0,
      resetAt,
      retryAfterSeconds,
    };
  }

  const usage = db.consumeUsage(userId, day, kind, limit);
  if (!usage) {
    return {
      allowed: false,
      limit,
      used: db.usage(userId, day)[kind],
      remaining: 0,
      resetAt,
      retryAfterSeconds,
    };
  }
  return {
    allowed: true,
    limit,
    used: usage[kind],
    remaining: Math.max(0, limit - usage[kind]),
    resetAt,
    retryAfterSeconds: 0,
  };
}

function quotaMessage(kind: UsageKind, limit: number): string {
  const label = QUOTA_LABELS[kind];
  if (limit <= 0) return `今天的${label}额度未开放（每日上限 0 次）。`;
  return `今天的${label}次数已用完（每日上限 ${limit} 次）。`;
}

/**
 * 路由内调用：返回 true 表示已扣减、可以继续；false 表示已写出 429，调用方必须停止。
 * 未登录时不扣减（本地开发），由调用方决定是否需要登录。
 */
export function enforceQuota(
  req: Request,
  res: Response,
  db: ZhixuDatabase,
  limits: QuotaLimits,
  kind: UsageKind,
): boolean {
  const user = req.authUser;
  if (!user) return true;
  const decision = consumeQuota(db, user.id, kind, limits);
  if (decision.allowed) return true;

  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  auditRequest(
    db,
    req,
    "quota.denied",
    "denied",
    `${kind}:${decision.used}/${decision.limit}`,
  );
  res.status(429).json({
    error: quotaMessage(kind, decision.limit),
    code: "quota_exceeded",
    resetAt: decision.resetAt,
  });
  return false;
}

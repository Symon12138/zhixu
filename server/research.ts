import type { Request } from "express";
import type { Reference, ResearchAttachItem, ResearchEvidence, ResearchJob, ResearchJobStatus, WebReferenceVerification, WebSourceTier } from "../src/types";
import type { ZhixuDatabase } from "./db";
import { auditRequest } from "./security";
import { searchWebEvidence, WebSearchError } from "./webSearch";
import type { SearchEvidenceOptions, SearchHit, SearchProvider } from "./webSearch";
import { fetchWebSource, WebFetchError, webFetchEnabled } from "./web";



/**
 * C3 后台研究：单节点进程内异步任务。
 *
 * - 任务全程不持有 HTTP 响应：POST 立即返回 jobId，执行在 fire-and-forget 中推进，
 *   因此不会阻塞教学回合（chat 请求与任务并行）。
 * - 仅内存 Map 跟踪，不做持久化：进程重启后所有任务（含状态与结果）全部丢失，
 *   已扣的每日额度仍在 SQLite 中。GET 未知 id 会返回 404。
 * - 安全：来源核验沿用 web.ts 的白名单/HTTPS/SSRF 防护，研究产物只含公开来源，
 *   不含请求体或密钥；前端以纯文本渲染，不注入 HTML。
 */

export const RESEARCH_MAX_QUERY_CHARS = 500;
export const RESEARCH_MAX_SOURCES = 8;
export const RESEARCH_MIN_SOURCES = 1;
/** 单个任务的整体时限；超时后以 failed 落地并中止在途网络请求。 */
export const RESEARCH_JOB_TIMEOUT_MS = 60_000;
/** 完成任务在内存中的保留时长，避免长期运行进程无限增长。 */
export const RESEARCH_TTL_MS = 30 * 60_000;

export class ResearchValidationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ResearchValidationError";
  }
}

/** 审计/额度回调，由 index.ts 注入，令引擎与 Express/配额解耦、便于定向测试。 */
export interface ResearchHooks {
  db: ZhixuDatabase;
  /** 计每日额度；返回 false 表示已写出 429，调用方必须停止。 */
  consume: (req: Request, res: unknown, kind: "chat" | "diagnostic" | "review") => boolean;
}

interface InternalJob {
  jobId: string;
  status: ResearchJobStatus;
  query: string;
  maxSources: number;
  ownerId: string | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: ResearchEvidence[];
  error?: string;
  controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  expiresAt?: number;
}

export interface CreateResearchInput {
  query: string;
  maxSources: number;
  /** 可选：测试注入的搜索供应商链与 ask 实现；生产留空走 webSearch 默认。 */
  providers?: SearchProvider[];
  ask?: (provider: SearchProvider, query: string, signal?: AbortSignal) => Promise<{ title: string; url: string; text: string; publishedAt?: string }[]>;
  /** 可选：测试注入的时钟；生产留空。 */
  now?: () => Date;
}

const TIERS: WebSourceTier[] = ["official", "primary", "secondary", "unknown"];

function tier(value: unknown): WebSourceTier {
  return TIERS.includes(value as WebSourceTier) ? (value as WebSourceTier) : "unknown";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** 搜索摘要 → 研究证据：摘要本身即逐字引文，绝不由模型改写。 */
function fromReference(ref: Reference): ResearchEvidence {
  return {
    url: ref.url ?? "",
    retrievedAt: ref.retrievedAt ?? new Date().toISOString(),
    quote: ref.text,
    sourceTier: tier(ref.sourceTier),
    title: ref.name,
    verification: ref.verification ?? "search_snippet",
  };
}

/** 把研究证据转换成调用方可挂入教学回合的 Reference 形态（不改 App.tsx）。 */
export function toAttachItems(job: ResearchJob): ResearchAttachItem[] {
  return (job.result ?? []).map((item) => ({
    name: item.title,
    text: item.quote,
    url: item.url,
    retrievedAt: item.retrievedAt,
    sourceTier: item.sourceTier,
    verification: item.verification,
    ...(item.verification === "claim_matched" ? { verifiedQuote: item.quote } : {}),
  }));
}

/** 校验并规范化创建参数；非法输入在扣额度前抛出。 */
export function parseResearchCreate(body: unknown): { query: string; maxSources: number } {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) throw new ResearchValidationError(400, "research_query_required", "请填写研究问题。");
  if (query.length > RESEARCH_MAX_QUERY_CHARS) {
    throw new ResearchValidationError(400, "research_query_too_long", `研究问题不能超过 ${RESEARCH_MAX_QUERY_CHARS} 字符。`);
  }
  let maxSources = RESEARCH_MAX_SOURCES;
  if (record.maxSources !== undefined) {
    if (typeof record.maxSources !== "number" || !Number.isFinite(record.maxSources)) {
      throw new ResearchValidationError(400, "research_maxsources_invalid", "maxSources 必须是数字。");
    }
    maxSources = Math.max(RESEARCH_MIN_SOURCES, Math.min(RESEARCH_MAX_SOURCES, Math.floor(record.maxSources)));
  }
  return { query, maxSources };
}

/**
 * 后台研究任务管理器。每个 createApp 装配一个实例（与 webHits Map 同样生命周期），
 * 不持久化、不跨节点共享。
 */
export class ResearchManager {
  private readonly jobs = new Map<string, InternalJob>();
  private counter = 0;

  constructor(private readonly db: ZhixuDatabase) {}

  private newId(): string {
    this.counter += 1;
    // 进程内唯一；含随机后缀避免跨进程/重启后碰撞。
    return `rj_${Date.now().toString(36)}_${this.counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 清理已过期任务（惰性，GET/create 时触发），避免内存无界增长。 */
  private prune(now = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (job.expiresAt !== undefined && job.expiresAt <= now) this.jobs.delete(id);
    }
  }

  /** 对外快照：绝不暴露 AbortController、计时器等内部字段。 */
  snapshot(id: string): ResearchJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return {
      jobId: job.jobId,
      status: job.status,
      query: job.query,
      maxSources: job.maxSources,
      ownerId: job.ownerId,
      createdAt: job.createdAt,
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.result ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
  }

  /**
   * 创建任务并立即返回 pending 快照；耗时工作交给 run() 异步推进，
   * 调用方不 await，因此 POST 与后续教学回合都不被阻塞。
   */
  create(
    req: Request,
    input: CreateResearchInput & { query: string; maxSources: number },
  ): ResearchJob {
    this.prune();
    const jobId = this.newId();
    const job: InternalJob = {
      jobId,
      status: "pending",
      query: input.query,
      maxSources: input.maxSources,
      ownerId: req.authUser?.id ?? null,
      createdAt: Date.now(),
      controller: new AbortController(),
    };
    this.jobs.set(jobId, job);
    // fire-and-forget：内部捕获所有异常并落地为 failed，绝不产生未处理的 rejection。
    void this.run(job, input);
    return this.snapshot(jobId)!;
  }

  /** 取消：仅 pending/running 可取消；中止在途网络请求并清计时器。 */
  cancel(id: string): "cancelled" | "finished" | "not_found" {
    const job = this.jobs.get(id);
    if (!job) return "not_found";
    if (job.status !== "pending" && job.status !== "running") return "finished";
    job.status = "cancelled";
    job.finishedAt = Date.now();
    job.expiresAt = job.finishedAt + RESEARCH_TTL_MS;
    job.controller.abort(new DOMException("后台研究任务已取消。", "AbortError"));
    if (job.timeout) clearTimeout(job.timeout);
    auditRequest(this.db, { requestId: "research", authUser: job.ownerId ? { id: job.ownerId } : undefined } as unknown as Request, "research.cancel", "ok", job.jobId);
    return "cancelled";
  }

  private finish(job: InternalJob, status: "done" | "failed", payload: { result?: ResearchEvidence[]; error?: string }): void {
    // 取消/超时已经落地时，晚到的结果不得覆盖终态。
    if (job.status !== "running" && job.status !== "pending") return;
    if (job.timeout) clearTimeout(job.timeout);
    job.status = status;
    job.finishedAt = Date.now();
    job.expiresAt = job.finishedAt + RESEARCH_TTL_MS;
    if (payload.result) job.result = payload.result;
    if (payload.error !== undefined) job.error = payload.error;
    const owner = job.ownerId ? { id: job.ownerId } : undefined;
    const pseudoReq = { requestId: `research-${job.jobId}`, authUser: owner } as unknown as Request;
    auditRequest(this.db, pseudoReq, status === "done" ? "research.done" : "research.failed", status === "done" ? "ok" : "failed", status === "done" ? `${job.jobId}:${payload.result?.length ?? 0}` : payload.error);
  }

  private async run(job: InternalJob, input: CreateResearchInput & { query: string; maxSources: number }): Promise<void> {
    job.status = "running";
    job.startedAt = Date.now();
    job.timeout = setTimeout(() => {
      job.controller.abort(new DOMException("后台研究任务超时。", "AbortError"));
      this.finish(job, "failed", { error: "后台研究任务超时（60 秒），已中止。" });
    }, RESEARCH_JOB_TIMEOUT_MS);
    job.timeout.unref?.();

    const checkAbort = (): void => {
      if (job.controller.signal.aborted) throw new DOMException("后台研究任务已中止。", "AbortError");
    };

    try {
      const evidence: ResearchEvidence[] = [];
      const now = input.now;

      // 阶段 1：联网搜索，得到候选来源（摘要即逐字引文）。
      const searchOptions: Parameters<typeof searchWebEvidence>[1] = {
        signal: job.controller.signal,
        ...(input.providers ? { providers: input.providers } : {}),
        ...(input.ask ? { ask: input.ask } : {}),
        ...(now ? { now } : {}),
      };
      let references: Reference[];
      try {
        references = await searchWebEvidence(input.query, searchOptions);
      } catch (error) {
        if (job.controller.signal.aborted) throw error;
        const message = error instanceof WebSearchError ? error.message : "联网搜索失败。";
        throw new Error(`联网搜索失败：${message}`);
      }
      checkAbort();

      const seen = new Set<string>();
      for (const ref of references) {
        if (evidence.length >= job.maxSources) break;
        checkAbort();
        if (!ref.url || seen.has(ref.url)) continue;
        seen.add(ref.url);
        let item: ResearchEvidence = fromReference(ref);

        // 阶段 2：部署开启抓取时，用 URL + 摘要作逐字 claim 建立页面证据；
        // 未开启或抓取失败时保留搜索摘要证据，并把核验状态如实标记。
        if (webFetchEnabled()) {
          try {
            const page = await fetchWebSource(ref.url, ref.text, { ...(now ? { now } : {}) });
            checkAbort();
            const matched = page.claim?.matched === true && typeof page.claim.quote === "string";
            const verification: WebReferenceVerification = matched ? "claim_matched" : "page_fetched";
            item = {
              url: page.finalUrl || page.url || ref.url,
              retrievedAt: page.retrievedAt,
              quote: matched ? page.claim!.quote! : ref.text,
              sourceTier: tier(page.sourceTier),
              title: text(page.title, ref.name),
              verification,
            };
          } catch (error) {
            if (job.controller.signal.aborted) throw error;
            // 单页抓取失败（含 WebFetchError）不拖垮整条研究：保留搜索摘要证据。
            const code = error instanceof WebFetchError ? error.code : "fetch_failed";
            const pseudoReq = { requestId: `research-${job.jobId}`, authUser: job.ownerId ? { id: job.ownerId } : undefined } as unknown as Request;
            auditRequest(this.db, pseudoReq, "research.fetch", "failed", `${code}:${ref.url}`);
          }
        }
        evidence.push(item);
      }

      if (!evidence.length) throw new Error("联网搜索没有返回可用来源。");
      checkAbort();
      this.finish(job, "done", { result: evidence });
    } catch (error) {
      // 异步期间 cancel() 可能已改状态；显式断言避免 TS 把 status 收窄为 "running"。
      const current = job.status as ResearchJobStatus;
      if (current === "cancelled" || current === "failed") return;
      const aborted = job.controller.signal.aborted;
      const raw = error instanceof Error ? error.message : String(error);
      const message = aborted
        ? "后台研究任务已取消。"
        : `后台研究失败：${raw}`.slice(0, 300);
      this.finish(job, "failed", { error: message });
    }
  }
}

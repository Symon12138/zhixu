import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZhixuDatabase } from "../server/db";
import {
  parseResearchCreate,
  ResearchManager,
  ResearchValidationError,
  toAttachItems,
  type CreateResearchInput,
} from "../server/research";
import type { Request } from "express";

/* ── C3 后台研究：参数校验、状态机、结果结构与不阻塞 ─────────── */

function fakeRequest(userId = "user-a"): Request {
  return { authUser: { id: userId }, requestId: "research-test" } as unknown as Request;
}

function tempDb(): ZhixuDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-research-"));
  return new ZhixuDatabase(path.join(dir, "zhixu.db"));
}

/**
 * 研究任务是 fire-and-forget，内部还有真实 60 秒超时定时器；没有对外暴露
 * 可等待的事件，因此这里对状态做有界轮询（集成测试真实时钟例外）。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待研究任务状态超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("parseResearchCreate 在扣额度前校验：缺 query、超长、maxSources 范围", () => {
  assert.deepEqual(parseResearchCreate({ query: " 导数为什么是极限 " }), {
    query: "导数为什么是极限",
    maxSources: 8,
  });
  assert.deepEqual(parseResearchCreate({ query: "a", maxSources: 2 }), { query: "a", maxSources: 2 });
  assert.deepEqual(parseResearchCreate({ query: "a", maxSources: 999 }), { query: "a", maxSources: 8 });
  assert.throws(
    () => parseResearchCreate({}),
    (error: unknown) => error instanceof ResearchValidationError && error.code === "research_query_required",
  );
  assert.throws(
    () => parseResearchCreate({ query: "x".repeat(501) }),
    (error: unknown) => error instanceof ResearchValidationError && error.code === "research_query_too_long",
  );
  assert.throws(
    () => parseResearchCreate({ query: "a", maxSources: "2" }),
    (error: unknown) => error instanceof ResearchValidationError && error.code === "research_maxsources_invalid",
  );
});

test("创建任务立即返回 pending，不等待研究完成；结果含 URL/引文/时间/来源等级", async () => {
  const db = tempDb();
  try {
    const manager = new ResearchManager(db);
    let resolveAsk: ((hits: { title: string; url: string; text: string }[]) => void) | undefined;
    const gate = new Promise<{ title: string; url: string; text: string }[]>(resolve => { resolveAsk = resolve; });
    const input: CreateResearchInput & { query: string; maxSources: number } = {
      query: "导数的极限定义",
      maxSources: 2,
      providers: [{ vendor: "you", key: "", base: "https://you.com" }],
      ask: async () => gate,
    };
    const job = manager.create(fakeRequest(), input);
    // create 同步返回，研究仍在进行（未阻塞）。
    assert.ok(["pending", "running"].includes(job.status), "create 立即返回，不等研究完成");
    assert.ok(job.jobId.startsWith("rj_"));
    assert.ok(["pending", "running"].includes(manager.snapshot(job.jobId)?.status ?? ""));
    assert.equal(manager.snapshot(job.jobId)?.result, undefined);

    resolveAsk!([
      { title: "教材甲", url: "https://example.edu/a", text: "导数是割线斜率的极限" },
    ]);
    await waitFor(() => manager.snapshot(job.jobId)?.status === "done");
    const done = manager.snapshot(job.jobId)!;
    assert.equal(done.status, "done");
    assert.equal(done.result?.length, 1);
    assert.equal(done.result?.[0].url, "https://example.edu/a");
    assert.equal(done.result?.[0].quote, "导数是割线斜率的极限");
    assert.match(done.result?.[0].retrievedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(["official", "primary", "secondary", "unknown"].includes(done.result?.[0].sourceTier ?? ""));

    const attached = toAttachItems(done);
    assert.equal(attached[0].name, "教材甲");
    assert.equal(attached[0].text, "导数是割线斜率的极限");
    assert.equal(attached[0].url, "https://example.edu/a");
  } finally {
    db.close?.();
  }
});

test("取消 pending/running 任务后结果为终态，不能再次取消；不存在返回 not_found", () => {
  const db = tempDb();
  try {
    const manager = new ResearchManager(db);
    const job = manager.create(fakeRequest(), {
      query: "测试",
      maxSources: 1,
      providers: [{ vendor: "you", key: "", base: "https://you.com" }],
      ask: async () => new Promise(() => undefined),
    });
    assert.equal(manager.cancel(job.jobId), "cancelled");
    assert.equal(manager.snapshot(job.jobId)?.status, "cancelled");
    assert.equal(manager.cancel(job.jobId), "finished", "终态不可再次取消");
    assert.equal(manager.cancel("rj_missing"), "not_found");
  } finally {
    db.close?.();
  }
});

test("研究失败时错误可见，不抛未处理异常；查询不存在任务返回 undefined", async () => {
  const db = tempDb();
  try {
    const manager = new ResearchManager(db);
    const job = manager.create(fakeRequest(), {
      query: "会失败的问题",
      maxSources: 1,
      providers: [{ vendor: "you", key: "", base: "https://you.com" }],
      ask: async () => { throw new Error("供应商不可用"); },
    });
    await waitFor(() => manager.snapshot(job.jobId)?.status === "failed");
    const failed = manager.snapshot(job.jobId)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /失败/);
    assert.equal(manager.snapshot("rj_none"), undefined);
  } finally {
    db.close?.();
  }
});

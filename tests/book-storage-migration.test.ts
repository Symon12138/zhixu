import assert from "node:assert/strict";
import test from "node:test";
import type { BookDocument, BookProgress } from "../src/bookTypes";
import {
  bookMigrationLedgerKey,
  mergeBookMigrationLedger,
  parseBookMigrationLedger,
  planBookMigration,
  runBookMigration,
  type BookMigrationDestination,
  type BookMigrationSink,
  type BookMigrationSource,
} from "../src/lib/bookStorage";

/* ── 夹具 ─────────────────────────────────────────────────────── */

function bookFixture(id: string, sha256: string, text = "匿名书架原文"): BookDocument {
  return {
    id,
    title: `书 ${id}`,
    author: "示例作者",
    format: "txt",
    fileName: `${id}.txt`,
    byteLength: new TextEncoder().encode(text).byteLength,
    sha256,
    importedAt: 1_700_000_000_000,
    chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1"] }],
    blocks: [{ id: "c1-b1", chapterId: "c1", text, locator: "第一章 · 第1段" }],
    warnings: [],
    original: new Blob([text]),
  };
}

function progressFixture(bookId: string, overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId,
    chapterId: "c1",
    blockId: "c1-b1",
    readChapterIds: ["c1"],
    updatedAt: 1_700_000_000_500,
    ...overrides,
  };
}

function emptyDestination(): BookMigrationDestination {
  return { bookShas: {}, progressIds: [] };
}

function recordingSink(
  write: BookMigrationSink["write"],
): { sink: BookMigrationSink; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sink: {
      write,
      enqueue: book => { calls.push(`enqueue:${book.id}`); },
      notify: () => { calls.push("notify"); },
      recordMigrated: books => { calls.push(`ledger:${books.map(book => book.id).join(",")}`); },
    },
  };
}

/* ── 合并计划 ─────────────────────────────────────────────────── */

test("迁移计划补入匿名库独有的书与进度，不改动匿名源数据", () => {
  const first = bookFixture("book-a", "a".repeat(64));
  const second = bookFixture("book-b", "b".repeat(64));
  const sourceBooks = [first, second];
  const sourceProgress = [progressFixture(first.id)];
  const snapshot = JSON.stringify({ books: sourceBooks, progress: sourceProgress });

  const plan = planBookMigration(sourceBooks, sourceProgress, {}, []);

  assert.deepEqual(plan.books.map(book => book.id), ["book-a", "book-b"]);
  assert.deepEqual(plan.progress.map(item => item.bookId), ["book-a"]);
  assert.deepEqual(plan.skippedBooks, []);
  assert.deepEqual(plan.skippedProgress, []);
  assert.equal(sourceBooks.length, 2);
  assert.equal(sourceProgress.length, 1);
  assert.equal(JSON.stringify({ books: sourceBooks, progress: sourceProgress }), snapshot);
});

test("台账已记录的书即使账户库缺失也不再补回，匿名库后来新增的书仍迁移", () => {
  const deleted = bookFixture("book-deleted", "a".repeat(64));
  const addedLater = bookFixture("book-added-later", "b".repeat(64));
  const plan = planBookMigration(
    [deleted, addedLater],
    [progressFixture(deleted.id), progressFixture(addedLater.id)],
    {},
    [],
    [deleted.id],
  );
  assert.deepEqual(plan.books.map(book => book.id), [addedLater.id]);
  assert.deepEqual(plan.skippedBooks, [deleted.id]);
  assert.deepEqual(plan.progress.map(item => item.bookId), [addedLater.id]);

  const stillInAccount = planBookMigration(
    [deleted],
    [progressFixture(deleted.id)],
    { [deleted.id]: deleted.sha256 },
    [],
    [deleted.id],
  );
  assert.deepEqual(stillInAccount.books, []);
  assert.deepEqual(stillInAccount.progress, []);
});

test("迁移台账只接受版本1的字符串 id 数组，损坏数据按空台账处理", () => {
  assert.deepEqual(
    parseBookMigrationLedger(JSON.stringify({ version: 1, bookIds: ["book-a", "book-a", "", 3] })),
    ["book-a"],
  );
  assert.deepEqual(parseBookMigrationLedger(null), []);
  assert.deepEqual(parseBookMigrationLedger("{broken"), []);
  assert.deepEqual(parseBookMigrationLedger(JSON.stringify({ version: 2, bookIds: ["book-a"] })), []);
  assert.deepEqual(parseBookMigrationLedger(JSON.stringify({ version: 1, bookIds: "book-a" })), []);
});

test("迁移台账按账户隔离，A 的记录不会成为 B 的键", () => {
  const a = bookMigrationLedgerKey("user-a");
  const b = bookMigrationLedgerKey("user-b");
  assert.notEqual(a, b);
  assert.match(a, /^zhixu-book-migration:v1:/);
  assert.match(b, /^zhixu-book-migration:v1:/);
});

test("台账写回保留已有 id、去重，且只存 version 与 bookIds", () => {
  const raw = mergeBookMigrationLedger(
    JSON.stringify({ version: 1, bookIds: ["book-old"] }),
    ["book-new", "book-old", ""],
  );
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["bookIds", "version"]);
  assert.deepEqual(parsed.bookIds, ["book-old", "book-new"]);
  assert.equal(raw.includes("title"), false);
  assert.equal(raw.includes("text"), false);
});

test("账户库已有同 id 书时绝不覆盖；同 sha 仍可补进度，不同 sha 的进度被拒绝", () => {
  const sameSha = bookFixture("book-shared", "a".repeat(64));
  const conflict = bookFixture("book-conflict", "c".repeat(64));
  const planSame = planBookMigration(
    [sameSha],
    [progressFixture(sameSha.id)],
    { [sameSha.id]: sameSha.sha256 },
    [],
  );
  assert.deepEqual(planSame.books, []);
  assert.deepEqual(planSame.skippedBooks, [sameSha.id]);
  assert.deepEqual(planSame.progress.map(item => item.bookId), [sameSha.id]);

  const planConflict = planBookMigration(
    [conflict],
    [progressFixture(conflict.id)],
    { [conflict.id]: "d".repeat(64) },
    [],
  );
  assert.deepEqual(planConflict.books, []);
  assert.deepEqual(planConflict.progress, []);
  assert.deepEqual(planConflict.skippedProgress, [conflict.id]);
});

test("账户已有进度优先；无效章节/段落/已读列表与孤儿进度都不迁移", () => {
  const book = bookFixture("book-a", "a".repeat(64));
  const planExistingProgress = planBookMigration(
    [book],
    [progressFixture(book.id)],
    {},
    [book.id],
  );
  assert.deepEqual(planExistingProgress.progress, []);
  assert.deepEqual(planExistingProgress.skippedProgress, [book.id]);

  const plan = planBookMigration(
    [book],
    [
      progressFixture(book.id, { chapterId: "missing" }),
      progressFixture(book.id, { blockId: "missing-block" }),
      progressFixture(book.id, { readChapterIds: ["missing-chapter"] }),
      progressFixture("book-orphan"),
      progressFixture(book.id),
    ],
    {},
    [],
  );
  assert.deepEqual(plan.progress.map(item => item.bookId), [book.id]);
  assert.deepEqual(plan.skippedProgress, [book.id, book.id, book.id, "book-orphan"]);
});

test("同一本书的重复进度只保留一条", () => {
  const book = bookFixture("book-a", "a".repeat(64));
  const plan = planBookMigration(
    [book],
    [progressFixture(book.id), progressFixture(book.id, { chapterId: "c1" })],
    {},
    [],
  );
  assert.equal(plan.progress.length, 1);
  assert.deepEqual(plan.skippedProgress, [book.id]);
});

/* ── 可注入迁移流程：完成与取消 ───────────────────────────────── */

test("迁移流程把台账 id 传给计划，已删书不会进入写入", async () => {
  const book = bookFixture("book-deleted", "a".repeat(64));
  let plannedIds: string[] = ["not-called"];
  const result = await runBookMigration({
    isCurrent: () => true,
    readSource: async () => ({ books: [book], progress: [progressFixture(book.id)] }),
    readDestination: async () => emptyDestination(),
    migratedBookIds: [book.id],
    sink: {
      write: async plan => {
        plannedIds = plan.books.map(item => item.id);
        return { books: [], progress: 0, cancelled: false };
      },
      enqueue: () => { throw new Error("不应上传"); },
      notify: () => { throw new Error("不应刷新"); },
    },
  });
  assert.deepEqual(plannedIds, []);
  assert.deepEqual(result, { status: "completed", migratedBooks: 0, migratedProgress: 0 });
});

test("迁移流程完成后才触发上传队列与刷新通知", async () => {
  const book = bookFixture("book-a", "a".repeat(64));
  const source: BookMigrationSource = { books: [book], progress: [progressFixture(book.id)] };
  const { sink, calls } = recordingSink(async () => {
    calls.push("write");
    return { books: [book], progress: 1, cancelled: false };
  });
  const result = await runBookMigration({
    isCurrent: () => true,
    readSource: async () => source,
    readDestination: async () => emptyDestination(),
    sink,
  });
  assert.deepEqual(result, { status: "completed", migratedBooks: 1, migratedProgress: 1 });
  assert.deepEqual(calls, ["write", "ledger:book-a", "enqueue:book-a", "notify"]);
});

test("进入流程前 owner 已切换时不读取、不写入、不通知", async () => {
  const book = bookFixture("book-a", "a".repeat(64));
  let reads = 0;
  const { sink, calls } = recordingSink(async () => {
    calls.push("write");
    return { books: [book], progress: 0, cancelled: false };
  });
  const result = await runBookMigration({
    isCurrent: () => false,
    readSource: async () => { reads += 1; return { books: [book], progress: [] }; },
    readDestination: async () => { reads += 1; return emptyDestination(); },
    sink,
  });
  assert.deepEqual(result, { status: "cancelled", migratedBooks: 0, migratedProgress: 0 });
  assert.equal(reads, 0);
  assert.deepEqual(calls, []);
});

test("读取匿名库后切换 owner 立即取消，不进入账户写入", async () => {
  const book = bookFixture("book-a", "a".repeat(64));
  let current = true;
  const { sink, calls } = recordingSink(async () => {
    calls.push("write");
    return { books: [book], progress: 0, cancelled: false };
  });
  const result = await runBookMigration({
    isCurrent: () => current,
    readSource: async () => {
      current = false;
      return { books: [book], progress: [] };
    },
    readDestination: async () => emptyDestination(),
    sink,
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, []);
});

test("写入事务检测到 owner 切换时按取消返回，不回传已写书籍", async () => {
  const book = bookFixture("book-a", "a".repeat(64));
  let current = true;
  const { sink, calls } = recordingSink(async (_plan, _source, isCurrent) => {
    calls.push("write");
    current = false;
    assert.equal(isCurrent(), false);
    return { books: [], progress: 0, cancelled: true };
  });
  const result = await runBookMigration({
    isCurrent: () => current,
    readSource: async () => ({ books: [book], progress: [] }),
    readDestination: async () => emptyDestination(),
    sink,
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, ["write"]);
});

test("写入已提交后 owner 切换：仍记入原账户台账，但不触发上传或刷新", async () => {
  const book = bookFixture("book-a", "a".repeat(64));
  let current = true;
  const calls: string[] = [];
  const result = await runBookMigration({
    isCurrent: () => current,
    readSource: async () => ({ books: [book], progress: [] }),
    readDestination: async () => emptyDestination(),
    sink: {
      write: async () => {
        current = false;
        return { books: [book], progress: 0, cancelled: false };
      },
      recordMigrated: books => { calls.push(`ledger:${books.map(item => item.id).join(",")}`); },
      enqueue: () => { calls.push("enqueue"); },
      notify: () => { calls.push("notify"); },
    },
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, ["ledger:book-a"]);
});

test("后台上传触发失败不回滚已完成的本地迁移", async () => {
  const book = bookFixture("book-a", "a".repeat(64));
  const calls: string[] = [];
  const result = await runBookMigration({
    isCurrent: () => true,
    readSource: async () => ({ books: [book], progress: [] }),
    readDestination: async () => emptyDestination(),
    sink: {
      write: async () => ({ books: [book], progress: 0, cancelled: false }),
      enqueue: () => { calls.push("enqueue"); throw new Error("queue unavailable"); },
      notify: () => { calls.push("notify"); },
    },
  });
  assert.deepEqual(result, { status: "completed", migratedBooks: 1, migratedProgress: 0 });
  assert.deepEqual(calls, ["enqueue", "notify"]);
});
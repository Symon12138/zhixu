import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { BookDocument, CloudBookSummary } from "../src/bookTypes";
import { deleteCloudBook, mergeBookSummaries } from "../src/lib/cloudBooks";
import type { Fetcher } from "../src/lib/cloudSync";
import {
  BOOK_DELETION_MARKER_TTL_MS,
  BookUploadQueue,
  bookDeletionKey,
  bookUploadKey,
  clearBookDeletionMarkers,
  getBookOwnerEpoch,
  isBookDeleted,
  markBookDeleted,
  parseBookDeletionMarkers,
  purgeTombstonedBooks,
  runGuardedBookUpload,
  saveBook,
  setBookOwner,
  unmarkBookDeleted,
  withoutDeletedBooks,
  type BookUploadOutcome,
} from "../src/lib/bookStorage";

/* ── 夹具 ─────────────────────────────────────────────────────── */

const CONTENT = "上传中删除也不能让书籍复活。";
const BYTES = new TextEncoder().encode(CONTENT);
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const BOOK_ID = `book-${SHA256.slice(0, 24)}`;

function bookFixture(): BookDocument {
  return {
    id: BOOK_ID,
    title: "删除与上传",
    author: "",
    format: "txt",
    fileName: "delete-race.txt",
    byteLength: BYTES.byteLength,
    sha256: SHA256,
    importedAt: 1_700_000_000_000,
    chapters: [{ id: "c1", title: "第一章", blockIds: ["b1"] }],
    blocks: [{ id: "b1", chapterId: "c1", text: CONTENT, locator: "第1段" }],
    warnings: [],
    original: new Blob([BYTES]),
  };
}

function summaryFixture(id: string): CloudBookSummary {
  return {
    id,
    title: `云端 ${id}`,
    author: "",
    format: "txt",
    fileName: `${id}.txt`,
    byteLength: BYTES.byteLength,
    importedAt: 1_700_000_000_000,
    chapterCount: 1,
    blockCount: 1,
    characters: CONTENT.length,
    warnings: [],
    updatedAt: 1_700_000_001_000,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CloudCall {
  method: string;
  path: string;
  userId: string | null;
}

interface CloudHarness {
  fetcher: Fetcher;
  calls: CloudCall[];
  ready: Set<string>;
  readyEver: Set<string>;
  pending: Set<string>;
}

/** 可控云端：meta/original 可在测试指定处暂停，验证删除与上传的交错。 */
function cloudHarness(options: {
  userId: string;
  onMeta?: () => Promise<void> | void;
  onOriginal?: () => Promise<void> | void;
}): CloudHarness {
  const calls: CloudCall[] = [];
  const ready = new Set<string>();
  const readyEver = new Set<string>();
  const pending = new Set<string>();
  const fetcher: Fetcher = async (path, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const userId = headers.get("X-Zhixu-User");
    calls.push({ method, path, userId });
    if (userId !== options.userId) {
      return jsonResponse({ error: "账户不匹配", code: "account_mismatch" }, 409);
    }
    const match = /^\/api\/library\/books\/([^/]+)(?:\/(meta|original))?$/.exec(path);
    if (!match) return jsonResponse({ error: "不支持的书籍路径" }, 404);
    const id = decodeURIComponent(match[1]);
    const suffix = match[2];
    const key = bookUploadKey(options.userId, id);
    if (method === "PUT" && suffix === "meta") {
      await options.onMeta?.();
      pending.add(key);
      return jsonResponse({ ok: true });
    }
    if (method === "PUT" && suffix === "original") {
      if (!pending.has(key)) {
        return jsonResponse({ error: "缺少元数据", code: "meta_required" }, 400);
      }
      await options.onOriginal?.();
      pending.delete(key);
      ready.add(key);
      readyEver.add(key);
      return jsonResponse({ ok: true, sha256: SHA256, byteLength: BYTES.byteLength });
    }
    if (method === "DELETE" && suffix === undefined) {
      pending.delete(key);
      ready.delete(key);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "不支持的请求" }, 405);
  };
  return { fetcher, calls, ready, readyEver, pending };
}

/* ── 删除标记生命周期 ─────────────────────────────────────────── */

test("删除标记按账户隔离，重新导入或清空账户时移除", () => {
  const user = "marker-user-a";
  const other = "marker-user-b";
  const at = 1_700_000_000_000;
  clearBookDeletionMarkers(user);
  clearBookDeletionMarkers(other);

  markBookDeleted(user, BOOK_ID, at);
  assert.equal(isBookDeleted(user, BOOK_ID, at + 1), true);
  assert.equal(isBookDeleted(other, BOOK_ID, at + 1), false);
  assert.equal(isBookDeleted(user, BOOK_ID, at + BOOK_DELETION_MARKER_TTL_MS), false);
  assert.notEqual(bookDeletionKey(user), bookDeletionKey(other));

  unmarkBookDeleted(user, BOOK_ID);
  assert.equal(isBookDeleted(user, BOOK_ID, at + 1), false);

  markBookDeleted(user, "book-other", at);
  clearBookDeletionMarkers(user);
  assert.equal(isBookDeleted(user, "book-other", at + 1), false);
});

test("删除标记解析只接受版本 1 的有效对象，损坏数据视为空", () => {
  assert.deepEqual(
    parseBookDeletionMarkers(JSON.stringify({
      version: 1,
      books: [
        { id: "book-a", at: 5 },
        { id: "book-a", at: 9 },
        { id: "", at: 1 },
        { id: "book-b", at: -1 },
        { id: 7, at: 1 },
      ],
    })),
    [{ id: "book-a", at: 9 }],
  );
  assert.deepEqual(parseBookDeletionMarkers(null), []);
  assert.deepEqual(parseBookDeletionMarkers("{broken"), []);
  assert.deepEqual(parseBookDeletionMarkers(JSON.stringify({ version: 2, books: [] })), []);
  assert.deepEqual(parseBookDeletionMarkers(JSON.stringify({ version: 1, books: "not-an-array" })), []);
});

test("删除标记持久化到账户键，撤销时删除且不保存书籍内容", () => {
  const user = "storage-user";
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true });
  try {
    markBookDeleted(user, BOOK_ID, 1_700_000_000_000);
    const raw = store.get(bookDeletionKey(user));
    assert.ok(raw);
    assert.equal(raw.includes("title"), false);
    assert.equal(raw.includes("text"), false);
    assert.equal(raw.includes("original"), false);
    assert.equal(isBookDeleted(user, BOOK_ID, 1_700_000_000_001), true);

    unmarkBookDeleted(user, BOOK_ID);
    assert.equal(store.has(bookDeletionKey(user)), false);
    assert.equal(isBookDeleted(user, BOOK_ID, 1_700_000_000_001), false);
  } finally {
    clearBookDeletionMarkers(user);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("云端书目过滤删除窗口内的书，其它账户不受影响", () => {
  const user = "filter-user-a";
  const other = "filter-user-b";
  const at = 1_700_000_000_000;
  clearBookDeletionMarkers(user);
  markBookDeleted(user, "book-hidden", at);
  const cloud = [summaryFixture("book-hidden"), summaryFixture("book-visible")];
  assert.deepEqual(
    withoutDeletedBooks(cloud, user, at + 1).map(book => book.id),
    ["book-visible"],
  );
  assert.deepEqual(
    withoutDeletedBooks(cloud, other, at + 1).map(book => book.id),
    ["book-hidden", "book-visible"],
  );
  assert.deepEqual(
    withoutDeletedBooks(cloud, user, at + BOOK_DELETION_MARKER_TTL_MS).map(book => book.id),
    ["book-hidden", "book-visible"],
  );
  clearBookDeletionMarkers(user);
});

test("服务端墓碑清理本机缓存与待传，旧缓存不再显示；显式重新导入保留", async () => {
  const user = "tombstone-purge-user";
  const at = 1_700_000_000_000;
  clearBookDeletionMarkers(user);
  // 本机还留着删除标记和旧书目缓存：服务端墓碑确认后两者都必须失效。
  markBookDeleted(user, BOOK_ID, at);
  const removed: string[] = [];
  const purged = await purgeTombstonedBooks(user, [BOOK_ID, BOOK_ID], {
    reimportingIds: [],
    removeLocal: async id => {
      removed.push(id);
    },
  });
  assert.deepEqual(purged, { removed: [BOOK_ID], reimporting: [] });
  assert.deepEqual(removed, [BOOK_ID], "重复墓碑只清理一次");
  assert.equal(isBookDeleted(user, BOOK_ID, at + 1), false);

  // 即使旧快照仍含本机缓存，合并阶段也必须隐藏已墓碑 id。
  const stale = summaryFixture(BOOK_ID);
  assert.deepEqual(mergeBookSummaries([stale], [], [BOOK_ID]), []);
  assert.deepEqual(
    mergeBookSummaries([stale], [summaryFixture("book-visible")], [BOOK_ID]).map(book => book.id),
    ["book-visible"],
  );

  // 用户已显式重新导入（pending.reimport）时必须保留本机书，等上传清除墓碑。
  const kept: string[] = [];
  const reimporting = await purgeTombstonedBooks(user, [BOOK_ID], {
    reimportingIds: [BOOK_ID],
    removeLocal: async id => {
      kept.push(id);
    },
  });
  assert.deepEqual(reimporting, { removed: [], reimporting: [BOOK_ID] });
  assert.deepEqual(kept, []);
  clearBookDeletionMarkers(user);
});

test("墓碑清理期间切换账户后立即停止，不删除新账户的本机书", async () => {
  const user = "tombstone-race-user-a";
  const other = "tombstone-race-user-b";
  clearBookDeletionMarkers(user);
  setBookOwner(user);
  try {
    const removed: string[] = [];
    const purged = await purgeTombstonedBooks(
      user,
      ["book-race-1", "book-race-2", "book-race-3"],
      {
        reimportingIds: [],
        removeLocal: async id => {
          removed.push(id);
          if (id === "book-race-1") setBookOwner(other);
        },
      },
    );
    assert.deepEqual(removed, ["book-race-1"], "owner 切换后不得再调用 removeLocal");
    assert.deepEqual(purged, { removed: ["book-race-1"], reimporting: [] });
  } finally {
    setBookOwner(null);
    clearBookDeletionMarkers(user);
  }
});

test("导入保存前 owner 已切换时拒绝写入新账户", async () => {
  const user = "import-race-user-a";
  const other = "import-race-user-b";
  setBookOwner(user);
  const epoch = getBookOwnerEpoch();
  try {
    setBookOwner(other);
    await assert.rejects(
      saveBook(bookFixture(), { expectedOwnerEpoch: epoch }),
      /账号已切换，本次导入未保存/,
    );
  } finally {
    setBookOwner(null);
  }
});

/* ── 队列取消 ─────────────────────────────────────────────────── */

test("上传队列按书籍 key 去重，删除只取消本账户的待上传任务", async () => {
  const queue = new BookUploadQueue();
  const gate = Promise.withResolvers<void>();
  const ran: string[] = [];
  const keyA = bookUploadKey("queue-user-a", BOOK_ID);
  const keyB = bookUploadKey("queue-user-b", BOOK_ID);

  queue.enqueue(null, "queue-user-a", async () => {
    ran.push("blocker");
    await gate.promise;
  });
  assert.equal(queue.enqueue(keyA, "queue-user-a", async () => { ran.push("a"); }), true);
  assert.equal(queue.enqueue(keyA, "queue-user-a", async () => { ran.push("a-duplicate"); }), false);
  assert.equal(queue.enqueue(keyB, "queue-user-b", async () => { ran.push("b"); }), true);
  assert.equal(queue.cancel(keyA), true);
  assert.equal(queue.cancel(keyA), false);
  gate.resolve();
  await queue.whenIdle();
  assert.deepEqual(ran, ["blocker", "b"]);

  // 取消后 key 被释放，重新导入同一本书可以再次入队。
  assert.equal(queue.enqueue(keyA, "queue-user-a", async () => { ran.push("a-again"); }), true);
  await queue.whenIdle();
  assert.deepEqual(ran, ["blocker", "b", "a-again"]);
});

test("删除取消尚未开始的排队上传，不会发出任何上传请求", async () => {
  const user = "queued-delete-user";
  clearBookDeletionMarkers(user);
  const queue = new BookUploadQueue();
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  let outcome: BookUploadOutcome | undefined;
  const key = bookUploadKey(user, BOOK_ID);

  queue.enqueue(null, user, async () => { await gate.promise; });
  queue.enqueue(key, user, async () => {
    outcome = await runGuardedBookUpload({
      fetcher: async path => {
        calls.push(path);
        return jsonResponse({ ok: true });
      },
      userId: user,
      book: bookFixture(),
      shouldContinue: async () => !isBookDeleted(user, BOOK_ID),
      onCancelledAfterRequest: () => { calls.push("compensate"); },
    });
  });

  markBookDeleted(user, BOOK_ID);
  assert.equal(queue.cancel(key), true);
  gate.resolve();
  await queue.whenIdle();

  assert.equal(outcome, undefined);
  assert.deepEqual(calls, []);
  clearBookDeletionMarkers(user);
});

/* ── 上传中删除 ───────────────────────────────────────────────── */

test("删除后启动的上传任务不会发出任何请求", async () => {
  const user = "no-request-user";
  clearBookDeletionMarkers(user);
  markBookDeleted(user, BOOK_ID);
  let calls = 0;
  let compensated = 0;
  const outcome = await runGuardedBookUpload({
    fetcher: async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    },
    userId: user,
    book: bookFixture(),
    shouldContinue: async () => !isBookDeleted(user, BOOK_ID),
    onCancelledAfterRequest: () => { compensated += 1; },
  });
  assert.equal(outcome, "cancelled");
  assert.equal(calls, 0);
  assert.equal(compensated, 0);
  clearBookDeletionMarkers(user);
});

test("上传 meta 期间删除：不再发 original，补偿删除后云端无书", async () => {
  const user = "meta-race-user";
  clearBookDeletionMarkers(user);
  const metaStarted = Promise.withResolvers<void>();
  const releaseMeta = Promise.withResolvers<void>();
  const cloud = cloudHarness({
    userId: user,
    onMeta: async () => {
      metaStarted.resolve();
      await releaseMeta.promise;
    },
  });
  let localExists = true;
  let uploadedCalls = 0;
  let outcome: BookUploadOutcome | undefined;
  const queue = new BookUploadQueue();
  const key = bookUploadKey(user, BOOK_ID);

  queue.enqueue(key, user, async () => {
    outcome = await runGuardedBookUpload({
      fetcher: cloud.fetcher,
      userId: user,
      book: bookFixture(),
      shouldContinue: async () => localExists && !isBookDeleted(user, BOOK_ID),
      onUploaded: () => { uploadedCalls += 1; },
      onCancelledAfterRequest: async () => {
        if (isBookDeleted(user, BOOK_ID)) {
          await deleteCloudBook(cloud.fetcher, BOOK_ID, { expectedUserId: user });
        }
      },
    });
  });

  await metaStarted.promise;
  // 模拟 deleteBook：先标记并取消队列，再发云端 DELETE，此时 meta 还停在网络上。
  localExists = false;
  markBookDeleted(user, BOOK_ID);
  queue.cancel(key);
  await deleteCloudBook(cloud.fetcher, BOOK_ID, { expectedUserId: user });
  releaseMeta.resolve();
  await queue.whenIdle();

  assert.equal(outcome, "cancelled");
  assert.equal(uploadedCalls, 0);
  assert.equal(cloud.calls.some(call => call.path.endsWith("/original")), false);
  assert.equal(cloud.readyEver.size, 0);
  assert.equal(cloud.ready.size, 0);
  assert.equal(cloud.pending.size, 0);
  clearBookDeletionMarkers(user);
});

test("original 已发出后才删除：补偿 DELETE 清掉 ready，最终云端无书", async () => {
  const user = "original-race-user";
  clearBookDeletionMarkers(user);
  const originalStarted = Promise.withResolvers<void>();
  const releaseOriginal = Promise.withResolvers<void>();
  const cloud = cloudHarness({
    userId: user,
    onOriginal: async () => {
      originalStarted.resolve();
      await releaseOriginal.promise;
    },
  });
  let deleted = false;
  let cleared = 0;
  let outcome: BookUploadOutcome | undefined;
  const queue = new BookUploadQueue();

  queue.enqueue(bookUploadKey(user, BOOK_ID), user, async () => {
    outcome = await runGuardedBookUpload({
      fetcher: cloud.fetcher,
      userId: user,
      book: bookFixture(),
      shouldContinue: async () => !deleted && !isBookDeleted(user, BOOK_ID),
      onUploaded: () => { cleared += 1; },
      onCancelledAfterRequest: async () => {
        if (isBookDeleted(user, BOOK_ID)) {
          await deleteCloudBook(cloud.fetcher, BOOK_ID, { expectedUserId: user });
        }
      },
    });
  });

  await originalStarted.promise;
  deleted = true;
  markBookDeleted(user, BOOK_ID);
  releaseOriginal.resolve();
  await queue.whenIdle();

  assert.equal(outcome, "cancelled");
  assert.equal(cleared, 0);
  assert.equal(cloud.readyEver.has(bookUploadKey(user, BOOK_ID)), true);
  assert.equal(cloud.ready.size, 0);
  assert.equal(cloud.pending.size, 0);
  clearBookDeletionMarkers(user);
});

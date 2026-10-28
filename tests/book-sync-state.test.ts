import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import type { BookDocument } from "../src/bookTypes";
import {
  listBookSyncStates,
  onBookSyncChange,
  retryBookSync,
  saveBook,
  setBookOwner,
  type BookSyncState,
} from "../src/lib/bookStorage";
import { installFakeIndexedDB } from "./helpers/fakeIndexedDB";

const { factory, restore } = installFakeIndexedDB();
const originalFetch = globalThis.fetch;

after(() => {
  restore();
  globalThis.fetch = originalFetch;
});

function bookFixture(id: string): BookDocument {
  const text = `${id} 的正文`;
  const bytes = new TextEncoder().encode(text);
  return {
    id,
    title: "同步状态测试书",
    author: "",
    format: "txt",
    fileName: `${id}.txt`,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    importedAt: 1_700_000_000_000,
    chapters: [{ id: "c1", title: "第一章", blockIds: ["b1"] }],
    blocks: [{ id: "b1", chapterId: "c1", text, locator: "第1段" }],
    warnings: [],
    original: new Blob([bytes]),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("未登录导入的书籍状态为 local，且只读取摘要", async () => {
  setBookOwner(null);
  const book = bookFixture("book-sync-local");
  await saveBook(book);

  factory.log.length = 0;
  const states = { ...(await listBookSyncStates()) };

  assert.equal(states[book.id], "local");
  assert.ok(factory.log.length > 0);
  assert.ok(
    factory.log.every(entry => entry.store === "summaries"),
    `同步状态查询不应读取正文，实际读取：${JSON.stringify(factory.log)}`,
  );
  factory.clearData();
});

test("上传失败后状态为 failed，重试成功后变为 ready", { timeout: 5000 }, async () => {
  const user = "book-sync-user";
  const book = bookFixture("book-sync-upload");
  const events: BookSyncState[] = [];
  let mode: "fail" | "ok" = "fail";
  const failed = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const requests: Array<{ method: string; path: string }> = [];

  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, path });
    if (mode === "fail") throw new TypeError("网络连接失败");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Zhixu-User"), user);
    if (path.endsWith("/meta")) return jsonResponse({ ok: true });
    if (path.endsWith("/original")) {
      return jsonResponse({ ok: true, sha256: book.sha256, byteLength: book.byteLength });
    }
    return jsonResponse({ error: "不支持的请求" }, 405);
  };

  const unsubscribe = onBookSyncChange((event) => {
    if (event.bookId !== book.id) return;
    events.push(event.state);
    if (event.state === "failed") failed.resolve();
    if (event.state === "ready") ready.resolve();
  });

  setBookOwner(user);
  try {
    await saveBook(book);
    await failed.promise;
    assert.equal(({ ...(await listBookSyncStates()) })[book.id], "failed");
    assert.deepEqual(events.slice(0, 3), ["pending", "uploading", "failed"]);

    mode = "ok";
    await retryBookSync(book.id);
    await ready.promise;

    assert.equal(({ ...(await listBookSyncStates()) })[book.id], "ready");
    assert.equal(events.includes("pending"), true);
    assert.equal(events.at(-1), "ready");
    assert.equal(
      requests.some(request => request.method === "PUT" && request.path.endsWith("/meta")),
      true,
    );
  } finally {
    unsubscribe();
    setBookOwner(null);
    globalThis.fetch = originalFetch;
    factory.clearData();
  }
});

test("未登录或登录失效时重试同步会明确失败", async () => {
  setBookOwner(null);
  await assert.rejects(() => retryBookSync("book-sync-missing"), /无法同步到云端书架/);
});

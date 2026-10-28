import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { BookMetadata } from "../src/bookTypes";
import { createApp, runOperationalCleanup } from "../server/index";
import type { AppConfig } from "../server/config";
import {
  LATEST_SCHEMA_VERSION,
  MAX_LIBRARY_TOMBSTONES_PER_USER,
  SESSION_COOKIE_NAME,
  ZhixuDatabase,
} from "../server/db";
import {
  LIBRARY_DOWNLOAD_CHUNK_BYTES,
  MAX_BOOK_META_BYTES,
  MAX_BOOK_ORIGINAL_BYTES,
  MAX_LIBRARY_BOOKS,
  MAX_LIBRARY_ORIGINAL_BYTES_PER_USER,
  streamOriginalChunks,
  type OriginalChunkSink,
  type OriginalChunkSource,
} from "../server/library";

/* ── 夹具：临时 SQLite + 真实 Express 实例（不监听外网） ──────────────── */

const PASSWORD = "correct horse battery";

const BASE_CONFIG: Omit<AppConfig, "dataDir"> = {
  production: false,
  port: 3001,
  host: "127.0.0.1",
  authRequired: true,
  allowByok: false,
  cookieSecure: false,
  publicOrigin: null,
  trustProxy: false,
  quotas: { chatPerDay: 40, diagnosticPerDay: 10, reviewPerDay: 30 },
  maxConcurrentAi: 2,
  auditRetentionDays: 90,
  usageRetentionDays: 90,
  byokAllowedOrigins: [],
  allowInsecureLocal: false,
};

interface Harness {
  readonly db: ZhixuDatabase;
  client(): Client;
  close(): Promise<void>;
}

interface RequestInitLike {
  method?: string;
  body?: unknown;
  rawBody?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  /** 模拟真实客户端：DELETE 不带请求体，也不设置 Content-Type。 */
  bare?: boolean;
  /** 用于模拟下载中途取消（关闭标签页/断网）。 */
  signal?: AbortSignal;
}

class Client {
  private cookie?: string;
  constructor(private readonly base: string) {}

  async request(pathname: string, init: RequestInitLike = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (unsafe) {
      headers["X-Zhixu-Request"] = "1";
      if (!init.bare) headers["Content-Type"] = init.contentType ?? "application/json";
    } else if (init.contentType) {
      headers["Content-Type"] = init.contentType;
    }
    if (this.cookie) headers.Cookie = this.cookie;

    const body: BodyInit | undefined =
      init.rawBody !== undefined
        ? (init.rawBody as BodyInit)
        : init.body !== undefined
          ? JSON.stringify(init.body)
          : unsafe && !init.bare
            ? "{}"
            : undefined;

    const response = await fetch(this.base + pathname, {
      method,
      headers,
      body,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      for (const part of setCookie.split(/,(?=[^;]+?=)/)) {
        const pair = part.split(";")[0].trim();
        if (!pair.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
        const value = pair.slice(SESSION_COOKIE_NAME.length + 1);
        this.cookie = value ? `${SESSION_COOKIE_NAME}=${value}` : undefined;
      }
    }
    return response;
  }
}

async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-library-"));
  const config: AppConfig = { ...BASE_CONFIG, dataDir: dir };
  const db = new ZhixuDatabase(path.join(dir, "zhixu.db"));
  const app = createApp({ config, db, serveStatic: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  return {
    db,
    client: () => new Client(base),
    close: async () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
      await promise;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

/* ── 响应读取：先确认 JSON 对象，再按接口契约取字段 ──────────────────── */

interface CloudBookSummaryResponse {
  id: string;
  title: string;
  author: string;
  format: string;
  fileName: string;
  byteLength: number;
  importedAt: number;
  chapterCount: number;
  blockCount: number;
  characters: number;
  warnings: string[];
  pageCount?: number;
  updatedAt: number;
}

interface OriginalUploadResponse {
  ok: boolean;
  sha256: string;
  byteLength: number;
}

async function jsonObject<T extends object>(response: Response, label: string): Promise<T> {
  const value: unknown = await response.json();
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label}必须是 JSON 对象`,
  );
  // 边界断言：服务端响应已确认是 JSON 对象，调用方按接口契约收窄字段。
  return value as T;
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await jsonObject<{ code?: unknown }>(response, "错误响应");
  return typeof body.code === "string" ? body.code : undefined;
}

async function booksOf(response: Response): Promise<CloudBookSummaryResponse[]> {
  const body = await jsonObject<{ books?: unknown }>(response, "书架响应");
  const books = body.books;
  assert.ok(Array.isArray(books), "books 必须是数组");
  return books as CloudBookSummaryResponse[];
}

interface ShelfResponse {
  books: CloudBookSummaryResponse[];
  deleted: string[];
}

async function shelfOf(response: Response): Promise<ShelfResponse> {
  const body = await jsonObject<{ books?: unknown; deleted?: unknown }>(response, "书架响应");
  const books = body.books;
  const deleted = body.deleted;
  assert.ok(Array.isArray(books), "books 必须是数组");
  assert.ok(Array.isArray(deleted), "deleted 必须是数组");
  for (const id of deleted) assert.equal(typeof id, "string", "deleted 只包含书籍 id");
  return {
    books: books as CloudBookSummaryResponse[],
    deleted: deleted as string[],
  };
}

async function metaOf(response: Response): Promise<BookMetadata> {
  const body = await jsonObject<{ meta?: unknown }>(response, "meta 响应");
  const meta = body.meta;
  assert.ok(meta !== null && typeof meta === "object" && !Array.isArray(meta), "meta 必须是对象");
  return meta as BookMetadata;
}

async function register(client: Client, email: string, name = "Tester"): Promise<string> {
  const response = await client.request("/api/auth/register", {
    method: "POST",
    body: { email, name, password: PASSWORD },
  });
  const body = await jsonObject<{ user?: { id?: unknown }; error?: unknown }>(
    response,
    "注册响应",
  );
  assert.equal(response.status, 200, typeof body.error === "string" ? body.error : undefined);
  const id = body.user?.id;
  assert.ok(typeof id === "string", "注册应返回用户 id");
  return id;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const DEFAULT_BYTES = Buffer.from("第一段\n\n第二段\n", "utf8");

function metadataFor(
  id: string,
  bytes: Uint8Array = DEFAULT_BYTES,
  overrides: Partial<BookMetadata> = {},
): BookMetadata {
  return {
    id,
    title: "测试书",
    author: "测试作者",
    format: "txt",
    fileName: "测试书.txt",
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    importedAt: 1_700_000_000_000,
    chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1", "c1-b2"] }],
    blocks: [
      { id: "c1-b1", chapterId: "c1", text: "第一段", locator: "第一章 · 第1段" },
      { id: "c1-b2", chapterId: "c1", text: "第二段", locator: "第一章 · 第2段" },
    ],
    warnings: [],
    ...overrides,
  };
}

function putMeta(client: Client, meta: BookMetadata): Promise<Response> {
  return client.request(`/api/library/books/${meta.id}/meta`, {
    method: "PUT",
    body: meta,
  });
}

/** 直接调用 db.upsertLibraryMeta 时使用的派生摘要，字段与路由解析结果一致。 */
function metaInputFor(meta: BookMetadata) {
  return {
    id: meta.id,
    sha256: meta.sha256,
    meta: JSON.stringify(meta),
    title: meta.title,
    author: meta.author,
    format: meta.format,
    fileName: meta.fileName,
    byteLength: meta.byteLength,
    importedAt: meta.importedAt,
    chapterCount: meta.chapters.length,
    blockCount: meta.blocks.length,
    characters: meta.blocks.reduce((sum, block) => sum + block.text.length, 0),
    warnings: JSON.stringify(meta.warnings),
    pageCount: meta.pageCount ?? null,
  };
}

function putOriginal(client: Client, id: string, bytes: Uint8Array): Promise<Response> {
  return client.request(`/api/library/books/${id}/original`, {
    method: "PUT",
    rawBody: bytes,
    contentType: "application/octet-stream",
  });
}

async function publish(client: Client, meta: BookMetadata, bytes: Uint8Array): Promise<void> {
  const metaResponse = await putMeta(client, meta);
  assert.equal(metaResponse.status, 200, await metaResponse.clone().text());
  const originalResponse = await putOriginal(client, meta.id, bytes);
  assert.equal(originalResponse.status, 200, await originalResponse.clone().text());
}

function countRows(
  db: ZhixuDatabase,
  table: "library_books" | "library_originals" | "library_deletions",
  userId: string,
): number {
  const row = db.db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
    .get(userId) as { count: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

/* ── 分块下载夹具 ─────────────────────────────────────────────────────── */

interface ChunkRead {
  offset: number;
  length: number;
}

/** 可预测的二进制内容：避免全零数据掩盖偏移/拼接错误。 */
function patternBytes(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 251;
  }
  return bytes;
}

/** 记录路由实际向 SQLite 请求的分片，用于证明没有整文件读取。 */
function trackOriginalChunks(db: ZhixuDatabase): ChunkRead[] {
  const reads: ChunkRead[] = [];
  const read = db.readReadyLibraryOriginalChunk.bind(db);
  db.readReadyLibraryOriginalChunk = (userId, bookId, offset, length) => {
    reads.push({ offset, length });
    return read(userId, bookId, offset, length);
  };
  return reads;
}

/** 受控 writable：可让第 N 次写入返回 false（背压），也可手动触发 close。 */
class ControlledSink implements OriginalChunkSink {
  readonly writes: Uint8Array[] = [];
  ended = false;
  destroyed = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(private readonly writesBeforeBackpressure = Number.POSITIVE_INFINITY) {}

  write(chunk: Uint8Array): boolean {
    this.writes.push(chunk);
    return this.writes.length < this.writesBeforeBackpressure;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  once(event: string, listener: () => void): unknown {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  /** 模拟 drain/close/error；与 EventEmitter.once 一致，触发后移除。 */
  emit(event: string): void {
    const pending = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const listener of pending) listener();
  }
}

function chunkedSource(bytes: Uint8Array): {
  source: OriginalChunkSource;
  reads: ChunkRead[];
} {
  const reads: ChunkRead[] = [];
  return {
    reads,
    source: {
      read(offset, length) {
        reads.push({ offset, length });
        return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
      },
    },
  };
}

/* ── 认证与账户绑定 ───────────────────────────────────────────────────── */

test("书架接口要求登录，并拒绝与当前会话不一致的账户绑定头", async () => {
  await withHarness(async (harness) => {
    const unauthorized = await harness.client().request("/api/library/books");
    assert.equal(unauthorized.status, 401);
    assert.equal(await errorCode(unauthorized), "auth_required");

    const client = harness.client();
    const userId = await register(client, "library-auth@example.com");

    const mismatch = await client.request("/api/library/books", {
      headers: { "X-Zhixu-User": "not-the-session-user" },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(await errorCode(mismatch), "account_mismatch");

    const matched = await client.request("/api/library/books", {
      headers: { "X-Zhixu-User": userId },
    });
    assert.equal(matched.status, 200);
    assert.deepEqual(await booksOf(matched), []);
  });
});

/* ── 两阶段上传、摘要派生、下载与隔离 ─────────────────────────────────── */

test("两阶段上传后 ready 列表、meta 与原始字节一致，且账户之间互相隔离", async () => {
  await withHarness(async (harness) => {
    const alice = harness.client();
    const bob = harness.client();
    await register(alice, "library-alice@example.com", "Alice");
    await register(bob, "library-bob@example.com", "Bob");

    const meta = metadataFor("book-abc123", DEFAULT_BYTES, {
      warnings: ["仅提取了文本层"],
    });

    // 附带伪造的 summary 字段：服务端必须忽略它们并从 meta 重新派生。
    const metaResponse = await alice.request(`/api/library/books/${meta.id}/meta`, {
      method: "PUT",
      body: { ...meta, chapterCount: 999, blockCount: 999, characters: 999, updatedAt: 1 },
    });
    assert.equal(metaResponse.status, 200);
    assert.deepEqual(await metaResponse.json(), { ok: true });

    // pending 阶段：既不在列表里，也不能读取 meta/原文件。
    assert.deepEqual(await booksOf(await alice.request("/api/library/books")), []);
    assert.equal((await alice.request(`/api/library/books/${meta.id}/meta`)).status, 404);
    assert.equal((await alice.request(`/api/library/books/${meta.id}/original`)).status, 404);

    const originalResponse = await putOriginal(alice, meta.id, DEFAULT_BYTES);
    assert.equal(originalResponse.status, 200);
    const originalBody = await jsonObject<OriginalUploadResponse>(
      originalResponse,
      "原文件上传响应",
    );
    assert.deepEqual(originalBody, {
      ok: true,
      sha256: sha256(DEFAULT_BYTES),
      byteLength: DEFAULT_BYTES.byteLength,
    });

    const books = await booksOf(await alice.request("/api/library/books"));
    assert.equal(books.length, 1);
    const summary = books[0];
    assert.equal(summary.id, meta.id);
    assert.equal(summary.title, meta.title);
    assert.equal(summary.author, meta.author);
    assert.equal(summary.format, "txt");
    assert.equal(summary.fileName, meta.fileName);
    assert.equal(summary.byteLength, DEFAULT_BYTES.byteLength);
    assert.equal(summary.chapterCount, 1);
    assert.equal(summary.blockCount, 2);
    assert.equal(summary.characters, "第一段".length + "第二段".length);
    assert.deepEqual(summary.warnings, ["仅提取了文本层"]);
    assert.ok(summary.updatedAt > 0);

    const storedMeta = await alice.request(`/api/library/books/${meta.id}/meta`);
    assert.equal(storedMeta.status, 200);
    assert.deepEqual(await metaOf(storedMeta), meta);

    const download = await alice.request(`/api/library/books/${meta.id}/original`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("x-book-sha256"), sha256(DEFAULT_BYTES));
    assert.match(download.headers.get("cache-control") ?? "", /no-store/);
    const disposition = download.headers.get("content-disposition") ?? "";
    assert.ok(disposition.startsWith("attachment;"), disposition);
    assert.ok(disposition.includes("filename*=UTF-8''"), disposition);
    assert.ok(!disposition.includes("\r") && !disposition.includes("\n"));
    const downloaded = new Uint8Array(await download.arrayBuffer());
    assert.deepEqual(Buffer.from(downloaded), DEFAULT_BYTES);

    // 账户隔离：Bob 既看不到也读不到 Alice 的书。
    assert.deepEqual(await booksOf(await bob.request("/api/library/books")), []);
    assert.equal((await bob.request(`/api/library/books/${meta.id}/meta`)).status, 404);
    assert.equal((await bob.request(`/api/library/books/${meta.id}/original`)).status, 404);

    // 跨账户 DELETE 幂等成功，但不会影响 Alice。
    const bobDelete = await bob.request(`/api/library/books/${meta.id}`, { method: "DELETE" });
    assert.equal(bobDelete.status, 200);
    assert.equal((await booksOf(await alice.request("/api/library/books"))).length, 1);
    assert.equal((await alice.request(`/api/library/books/${meta.id}/original`)).status, 200);
  });
});

/* ── sha 不匹配与同 id 重新上传 ───────────────────────────────────────── */

test("原文件 sha 不匹配返回 409 且保持 pending，重新上传 meta+original 可恢复 ready", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-sha@example.com");

    const wrongBytes = Buffer.from("这不是元数据里的文件。", "utf8");
    const meta = metadataFor("book-sha001", DEFAULT_BYTES);
    assert.equal((await putMeta(client, meta)).status, 200);

    const mismatch = await putOriginal(client, meta.id, wrongBytes);
    assert.equal(mismatch.status, 409);
    assert.equal(await errorCode(mismatch), "sha_mismatch");
    assert.deepEqual(await booksOf(await client.request("/api/library/books")), []);
    assert.equal((await client.request(`/api/library/books/${meta.id}/original`)).status, 404);

    assert.equal((await putOriginal(client, meta.id, DEFAULT_BYTES)).status, 200);

    // 同 id 重新导入：meta 回到 pending，旧的 ready 原文件暂时不可见。
    const nextBytes = Buffer.from("重新导入后的原文件内容。", "utf8");
    const nextMeta = metadataFor(meta.id, nextBytes, { title: "测试书 v2" });
    assert.equal((await putMeta(client, nextMeta)).status, 200);
    assert.deepEqual(await booksOf(await client.request("/api/library/books")), []);
    assert.equal((await client.request(`/api/library/books/${meta.id}/meta`)).status, 404);
    assert.equal((await client.request(`/api/library/books/${meta.id}/original`)).status, 404);

    assert.equal((await putOriginal(client, meta.id, nextBytes)).status, 200);
    const list = await booksOf(await client.request("/api/library/books"));
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "测试书 v2");
    assert.equal(list[0].byteLength, nextBytes.byteLength);
    const download = await client.request(`/api/library/books/${meta.id}/original`);
    assert.deepEqual(Buffer.from(new Uint8Array(await download.arrayBuffer())), nextBytes);
  });
});

/* ── 严格校验：id 大小写/路径注入与坏 metadata ────────────────────────── */

test("拒绝大小写/路径注入 id 与结构不一致的 metadata", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    const userId = await register(client, "library-invalid@example.com");

    const expectBadRequest = async (
      response: Response,
      expectedCode = "invalid_metadata",
    ): Promise<void> => {
      assert.equal(response.status, 400, await response.clone().text());
      assert.equal(await errorCode(response), expectedCode);
    };

    const uppercaseId = metadataFor("BOOK-1");
    await expectBadRequest(
      await client.request("/api/library/books/BOOK-1/meta", {
        method: "PUT",
        body: uppercaseId,
      }),
      "invalid_book_id",
    );

    const traversal = metadataFor("../evil", DEFAULT_BYTES, { id: "../evil" });
    await expectBadRequest(
      await client.request("/api/library/books/..%2Fevil/meta", {
        method: "PUT",
        body: traversal,
      }),
      "invalid_book_id",
    );

    // body.id 与路径不一致
    const mismatch = metadataFor("book-target", DEFAULT_BYTES, { id: "book-other" });
    await expectBadRequest(
      await client.request("/api/library/books/book-target/meta", {
        method: "PUT",
        body: mismatch,
      }),
    );

    const badSha = metadataFor("book-badsha", DEFAULT_BYTES, { sha256: "A".repeat(64) });
    await expectBadRequest(await putMeta(client, badSha));

    const badFormat = metadataFor("book-badformat", DEFAULT_BYTES, {
      format: "docx" as unknown as BookMetadata["format"],
    });
    await expectBadRequest(await putMeta(client, badFormat));

    const duplicateBlock = metadataFor("book-dupblock", DEFAULT_BYTES, {
      blocks: [
        { id: "c1-b1", chapterId: "c1", text: "第一段", locator: "1" },
        { id: "c1-b1", chapterId: "c1", text: "第二段", locator: "2" },
      ],
      chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1"] }],
    });
    await expectBadRequest(await putMeta(client, duplicateBlock));

    const dangling = metadataFor("book-dangling", DEFAULT_BYTES, {
      chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1", "missing"] }],
    });
    await expectBadRequest(await putMeta(client, dangling));

    const wrongChapter = metadataFor("book-wrong-chapter", DEFAULT_BYTES, {
      chapters: [
        { id: "c1", title: "第一章", blockIds: ["c1-b1"] },
        { id: "c2", title: "第二章", blockIds: [] },
      ],
      blocks: [{ id: "c1-b1", chapterId: "c2", text: "第一段", locator: "1" }],
    });
    await expectBadRequest(await putMeta(client, wrongChapter));

    const unreferenced = metadataFor("book-unreferenced", DEFAULT_BYTES, {
      chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1"] }],
      blocks: [
        { id: "c1-b1", chapterId: "c1", text: "第一段", locator: "1" },
        { id: "c1-b2", chapterId: "c1", text: "第二段", locator: "2" },
      ],
    });
    await expectBadRequest(await putMeta(client, unreferenced));

    const longBlocks = Array.from({ length: 21 }, (_, index) => ({
      id: `c1-b${index + 1}`,
      chapterId: "c1",
      text: "x".repeat(100_000),
      locator: `第${index + 1}段`,
    }));
    const tooMuchText = metadataFor("book-toolong", DEFAULT_BYTES, {
      chapters: [
        { id: "c1", title: "第一章", blockIds: longBlocks.map((block) => block.id) },
      ],
      blocks: longBlocks,
    });
    await expectBadRequest(await putMeta(client, tooMuchText));

    const tooManyChapters = metadataFor("book-many-chapters", DEFAULT_BYTES, {
      chapters: Array.from({ length: 1001 }, (_, index) => ({
        id: `c${index + 1}`,
        title: "",
        blockIds: [],
      })),
      blocks: [],
    });
    await expectBadRequest(await putMeta(client, tooManyChapters));

    const unknownField = { ...metadataFor("book-extra"), original: new Blob(["x"]) };
    await expectBadRequest(
      await client.request("/api/library/books/book-extra/meta", {
        method: "PUT",
        body: unknownField,
      }),
    );

    const headerInjection = metadataFor("book-filename", DEFAULT_BYTES, {
      fileName: "bad\r\nInjected: value.txt",
    });
    await expectBadRequest(await putMeta(client, headerInjection));

    // 所有被拒绝的请求都不得留下书或原文件。
    assert.deepEqual(await booksOf(await client.request("/api/library/books")), []);
    assert.equal(countRows(harness.db, "library_books", userId), 0);
    assert.equal(countRows(harness.db, "library_originals", userId), 0);
  });
});

/* ── 显示字段控制字符契约 ──────────────────────────────────────────────── */

test("服务端显示字段拒绝 tab/LF/CR 等控制字符，正文换行可正常保存", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-controls@example.com");

    const rejected = [
      metadataFor("book-control-title", DEFAULT_BYTES, { title: "书\t名" }),
      metadataFor("book-control-author", DEFAULT_BYTES, { author: "作者\n名" }),
      metadataFor("book-control-file", DEFAULT_BYTES, { fileName: "书\r.txt" }),
      metadataFor("book-control-chapter", DEFAULT_BYTES, {
        chapters: [{ id: "c1", title: "第一\u007f章", blockIds: ["c1-b1", "c1-b2"] }],
      }),
      metadataFor("book-control-locator", DEFAULT_BYTES, {
        blocks: [
          { id: "c1-b1", chapterId: "c1", text: "第一段", locator: "第1段\u0001" },
          { id: "c1-b2", chapterId: "c1", text: "第二段", locator: "第2段" },
        ],
      }),
    ];
    for (const meta of rejected) {
      const response = await putMeta(client, meta);
      assert.equal(response.status, 400, `${meta.id} 应拒绝控制字符`);
      assert.equal(await errorCode(response), "invalid_metadata");
    }

    // 正文不是显示字段：服务端 bodyText 允许 tab/LF，客户端必须与之一致。
    const meta = metadataFor("book-control-body", DEFAULT_BYTES, {
      blocks: [
        { id: "c1-b1", chapterId: "c1", text: "第一行\n第二行\t缩进", locator: "第一章 · 第1段" },
        { id: "c1-b2", chapterId: "c1", text: "尾段", locator: "第一章 · 第2段" },
      ],
    });
    await publish(client, meta, DEFAULT_BYTES);
    const stored = await metaOf(await client.request(`/api/library/books/${meta.id}/meta`));
    assert.equal(stored.blocks[0].text, "第一行\n第二行\t缩进");
  });
});

/* ── 幂等删除与账户删除级联 ───────────────────────────────────────────── */

test("DELETE 幂等，删除账户会级联清理书目与原文件 BLOB", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    const userId = await register(client, "library-delete@example.com");

    const firstBytes = Buffer.from("第一本书的字节。", "utf8");
    const secondBytes = Buffer.from("第二本书的字节。", "utf8");
    await publish(client, metadataFor("book-one", firstBytes), firstBytes);
    await publish(client, metadataFor("book-two", secondBytes), secondBytes);
    assert.equal(countRows(harness.db, "library_books", userId), 2);
    assert.equal(countRows(harness.db, "library_originals", userId), 2);

    const firstDelete = await client.request("/api/library/books/book-one", { method: "DELETE" });
    assert.equal(firstDelete.status, 200);
    assert.deepEqual(await firstDelete.json(), { ok: true });
    const secondDelete = await client.request("/api/library/books/book-one", { method: "DELETE" });
    assert.equal(secondDelete.status, 200);
    assert.deepEqual(await secondDelete.json(), { ok: true });
    // 重复删除幂等：墓碑只保留一条。
    assert.equal(countRows(harness.db, "library_deletions", userId), 1);

    const books = await booksOf(await client.request("/api/library/books"));
    assert.deepEqual(books.map((book) => book.id), ["book-two"]);
    assert.equal(countRows(harness.db, "library_books", userId), 1);
    assert.equal(countRows(harness.db, "library_originals", userId), 1);

    // 真实客户端 DELETE 不带 body/Content-Type，同样必须成功。
    const bareDelete = await client.request("/api/library/books/book-two", {
      method: "DELETE",
      bare: true,
    });
    assert.equal(bareDelete.status, 200);
    assert.deepEqual(await bareDelete.json(), { ok: true });
    assert.deepEqual(await booksOf(await client.request("/api/library/books")), []);
    assert.equal(countRows(harness.db, "library_deletions", userId), 2);

    // 再放一本，保证删除账户时确有书目与原文件可被级联清理。
    const thirdBytes = Buffer.from("第三本书的字节。", "utf8");
    await publish(client, metadataFor("book-three", thirdBytes), thirdBytes);
    assert.equal(countRows(harness.db, "library_books", userId), 1);
    assert.equal(countRows(harness.db, "library_originals", userId), 1);

    const deleted = await client.request("/api/account", {
      method: "DELETE",
      body: { password: PASSWORD },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true });
    assert.equal(countRows(harness.db, "library_books", userId), 0);
    assert.equal(countRows(harness.db, "library_originals", userId), 0);
    assert.equal(countRows(harness.db, "library_deletions", userId), 0);
    assert.equal(harness.db.userById(userId), undefined);
    assert.equal((await client.request("/api/library/books")).status, 401);
  });
});

/* ── 跨设备删除墓碑 ───────────────────────────────────────────────────── */

test("删除墓碑跨设备生效：列表返回删除 id、旧缓存上传被拒、显式重新导入可恢复", async () => {
  await withHarness(async (harness) => {
    const deviceA = harness.client();
    const email = "library-tombstone@example.com";
    const userId = await register(deviceA, email);

    const deviceB = harness.client();
    const login = await deviceB.request("/api/auth/login", {
      method: "POST",
      body: { email, password: PASSWORD },
    });
    assert.equal(login.status, 200, await login.clone().text());
    await login.text();

    const meta = metadataFor("book-tombstone", DEFAULT_BYTES);
    await publish(deviceA, meta, DEFAULT_BYTES);

    // B 先看到这本书，并把书目缓存到本机。
    const before = await shelfOf(await deviceB.request("/api/library/books"));
    assert.deepEqual(before.books.map((book) => book.id), [meta.id]);
    assert.deepEqual(before.deleted, []);

    // A 删除后，B 的列表必须收到墓碑 id，而不是继续显示旧书。
    const deleteResponse = await deviceA.request(`/api/library/books/${meta.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { ok: true });
    assert.equal(countRows(harness.db, "library_deletions", userId), 1);

    const afterDelete = await shelfOf(await deviceB.request("/api/library/books"));
    assert.deepEqual(afterDelete.books, []);
    assert.deepEqual(afterDelete.deleted, [meta.id]);
    assert.equal((await deviceB.request(`/api/library/books/${meta.id}/meta`)).status, 404);
    assert.equal((await deviceB.request(`/api/library/books/${meta.id}/original`)).status, 404);

    // B 的旧缓存若尝试重传，必须被墓碑明确拒绝，而不是重新变成 pending/ready。
    const staleMeta = await putMeta(deviceB, meta);
    assert.equal(staleMeta.status, 409);
    assert.equal(await errorCode(staleMeta), "book_deleted");
    const staleOriginal = await putOriginal(deviceB, meta.id, DEFAULT_BYTES);
    assert.equal(staleOriginal.status, 409);
    assert.equal(await errorCode(staleOriginal), "book_deleted");
    assert.equal(countRows(harness.db, "library_books", userId), 0);
    assert.equal(countRows(harness.db, "library_originals", userId), 0);

    // 另一个账户的同 id 上传不受影响：墓碑按 user_id 隔离。
    const otherClient = harness.client();
    await register(otherClient, "library-tombstone-other@example.com");
    await publish(otherClient, meta, DEFAULT_BYTES);
    assert.deepEqual(
      (await shelfOf(await otherClient.request("/api/library/books"))).deleted,
      [],
    );

    // 用户显式重新导入：meta 带 reimport 头，清除墓碑后可恢复正常上传与列表。
    const reimport = await deviceB.request(`/api/library/books/${meta.id}/meta`, {
      method: "PUT",
      body: meta,
      headers: { "X-Zhixu-Reimport": "1" },
    });
    assert.equal(reimport.status, 200, await reimport.clone().text());
    await reimport.text();
    assert.equal(countRows(harness.db, "library_deletions", userId), 0);
    assert.deepEqual(
      (await shelfOf(await deviceB.request("/api/library/books"))).deleted,
      [],
    );

    const restoredOriginal = await putOriginal(deviceB, meta.id, DEFAULT_BYTES);
    assert.equal(restoredOriginal.status, 200, await restoredOriginal.clone().text());
    await restoredOriginal.text();
    const restored = await shelfOf(await deviceB.request("/api/library/books"));
    assert.deepEqual(restored.books.map((book) => book.id), [meta.id]);
    assert.deepEqual(restored.deleted, []);
    const download = await deviceB.request(`/api/library/books/${meta.id}/original`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(new Uint8Array(await download.arrayBuffer())), DEFAULT_BYTES);

    // 再次删除产生新墓碑；删除账户时墓碑随账户级联清理。
    assert.equal(
      (await deviceA.request(`/api/library/books/${meta.id}`, { method: "DELETE" })).status,
      200,
    );
    assert.equal(countRows(harness.db, "library_deletions", userId), 1);
    const accountDelete = await deviceA.request("/api/account", {
      method: "DELETE",
      body: { password: PASSWORD },
    });
    assert.equal(accountDelete.status, 200, await accountDelete.clone().text());
    await accountDelete.text();
    assert.equal(countRows(harness.db, "library_deletions", userId), 0);
  });
});

/* ── 墓碑上限与定期清理 ───────────────────────────────────────────────── */

test("墓碑：每用户达到上限后拒绝新的随机 id DELETE，幂等删除仍成功", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    const userId = await register(client, "library-tombstone-limit@example.com");
    const insert = harness.db.db.prepare(
      "INSERT INTO library_deletions (user_id, book_id, deleted_at) VALUES (?, ?, ?)",
    );
    const now = Date.now();
    harness.db.transaction(() => {
      for (let index = 0; index < MAX_LIBRARY_TOMBSTONES_PER_USER; index += 1) {
        insert.run(userId, `seed-${index}`, now);
      }
    });
    assert.equal(countRows(harness.db, "library_deletions", userId), MAX_LIBRARY_TOMBSTONES_PER_USER);

    const blocked = await client.request("/api/library/books/brand-new-random-id", {
      method: "DELETE",
    });
    assert.equal(blocked.status, 409);
    assert.equal(await errorCode(blocked), "tombstone_limit");
    assert.equal(
      countRows(harness.db, "library_deletions", userId),
      MAX_LIBRARY_TOMBSTONES_PER_USER,
      "被拒绝的新墓碑不得落库",
    );

    // 已存在的墓碑重复删除是幂等的，不因为满额而报错，也不增加行数。
    const idempotent = await client.request("/api/library/books/seed-0", { method: "DELETE" });
    assert.equal(idempotent.status, 200);
    assert.deepEqual(await idempotent.json(), { ok: true });
    assert.equal(countRows(harness.db, "library_deletions", userId), MAX_LIBRARY_TOMBSTONES_PER_USER);

    // 另一个账户不受影响。
    const otherClient = harness.client();
    await register(otherClient, "library-tombstone-limit-other@example.com");
    assert.equal(
      (await otherClient.request("/api/library/books/brand-new-random-id", { method: "DELETE" })).status,
      200,
    );
  });
});

test("cleanupExpiredData：清理 90 天前墓碑与 24 小时未上传原文件的 pending 书目", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    const userId = await register(client, "library-cleanup@example.com");
    const now = Date.now();
    const oldTombstone = now - 91 * 86_400_000;
    const freshTombstone = now - 89 * 86_400_000;
    const insertTombstone = harness.db.db.prepare(
      "INSERT INTO library_deletions (user_id, book_id, deleted_at) VALUES (?, ?, ?)",
    );
    insertTombstone.run(userId, "tombstone-old", oldTombstone);
    insertTombstone.run(userId, "tombstone-fresh", freshTombstone);

    const oldPending = metadataFor("pending-old");
    const freshPending = metadataFor("pending-fresh");
    const oldReady = metadataFor("ready-old");
    assert.equal(
      harness.db.upsertLibraryMeta(userId, metaInputFor(oldPending), { now: now - 25 * 3_600_000 }).ok,
      true,
    );
    assert.equal(
      harness.db.upsertLibraryMeta(userId, metaInputFor(freshPending), { now: now - 3_600_000 }).ok,
      true,
    );
    assert.equal(harness.db.upsertLibraryMeta(userId, metaInputFor(oldReady), { now: now - 30 * 86_400_000 }).ok, true);
    assert.equal(
      harness.db.attachLibraryOriginal(
        userId,
        oldReady.id,
        oldReady.sha256,
        DEFAULT_BYTES.byteLength,
        DEFAULT_BYTES,
        now - 30 * 86_400_000,
      ).ok,
      true,
    );
    // 模拟“meta 成功但原文件失败”的历史 pending 行，且残留一份旧原文件需级联清理。
    harness.db.db
      .prepare(
        "INSERT INTO library_originals (user_id, book_id, sha256, byte_length, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(userId, oldPending.id, oldPending.sha256, DEFAULT_BYTES.byteLength, DEFAULT_BYTES, oldTombstone);

    const removed = harness.db.cleanupExpiredData({ auditDays: 90, usageDays: 90 }, now);
    assert.equal(removed.tombstones, 1, "只删除超过 90 天的墓碑");
    assert.equal(removed.pendingLibraryBooks, 1, "只删除超过 24 小时的 pending 书目");
    assert.deepEqual(harness.db.listLibraryDeletions(userId), ["tombstone-fresh"]);
    assert.deepEqual(
      harness.db.listReadyLibraryBooks(userId).map((book) => book.id),
      [oldReady.id],
      "ready 书目即使很久未更新也必须保留",
    );
    const pendingRows = harness.db.db
      .prepare("SELECT id FROM library_books WHERE user_id = ? AND state = 'pending' ORDER BY id")
      .all(userId) as Array<{ id: string }>;
    assert.deepEqual(pendingRows.map((row) => row.id), [freshPending.id]);
    const originals = harness.db.db
      .prepare("SELECT book_id FROM library_originals WHERE user_id = ?")
      .all(userId) as Array<{ book_id: string }>;
    assert.deepEqual(originals.map((row) => row.book_id), [oldReady.id], "旧 pending 的原文件随书目级联删除");
  });
});

test("runOperationalCleanup：定时任务同时清理过期会话", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "cleanup-session@example.com");
    const before = harness.db.db
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .get() as { count: number };
    assert.equal(Number(before.count), 1);
    harness.db.db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1_000);

    const removed = runOperationalCleanup(harness.db, { auditDays: 90, usageDays: 90 });
    assert.equal(removed.sessions, 1);
    const after = harness.db.db
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .get() as { count: number };
    assert.equal(Number(after.count), 0);
  });
});

/* ── 大小与配额限制 ───────────────────────────────────────────────────── */

test("拒绝超过 8 MB 的 meta 与超过 30 MB 的原文件", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-limits@example.com");

    const oversizedMeta = metadataFor("book-bigmeta");
    const metaResponse = await client.request(`/api/library/books/${oversizedMeta.id}/meta`, {
      method: "PUT",
      body: { ...oversizedMeta, warnings: ["x".repeat(MAX_BOOK_META_BYTES + 1024)] },
    });
    assert.equal(metaResponse.status, 413);

    // meta 本身合法（声明的原文件很小），但实际上传超出 30 MB。
    const smallBytes = Buffer.from("小文件", "utf8");
    assert.equal((await putMeta(client, metadataFor("book-bigfile", smallBytes))).status, 200);
    const originalResponse = await putOriginal(
      client,
      "book-bigfile",
      Buffer.alloc(MAX_BOOK_ORIGINAL_BYTES + 1),
    );
    assert.equal(originalResponse.status, 413);

    assert.deepEqual(await booksOf(await client.request("/api/library/books")), []);
  });
});

test(`每用户最多 ${MAX_LIBRARY_BOOKS} 本书，超出返回 409`, async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-book-quota@example.com");
    const bytes = Buffer.from("配额测试", "utf8");

    for (let index = 0; index < MAX_LIBRARY_BOOKS; index += 1) {
      const id = `book-quota-${String(index).padStart(3, "0")}`;
      const response = await putMeta(client, metadataFor(id, bytes));
      assert.equal(response.status, 200, `第 ${index + 1} 本书应被接受`);
      await response.text();
    }

    const rejected = await putMeta(client, metadataFor("book-quota-overflow", bytes));
    assert.equal(rejected.status, 409);
    assert.equal(await errorCode(rejected), "book_limit_reached");
  });
});

test("每用户原文件总量超过 500 MiB 时拒绝上传", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    const userId = await register(client, "library-byte-quota@example.com");
    const bytes = Buffer.from("原文件配额", "utf8");
    const first = metadataFor("book-quota-a", bytes);
    const second = metadataFor("book-quota-b", bytes);
    assert.equal((await putMeta(client, first)).status, 200);
    assert.equal((await putMeta(client, second)).status, 200);

    // 直接预置已占用的字节数（避免测试真的上传 500 MiB），验证聚合检查。
    harness.db.db
      .prepare(
        `INSERT INTO library_originals (user_id, book_id, sha256, byte_length, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        second.id,
        second.sha256,
        MAX_LIBRARY_ORIGINAL_BYTES_PER_USER - 10,
        new Uint8Array([1]),
        Date.now(),
      );

    const rejected = await putOriginal(client, first.id, bytes);
    assert.equal(rejected.status, 409);
    assert.equal(await errorCode(rejected), "library_quota_exceeded");
  });
});

/* ── 数据库迁移 ───────────────────────────────────────────────────────── */

test("schema v4 迁移创建删除墓碑并保留旧书架数据，重复打开幂等", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-schema-"));
  const file = path.join(dir, "zhixu.db");
  const userId = "schema-migration-user";
  const bytes = Buffer.from("旧库里的书不能被迁移丢掉。", "utf8");
  const meta = metadataFor("book-schema", bytes);
  const metaInput = {
    id: meta.id,
    sha256: meta.sha256,
    meta: JSON.stringify(meta),
    title: meta.title,
    author: meta.author,
    format: meta.format,
    fileName: meta.fileName,
    byteLength: meta.byteLength,
    importedAt: meta.importedAt,
    chapterCount: meta.chapters.length,
    blockCount: meta.blocks.length,
    characters: meta.blocks.reduce((sum, block) => sum + block.text.length, 0),
    warnings: JSON.stringify(meta.warnings),
    pageCount: meta.pageCount ?? null,
  };
  try {
    const db = new ZhixuDatabase(file);
    db.createUser({
      id: userId,
      email: "schema@example.com",
      name: "Schema",
      passwordHash: "hash",
      passwordSalt: "salt",
    });
    assert.equal(db.upsertLibraryMeta(userId, metaInput).ok, true);
    assert.equal(
      db.attachLibraryOriginal(userId, meta.id, meta.sha256, bytes.byteLength, bytes).ok,
      true,
    );
    db.close();

    // 构造 v3 旧库：没有墓碑表，但书架与原文件数据都在。
    const legacy = new DatabaseSync(file);
    legacy.exec("DROP TABLE library_deletions;");
    legacy.exec("PRAGMA user_version = 3;");
    legacy.close();

    assert.equal(LATEST_SCHEMA_VERSION, 4);
    const migrated = new ZhixuDatabase(file);
    try {
      const health = migrated.schemaHealth();
      assert.equal(health.ok, true);
      assert.equal(health.schemaVersion, 4);
      assert.equal(health.latestSchemaVersion, 4);
      assert.deepEqual(health.missingTables, []);
      assert.deepEqual(
        migrated.listReadyLibraryBooks(userId).map((book) => book.id),
        [meta.id],
      );
      assert.equal(migrated.getReadyLibraryMeta(userId, meta.id)?.meta, metaInput.meta);
      assert.deepEqual(migrated.listLibraryDeletions(userId), []);

      // 迁移后的删除立即写墓碑。
      assert.equal(migrated.deleteLibraryBook(userId, meta.id), true);
      assert.deepEqual(migrated.listLibraryDeletions(userId), [meta.id]);
    } finally {
      migrated.close();
    }

    // 再次打开是幂等迁移：版本不变，旧墓碑仍在。
    const reopened = new ZhixuDatabase(file);
    try {
      assert.equal(reopened.schemaHealth().ok, true);
      assert.equal(reopened.schemaHealth().schemaVersion, 4);
      assert.deepEqual(reopened.listLibraryDeletions(userId), [meta.id]);
      assert.deepEqual(reopened.listReadyLibraryBooks(userId), []);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 上传频率限制 ─────────────────────────────────────────────────────── */

test("同一账户每分钟最多 10 次原文件上传", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-rate@example.com");
    const bytes = Buffer.from("限流测试字节。", "utf8");
    const meta = metadataFor("book-rate", bytes);
    assert.equal((await putMeta(client, meta)).status, 200);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await putOriginal(client, meta.id, bytes);
      assert.equal(response.status, 200, `第 ${attempt + 1} 次上传应被接受`);
    }

    const limited = await putOriginal(client, meta.id, bytes);
    assert.equal(limited.status, 429);
    assert.equal(await errorCode(limited), "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });
});

/* ── 分块下载：背压、边界、断连与字节一致性 ───────────────────────────── */

test("分块泵在 write 背压时等待 drain，按 1 MiB 顺序读取且拼接字节完整", () => {
  const bytes = patternBytes(LIBRARY_DOWNLOAD_CHUNK_BYTES * 2 + 321);
  const { source, reads } = chunkedSource(bytes);
  const sink = new ControlledSink(1); // 每次 write 都返回 false，强制走 drain

  streamOriginalChunks(source, bytes.byteLength, sink);

  assert.equal(reads.length, 1, "写满背压后必须先等 drain，不能继续读库");
  assert.equal(sink.writes.length, 1);
  assert.equal(sink.ended, false);

  sink.emit("drain");
  assert.equal(reads.length, 2);
  assert.equal(sink.writes.length, 2);
  assert.equal(sink.ended, false);

  sink.emit("drain");
  assert.equal(reads.length, 3);
  assert.equal(sink.writes.length, 3);
  assert.equal(sink.ended, false);

  // 最后一块写完后 remaining=0：下一次 drain 直接结束，不再读库。
  sink.emit("drain");
  assert.equal(reads.length, 3);
  assert.equal(sink.ended, true);
  assert.equal(sink.destroyed, false);

  assert.deepEqual(
    reads.map((read) => [read.offset, read.length]),
    [
      [0, LIBRARY_DOWNLOAD_CHUNK_BYTES],
      [LIBRARY_DOWNLOAD_CHUNK_BYTES, LIBRARY_DOWNLOAD_CHUNK_BYTES],
      [LIBRARY_DOWNLOAD_CHUNK_BYTES * 2, 321],
    ],
  );
  const written = Buffer.concat(sink.writes.map((chunk) => Buffer.from(chunk)));
  assert.ok(written.equals(bytes));
});

test("原文件恰为分片整数倍时读取完整块后结束，不多读空块", () => {
  const bytes = patternBytes(LIBRARY_DOWNLOAD_CHUNK_BYTES * 2);
  const { source, reads } = chunkedSource(bytes);
  const sink = new ControlledSink();

  streamOriginalChunks(source, bytes.byteLength, sink);

  assert.deepEqual(
    reads.map((read) => [read.offset, read.length]),
    [
      [0, LIBRARY_DOWNLOAD_CHUNK_BYTES],
      [LIBRARY_DOWNLOAD_CHUNK_BYTES, LIBRARY_DOWNLOAD_CHUNK_BYTES],
    ],
  );
  assert.equal(sink.writes.length, 2);
  assert.equal(sink.ended, true);
  assert.equal(sink.destroyed, false);
  assert.ok(Buffer.concat(sink.writes.map((chunk) => Buffer.from(chunk))).equals(bytes));
});

test("客户端提前断开后停止分块读取，迟到的 drain 也不会再触碰 BLOB", () => {
  const bytes = patternBytes(LIBRARY_DOWNLOAD_CHUNK_BYTES * 4);
  const { source, reads } = chunkedSource(bytes);
  const sink = new ControlledSink(1);

  streamOriginalChunks(source, bytes.byteLength, sink);
  assert.equal(reads.length, 1);

  sink.emit("close");
  sink.emit("drain");
  sink.emit("error");

  assert.equal(reads.length, 1, "close 之后不得继续读取");
  assert.equal(sink.writes.length, 1);
  assert.equal(sink.ended, false, "客户端已断开时不应再向响应写入结束帧");
  assert.equal(sink.destroyed, false);
});

test("分片在下载途中不可见或读取失败时截断响应，不发送残缺内容", () => {
  const missing = new ControlledSink();
  streamOriginalChunks(
    { read: () => undefined },
    1024,
    missing,
  );
  assert.equal(missing.writes.length, 0);
  assert.equal(missing.destroyed, true);
  assert.equal(missing.ended, false);

  const failing = new ControlledSink();
  streamOriginalChunks(
    {
      read: () => {
        throw new Error("database gone");
      },
    },
    1024,
    failing,
  );
  assert.equal(failing.writes.length, 0);
  assert.equal(failing.destroyed, true);
});

test("大于一个分片的原文件分块下载，SHA、长度与响应头保持兼容", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-chunked@example.com");
    const bytes = patternBytes(LIBRARY_DOWNLOAD_CHUNK_BYTES + 12_345);
    const meta = metadataFor("book-chunked", bytes);
    await publish(client, meta, bytes);

    const reads = trackOriginalChunks(harness.db);
    const download = await client.request(`/api/library/books/${meta.id}/original`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(download.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(download.headers.get("x-book-sha256"), sha256(bytes));
    assert.equal(download.headers.get("cache-control"), "no-store, private");
    const disposition = download.headers.get("content-disposition") ?? "";
    assert.ok(disposition.startsWith("attachment;"), disposition);
    assert.ok(disposition.includes("filename*=UTF-8''"), disposition);

    const downloaded = Buffer.from(new Uint8Array(await download.arrayBuffer()));
    assert.equal(downloaded.byteLength, bytes.byteLength);
    assert.equal(sha256(downloaded), sha256(bytes));
    assert.ok(downloaded.equals(bytes));

    assert.deepEqual(
      reads.map((read) => [read.offset, read.length]),
      [
        [0, LIBRARY_DOWNLOAD_CHUNK_BYTES],
        [LIBRARY_DOWNLOAD_CHUNK_BYTES, 12_345],
      ],
    );
  });
});

test("原文件恰为分片整数倍时 HTTP 下载完整且只读取对应块", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "library-chunk-exact@example.com");
    const bytes = patternBytes(LIBRARY_DOWNLOAD_CHUNK_BYTES * 2);
    const meta = metadataFor("book-chunk-exact", bytes);
    await publish(client, meta, bytes);

    const reads = trackOriginalChunks(harness.db);
    const download = await client.request(`/api/library/books/${meta.id}/original`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-length"), String(bytes.byteLength));

    const downloaded = Buffer.from(new Uint8Array(await download.arrayBuffer()));
    assert.ok(downloaded.equals(bytes));
    assert.deepEqual(
      reads.map((read) => [read.offset, read.length]),
      [
        [0, LIBRARY_DOWNLOAD_CHUNK_BYTES],
        [LIBRARY_DOWNLOAD_CHUNK_BYTES, LIBRARY_DOWNLOAD_CHUNK_BYTES],
      ],
    );
  });
});

test("客户端下载中途断开不会拖垮服务，后续请求仍返回完整字节", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    const userId = await register(client, "library-abort@example.com");
    const bytes = Buffer.alloc(LIBRARY_DOWNLOAD_CHUNK_BYTES * 12, 0x5a);
    const meta = metadataFor("book-abort", bytes);
    assert.equal((await putMeta(client, meta)).status, 200);
    // 直接写库，避免测试为“断连”再走一遍 12 MiB 上传（上传路径已有覆盖）。
    const attached = harness.db.attachLibraryOriginal(
      userId,
      meta.id,
      meta.sha256,
      bytes.byteLength,
      bytes,
    );
    assert.equal(attached.ok, true);

    const reads = trackOriginalChunks(harness.db);
    const controller = new AbortController();
    const response = await client.request(`/api/library/books/${meta.id}/original`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(bytes.byteLength));

    const reader = response.body?.getReader();
    assert.ok(reader, "下载响应必须有 body");
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(reads.length >= 1, "开始下载后应至少读取一个分片");
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // 服务端只可能看过分片（≤ 1 MiB）；任何未捕获的写错误都会让测试进程失败。
    for (const read of reads) {
      assert.ok(read.length <= LIBRARY_DOWNLOAD_CHUNK_BYTES);
      assert.ok(Number.isSafeInteger(read.offset) && read.offset >= 0);
    }

    // 同一服务进程仍然健康：可以重新发起并完成完整下载。
    const again = await client.request(`/api/library/books/${meta.id}/original`);
    assert.equal(again.status, 200);
    const downloaded = Buffer.from(new Uint8Array(await again.arrayBuffer()));
    assert.equal(downloaded.byteLength, bytes.byteLength);
    assert.equal(sha256(downloaded), meta.sha256);
  });
});


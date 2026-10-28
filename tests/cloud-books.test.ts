import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { BookDocument, BookMetadata, BookSummary, CloudBookSummary } from "../src/bookTypes";
import {
  CloudBooksError,
  MAX_BOOK_ORIGINAL_BYTES,
  attemptBookUpload,
  deleteBookWithCloud,
  deleteCloudBook,
  downloadCloudBookOriginal,
  getCloudBookMeta,
  listCloudBooks,
  mergeBookSummaries,
  parseBookMetadata,
  parseCloudBookList,
  putCloudBookMeta,
  sha256Hex,
  toBookMetadata,
  uploadCloudBook,
} from "../src/lib/cloudBooks";
import type { Fetcher } from "../src/lib/cloudSync";

/* ── 夹具 ─────────────────────────────────────────────────────── */

const CONTENT = "云端书籍原文：理解必须回到出处。";
const BYTES = new TextEncoder().encode(CONTENT);
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const BOOK_ID = `book-${SHA256.slice(0, 24)}`;

function metaFixture(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    id: BOOK_ID,
    title: "跨设备读本",
    author: "示例作者",
    format: "txt",
    fileName: "cloud-book.txt",
    byteLength: BYTES.byteLength,
    sha256: SHA256,
    importedAt: 1_700_000_000_000,
    chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1", "c1-b2"] }],
    blocks: [
      { id: "c1-b1", chapterId: "c1", text: "云端书籍原文", locator: "第一章 · 第1段" },
      { id: "c1-b2", chapterId: "c1", text: "理解必须回到出处。", locator: "第一章 · 第2段" },
    ],
    warnings: [],
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<CloudBookSummary> = {}): CloudBookSummary {
  return {
    id: BOOK_ID,
    title: "跨设备读本",
    author: "示例作者",
    format: "txt",
    fileName: "cloud-book.txt",
    byteLength: BYTES.byteLength,
    importedAt: 1_700_000_000_000,
    chapterCount: 1,
    blockCount: 2,
    characters: 22,
    warnings: [],
    updatedAt: 1_700_000_000_500,
    ...overrides,
  };
}

function localSummary(id: string, importedAt: number, overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    id,
    title: `本地书 ${id}`,
    author: "",
    format: "txt",
    fileName: `${id}.txt`,
    byteLength: 20,
    importedAt,
    chapterCount: 1,
    blockCount: 1,
    characters: 10,
    warnings: [],
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface Call {
  path: string;
  init: RequestInit;
}

function recordingFetcher(handler: (path: string, init: RequestInit) => Response | Promise<Response>): {
  fetcher: Fetcher;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (path, init = {}) => {
      calls.push({ path, init });
      return handler(path, init);
    },
  };
}

function headersOf(call: Call): Headers {
  return new Headers(call.init.headers);
}

function expectCloudError(
  promise: Promise<unknown>,
  verify: (error: CloudBooksError) => void,
): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CloudBooksError, `应为 CloudBooksError，实际 ${String(error)}`);
    verify(error);
    return true;
  });
}

/* ── API 响应校验 ─────────────────────────────────────────────── */

test("读取云端书架：同源 Cookie、账户绑定头与严格摘要校验", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    jsonResponse({ books: [summaryFixture()], deleted: ["book-gone"] }),
  );
  const shelf = await listCloudBooks(fetcher, { expectedUserId: "u-1" });
  assert.equal(shelf.books.length, 1);
  assert.equal(shelf.books[0].id, BOOK_ID);
  assert.equal(shelf.books[0].updatedAt, 1_700_000_000_500);
  assert.deepEqual(shelf.deleted, ["book-gone"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/library/books");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(headersOf(calls[0]).get("X-Zhixu-User"), "u-1");
  assert.equal(headersOf(calls[0]).get("X-Zhixu-Request"), null);
});

test("旧服务端没有 deleted 字段时按空墓碑处理", async () => {
  const { fetcher } = recordingFetcher(() => jsonResponse({ books: [summaryFixture()] }));
  const shelf = await listCloudBooks(fetcher);
  assert.deepEqual(shelf.deleted, []);
  assert.equal(shelf.books.length, 1);
});

test("坏摘要、坏类型与重复 id 一律拒绝，不进入本地缓存", () => {
  const bad = [
    { books: [{ ...summaryFixture(), byteLength: 0 }] },
    { books: [{ ...summaryFixture(), format: "docx" }] },
    { books: [{ ...summaryFixture(), updatedAt: undefined }] },
    { books: [{ ...summaryFixture(), blockCount: 1.5 }] },
    { books: [summaryFixture(), summaryFixture()] },
    { books: "not-an-array" },
    { books: [], deleted: "not-an-array" },
    { books: [], deleted: ["../escape"] },
    { books: [], deleted: ["book-gone", "book-gone"] },
    { books: [summaryFixture()], deleted: [BOOK_ID] },
    {},
  ];
  for (const value of bad) {
    assert.throws(
      () => parseCloudBookList(value),
      error => error instanceof CloudBooksError && error.code === "invalid_metadata",
    );
  }
  assert.deepEqual(parseCloudBookList({ books: [], deleted: ["book-gone"] }), {
    books: [],
    deleted: ["book-gone"],
  });
});

test("云端 meta 必须与路径 id 一致，且不得夹带原文件", async () => {
  const wrongId = recordingFetcher(() => jsonResponse({ meta: metaFixture({ id: "book-other" }) }));
  await expectCloudError(
    getCloudBookMeta(wrongId.fetcher, BOOK_ID, { expectedUserId: "u-1" }),
    error => assert.equal(error.code, "invalid_metadata"),
  );

  assert.throws(
    () => parseBookMetadata({ ...metaFixture(), original: new Blob([BYTES]) }),
    error => error instanceof CloudBooksError && /original/.test(error.message),
  );
  assert.throws(
    () => parseBookMetadata(metaFixture(), "book-other"),
    error => error instanceof CloudBooksError && /id/.test(error.message),
  );
});

test("章节/段落 id 唯一且引用一致，坏数据不通过校验", () => {
  assert.throws(() => parseBookMetadata(metaFixture({ blocks: [
    { id: "dup", chapterId: "c1", text: "甲", locator: "第1段" },
    { id: "dup", chapterId: "c1", text: "乙", locator: "第2段" },
  ], chapters: [{ id: "c1", title: "章", blockIds: ["dup"] }] })), /重复/);
  assert.throws(() => parseBookMetadata(metaFixture({ chapters: [
    { id: "c1", title: "章", blockIds: ["c1-b1"] },
  ] })), /未被章节引用/);
  assert.throws(() => parseBookMetadata(metaFixture({ blocks: [
    { id: "c1-b1", chapterId: "c2", text: "正文", locator: "第1段" },
  ], chapters: [{ id: "c1", title: "章", blockIds: ["c1-b1"] }] })), /不一致/);
  assert.throws(() => parseBookMetadata(metaFixture({ blocks: [], chapters: [] })), /数量/);
});

test("显示字段拒绝全部控制字符（含 tab/LF/CR），正文换行与制表符仍可用", () => {
  const controls = ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"];
  for (const char of controls) {
    for (const field of ["title", "author", "fileName"] as const) {
      assert.throws(
        () => parseBookMetadata(metaFixture({ [field]: `前缀${char}后缀` })),
        (error: unknown) =>
          error instanceof CloudBooksError &&
          error.code === "invalid_metadata" &&
          error.message.includes("控制字符"),
        `${field} 含 ${JSON.stringify(char)} 时必须拒绝`,
      );
    }
  }

  assert.throws(() => parseBookMetadata(metaFixture({
    chapters: [{ id: "c1", title: "第一\t章", blockIds: ["c1-b1"] }],
    blocks: [{ id: "c1-b1", chapterId: "c1", text: "正文", locator: "第1段" }],
  })), /控制字符/);
  assert.throws(() => parseBookMetadata(metaFixture({
    chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1"] }],
    blocks: [{ id: "c1-b1", chapterId: "c1", text: "正文", locator: "第1段\n第2行" }],
  })), /控制字符/);
  assert.throws(
    () => parseCloudBookList({ books: [summaryFixture({ title: "书\u000b名" })] }),
    (error: unknown) => error instanceof CloudBooksError && error.message.includes("控制字符"),
  );

  // 服务端 bodyText 允许正文包含换行/制表符；客户端不能比服务端更严，否则本地书无法上传。
  const parsed = parseBookMetadata(metaFixture({
    blocks: [
      { id: "c1-b1", chapterId: "c1", text: "第一行\n第二行\t缩进", locator: "第一章 · 第1段" },
      { id: "c1-b2", chapterId: "c1", text: "尾段", locator: "第一章 · 第2段" },
    ],
    chapters: [{ id: "c1", title: "第一章", blockIds: ["c1-b1", "c1-b2"] }],
  }));
  assert.equal(parsed.blocks[0].text, "第一行\n第二行\t缩进");
});


/* ── 两阶段上传与预检 ─────────────────────────────────────────── */

test("上传先 meta 后 original，JSON 不含 Blob，原文件走 octet-stream", async () => {
  const { fetcher, calls } = recordingFetcher(path =>
    path.endsWith("/meta")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, sha256: SHA256, byteLength: BYTES.byteLength }),
  );
  const result = await uploadCloudBook(fetcher, {
    meta: metaFixture(),
    original: new Blob([BYTES]),
    expectedUserId: "u-1",
  });
  assert.deepEqual(result, { sha256: SHA256, byteLength: BYTES.byteLength });
  assert.deepEqual(calls.map(call => call.path), [
    `/api/library/books/${BOOK_ID}/meta`,
    `/api/library/books/${BOOK_ID}/original`,
  ]);
  assert.deepEqual(calls.map(call => call.init.method), ["PUT", "PUT"]);

  const metaHeaders = headersOf(calls[0]);
  assert.equal(metaHeaders.get("Content-Type"), "application/json");
  assert.equal(metaHeaders.get("X-Zhixu-Request"), "1");
  assert.equal(metaHeaders.get("X-Zhixu-User"), "u-1");
  assert.ok(calls[0].init.body instanceof Uint8Array);
  const parsed = JSON.parse(new TextDecoder().decode(calls[0].init.body as Uint8Array)) as Record<string, unknown>;
  assert.equal("original" in parsed, false);
  assert.equal(parsed.sha256, SHA256);
  assert.deepEqual(parsed.chapters, metaFixture().chapters);

  const originalHeaders = headersOf(calls[1]);
  assert.equal(originalHeaders.get("Content-Type"), "application/octet-stream");
  assert.equal(originalHeaders.get("X-Zhixu-Request"), "1");
  assert.ok(calls[1].init.body instanceof Blob);
  assert.equal(await (calls[1].init.body as Blob).text(), CONTENT);
});

test("只有显式重新导入才在 meta 请求携带清除墓碑的头", async () => {
  const plain = recordingFetcher(path =>
    path.endsWith("/meta")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, sha256: SHA256, byteLength: BYTES.byteLength }),
  );
  await uploadCloudBook(plain.fetcher, {
    meta: metaFixture(),
    original: new Blob([BYTES]),
    expectedUserId: "u-1",
  });
  assert.equal(headersOf(plain.calls[0]).get("X-Zhixu-Reimport"), null);
  assert.equal(headersOf(plain.calls[1]).get("X-Zhixu-Reimport"), null);

  const reimport = recordingFetcher(path =>
    path.endsWith("/meta")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, sha256: SHA256, byteLength: BYTES.byteLength }),
  );
  await uploadCloudBook(reimport.fetcher, {
    meta: metaFixture(),
    original: new Blob([BYTES]),
    expectedUserId: "u-1",
    reimport: true,
  });
  assert.equal(headersOf(reimport.calls[0]).get("X-Zhixu-Reimport"), "1");
  assert.equal(headersOf(reimport.calls[1]).get("X-Zhixu-Reimport"), null);

  const metaOnly = recordingFetcher(() => jsonResponse({ ok: true }));
  await putCloudBookMeta(metaOnly.fetcher, metaFixture(), { reimport: true });
  assert.equal(headersOf(metaOnly.calls[0]).get("X-Zhixu-Reimport"), "1");
});

test("上传前完成原文件大小与元数据校验，失败时不发任何请求", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ ok: true }));

  await expectCloudError(
    uploadCloudBook(fetcher, {
      meta: metaFixture({ title: "含\t制表符的书名" }),
      original: new Blob([BYTES]),
    }),
    error => {
      assert.equal(error.status, 0);
      assert.equal(error.code, "invalid_metadata");
      assert.match(error.message, /控制字符/);
    },
  );

  await expectCloudError(
    uploadCloudBook(fetcher, {
      meta: metaFixture({ byteLength: BYTES.byteLength + 1 }),
      original: new Blob([BYTES]),
    }),
    error => assert.equal(error.code, "original_size_mismatch"),
  );

  const oversized = new Blob([BYTES]);
  Object.defineProperty(oversized, "size", { value: MAX_BOOK_ORIGINAL_BYTES + 1 });
  await expectCloudError(
    uploadCloudBook(fetcher, { meta: metaFixture(), original: oversized }),
    error => assert.equal(error.code, "original_too_large"),
  );

  await expectCloudError(
    uploadCloudBook(fetcher, { meta: metaFixture({ sha256: "not-a-sha" }), original: new Blob([BYTES]) }),
    error => assert.equal(error.code, "invalid_metadata"),
  );

  assert.equal(calls.length, 0);
});

test("服务端返回的原文件摘要不一致时停止同步", async () => {
  const { fetcher } = recordingFetcher(path =>
    path.endsWith("/meta")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, sha256: "0".repeat(64), byteLength: BYTES.byteLength }),
  );
  await expectCloudError(
    uploadCloudBook(fetcher, { meta: metaFixture(), original: new Blob([BYTES]) }),
    error => assert.equal(error.code, "sha256_mismatch"),
  );
});

test("meta 阶段失败时绝不发送原文件", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    jsonResponse({ error: "元数据不合法", code: "invalid_metadata" }, 400),
  );
  await expectCloudError(
    uploadCloudBook(fetcher, { meta: metaFixture(), original: new Blob([BYTES]) }),
    error => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_metadata");
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.endsWith("/meta"));
});

test("每个网络阶段发出前执行检查，失败后绝不再发后续请求", async () => {
  const seen: string[] = [];
  const metaOnly = recordingFetcher(path =>
    path.endsWith("/meta")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, sha256: SHA256, byteLength: BYTES.byteLength }),
  );
  await expectCloudError(
    uploadCloudBook(metaOnly.fetcher, {
      meta: metaFixture(),
      original: new Blob([BYTES]),
      beforeStage: async stage => {
        seen.push(stage);
        await Promise.resolve();
        if (stage === "original") throw new CloudBooksError("本地书籍已删除", 0, "upload_cancelled");
      },
    }),
    error => assert.equal(error.code, "upload_cancelled"),
  );
  assert.deepEqual(seen, ["meta", "original"]);
  assert.deepEqual(metaOnly.calls.map(call => call.path), [
    `/api/library/books/${BOOK_ID}/meta`,
  ]);

  seen.length = 0;
  const none = recordingFetcher(() => jsonResponse({ ok: true }));
  await expectCloudError(
    uploadCloudBook(none.fetcher, {
      meta: metaFixture(),
      original: new Blob([BYTES]),
      beforeStage: stage => {
        seen.push(stage);
        throw new CloudBooksError("本地书籍已删除", 0, "upload_cancelled");
      },
    }),
    error => assert.equal(error.code, "upload_cancelled"),
  );
  assert.deepEqual(seen, ["meta"]);
  assert.equal(none.calls.length, 0);
});

/* ── 下载与 SHA-256 校验 ──────────────────────────────────────── */

test("下载原文件必须字节数与 SHA-256 都匹配后才返回", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    new Response(new Blob([BYTES]), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(BYTES.byteLength),
        "X-Book-SHA256": SHA256,
      },
    }),
  );
  const downloaded = await downloadCloudBookOriginal(fetcher, metaFixture(), { expectedUserId: "u-1" });
  assert.equal(await downloaded.blob.text(), CONTENT);
  assert.equal(downloaded.sha256, SHA256);
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(headersOf(calls[0]).get("X-Zhixu-User"), "u-1");
  assert.equal(headersOf(calls[0]).get("X-Zhixu-Request"), null);
});

test("原文件内容被篡改、长度不符或服务端摘要不符时拒绝", async () => {
  const wrongBytes = new Uint8Array(BYTES);
  wrongBytes[0] ^= 0xff;
  const modified = recordingFetcher(() =>
    new Response(new Blob([wrongBytes]), {
      headers: {
        "Content-Length": String(BYTES.byteLength),
        "X-Book-SHA256": SHA256,
      },
    }),
  );
  await expectCloudError(
    downloadCloudBookOriginal(modified.fetcher, metaFixture()),
    error => assert.equal(error.code, "sha256_mismatch"),
  );

  const wrongLength = recordingFetcher(() =>
    new Response(new Blob([BYTES.slice(0, 3)]), {
      headers: { "Content-Length": String(BYTES.byteLength) },
    }),
  );
  await expectCloudError(
    downloadCloudBookOriginal(wrongLength.fetcher, metaFixture()),
    error => assert.equal(error.code, "sha256_mismatch"),
  );

  const wrongHeader = recordingFetcher(() =>
    new Response(new Blob([BYTES]), {
      headers: {
        "Content-Length": String(BYTES.byteLength),
        "X-Book-SHA256": "f".repeat(64),
      },
    }),
  );
  await expectCloudError(
    downloadCloudBookOriginal(wrongHeader.fetcher, metaFixture()),
    error => assert.equal(error.code, "sha256_mismatch"),
  );
});

test("Web Crypto SHA-256 与已知摘要一致", async () => {
  const digest = await sha256Hex(new TextEncoder().encode("abc"));
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

/* ── 合并与失败回退 ───────────────────────────────────────────── */

test("本地与云端书架按 id 去重，本地版本优先，云端独有补入并按时间排序", () => {
  const localNewer = localSummary("book-shared", 30, { title: "本地标题优先" });
  const localOlder = localSummary("book-local", 10);
  const cloudSame = summaryFixture({ id: "book-shared", title: "云端标题", importedAt: 30 });
  const cloudOnly = summaryFixture({ id: "book-cloud", importedAt: 20 });
  const merged = mergeBookSummaries([localNewer, localOlder], [cloudSame, cloudOnly]);
  assert.deepEqual(merged.map(book => book.id), ["book-shared", "book-cloud", "book-local"]);
  assert.equal(merged[0].title, "本地标题优先");
  assert.equal(merged.length, 3);

  // 服务端墓碑优先：本机残留缓存与云端都不得再展示已删除 id。
  const hidden = mergeBookSummaries(
    [localNewer, localOlder],
    [cloudSame, cloudOnly],
    ["book-shared"],
  );
  assert.deepEqual(hidden.map(book => book.id), ["book-cloud", "book-local"]);
});

test("后台上传失败只回退为 pending，不抛错也不假装成功", async () => {
  let uploaded = 0;
  let failure: unknown;
  const result = await attemptBookUpload({
    upload: async () => { throw new CloudBooksError("网络连接失败", 0, "network"); },
    onUploaded: () => { uploaded += 1; },
    onFailed: error => { failure = error; },
  });
  assert.equal(result, false);
  assert.equal(uploaded, 0);
  assert.ok(failure instanceof CloudBooksError);
  assert.equal(failure.code, "network");

  const success = await attemptBookUpload({
    upload: async () => undefined,
    onUploaded: () => { uploaded += 1; },
  });
  assert.equal(success, true);
  assert.equal(uploaded, 1);
});

/* ── 删除顺序 ─────────────────────────────────────────────────── */

test("删除先云端成功再删本地；云端失败保留本地", async () => {
  const order: string[] = [];
  await deleteBookWithCloud(
    async () => { order.push("cloud"); },
    async () => { order.push("local"); },
  );
  assert.deepEqual(order, ["cloud", "local"]);

  order.length = 0;
  await expectCloudError(
    deleteBookWithCloud(
      async () => { order.push("cloud:401"); throw new CloudBooksError("登录状态已失效", 401); },
      async () => { order.push("local"); },
    ),
    error => assert.equal(error.status, 401),
  );
  assert.deepEqual(order, ["cloud:401"]);

  order.length = 0;
  await deleteBookWithCloud(
    async () => { order.push("cloud:404"); throw new CloudBooksError("已经不存在", 404); },
    async () => { order.push("local"); },
  );
  assert.deepEqual(order, ["cloud:404", "local"]);

  order.length = 0;
  await deleteBookWithCloud(null, async () => { order.push("local:offline"); });
  assert.deepEqual(order, ["local:offline"]);
});

test("云端 DELETE 404 视为已删；401/账户不匹配原样报错", async () => {
  const notFound = recordingFetcher(() => jsonResponse({ error: "没有这本书" }, 404));
  await deleteCloudBook(notFound.fetcher, BOOK_ID, { expectedUserId: "u-1" });
  const headers = headersOf(notFound.calls[0]);
  assert.equal(notFound.calls[0].init.method, "DELETE");
  assert.equal(headers.get("X-Zhixu-Request"), "1");
  assert.equal(headers.get("X-Zhixu-User"), "u-1");

  const unauthorized = recordingFetcher(() => jsonResponse({ error: "请重新登录" }, 401));
  await expectCloudError(
    deleteCloudBook(unauthorized.fetcher, BOOK_ID),
    error => assert.equal(error.status, 401),
  );

  const mismatch = recordingFetcher(() =>
    jsonResponse({ error: "账户不匹配", code: "account_mismatch" }, 409),
  );
  await expectCloudError(
    deleteCloudBook(mismatch.fetcher, BOOK_ID, { expectedUserId: "u-2" }),
    error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "account_mismatch");
    },
  );
});

/* ── 元数据转换 ───────────────────────────────────────────────── */

test("BookDocument 转元数据只挑选公开字段，不携带 original Blob", () => {
  const book: BookDocument = { ...metaFixture(), original: new Blob([BYTES]) };
  const meta = toBookMetadata(book);
  assert.equal("original" in meta, false);
  assert.notEqual(meta.blocks, book.blocks);
  assert.notEqual(meta.chapters, book.chapters);
  assert.deepEqual(parseBookMetadata(meta), meta);
});
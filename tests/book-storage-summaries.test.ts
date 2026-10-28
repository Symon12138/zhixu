import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import type { BookDocument } from "../src/bookTypes";
import {
  deleteBook,
  getLocalBook,
  listBooks,
  listLocalBooks,
  retryBookMigration,
  saveBook,
  saveBookProgress,
  setBookOwner,
} from "../src/lib/bookStorage";
import { installFakeIndexedDB } from "./helpers/fakeIndexedDB";

const { factory, restore } = installFakeIndexedDB();

after(() => restore());

function bookFixture(options: {
  id: string;
  texts: readonly string[];
  title?: string;
}): BookDocument {
  const chapters = options.texts.map((_, index) => ({
    id: `c${index + 1}`,
    title: `第${index + 1}章`,
    blockIds: [`b${index + 1}`],
  }));
  const blocks = options.texts.map((text, index) => ({
    id: `b${index + 1}`,
    chapterId: `c${index + 1}`,
    text,
    locator: `第${index + 1}段`,
  }));
  const bytes = new TextEncoder().encode(options.texts.join(""));
  return {
    id: options.id,
    title: options.title ?? "摘要测试书",
    author: "摘要作者",
    format: "txt",
    fileName: `${options.id}.txt`,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    importedAt: 1_700_000_000_000,
    chapters,
    blocks,
    warnings: ["解析提示"],
    pageCount: 42,
    original: new Blob([bytes.slice(0, 1024)]),
  };
}

const LARGE_TEXTS = ["甲".repeat(500_000), "乙".repeat(300_000)] as const;

/* 先准备 v2 旧库，验证升级时会把旧书回填进 summaries。 */
test("v2 书架升级到 v3 时为旧书回填摘要", async () => {
  setBookOwner(null);
  const book = bookFixture({ id: "book-v2-legacy", texts: LARGE_TEXTS });
  factory.seedDatabase("zhixu-books", 2, {
    books: { keyPath: "id", values: [book] },
    progress: { keyPath: "bookId", values: [] },
    pending: { keyPath: "id", values: [] },
  });

  const shelf = await listBooks();
  assert.equal(shelf.length, 1);
  assert.equal(shelf[0].id, book.id);
  assert.equal(shelf[0].characters, 800_000);
  const summaries = factory.getStore("zhixu-books", "summaries");
  assert.ok(summaries?.has(book.id), "升级后必须回填 summaries");
  factory.clearData();
});

test("listLocalBooks 只读 summaries，不反序列化大正文", async () => {
  setBookOwner(null);
  const book = bookFixture({ id: "book-large-summary", texts: LARGE_TEXTS });
  await saveBook(book);

  factory.log.length = 0;
  const shelf = await listBooks();

  assert.deepEqual(shelf, [{
    id: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    fileName: book.fileName,
    byteLength: book.byteLength,
    importedAt: book.importedAt,
    chapterCount: 2,
    blockCount: 2,
    characters: 800_000,
    warnings: ["解析提示"],
    pageCount: 42,
  }]);
  assert.ok(factory.log.length > 0, "应当确实读取了摘要");
  assert.ok(
    factory.log.every(entry => entry.store === "summaries"),
    `列表不应读取正文 store，实际读取：${JSON.stringify(factory.log)}`,
  );

  const summary = factory.getStore("zhixu-books", "summaries")?.get(book.id) as Record<string, unknown>;
  assert.equal(summary.sha256, book.sha256);
  assert.equal(summary.characters, 800_000);
  assert.equal(summary.cloudState, "local");
  assert.equal(typeof summary.updatedAt, "number");
  assert.equal("blocks" in summary, false);
  assert.equal("original" in summary, false);
  const stored = factory.getStore("zhixu-books", "books")?.get(book.id) as BookDocument;
  assert.equal(stored.blocks[0].text.length, 500_000, "正文仍完整保存在 books store");
  factory.clearData();
});

test("删除书籍时级联删除摘要", async () => {
  setBookOwner(null);
  const book = bookFixture({ id: "book-delete-summary", texts: ["删除后摘要也必须消失"] });
  await saveBook(book);
  assert.ok(factory.getStore("zhixu-books", "summaries")?.has(book.id));

  await deleteBook(book.id);

  assert.equal(factory.getStore("zhixu-books", "summaries")?.has(book.id), false);
  assert.equal(factory.getStore("zhixu-books", "books")?.has(book.id), false);
  assert.deepEqual(await listLocalBooks(), []);
  assert.equal(await getLocalBook(book.id), undefined);
  factory.clearData();
});

test("匿名迁移按摘要选择候选，只按 id 读取待迁移正文", async () => {
  setBookOwner(null);
  const book = bookFixture({ id: "book-migrated-summary", texts: LARGE_TEXTS });
  await saveBook(book);

  factory.log.length = 0;
  setBookOwner("summary-migration-user");
  const state = await retryBookMigration();

  assert.equal(state.status, "completed");
  assert.equal(state.migratedBooks, 1);
  assert.equal(
    factory.log.some(entry => entry.db === "zhixu-books" && entry.store === "books" && entry.op === "getAll"),
    false,
    "迁移不得用 getAll 一次性反序列化匿名库全部正文",
  );
  assert.equal(
    factory.log.some(entry => entry.db === "zhixu-books" && entry.store === "books" && entry.op === "get"),
    true,
    "只应按候选 id 读取正文",
  );
  assert.equal(
    factory.log.some(entry => entry.db === "zhixu-books" && entry.store === "summaries" && entry.op === "getAll"),
    true,
  );

  const accountDb = "zhixu-books-u-summary-migration-user";
  assert.ok(factory.getStore(accountDb, "books")?.has(book.id), "账户库应写入完整书籍");
  const summary = factory.getStore(accountDb, "summaries")?.get(book.id) as Record<string, unknown>;
  assert.equal(summary.sha256, book.sha256);
  assert.equal(summary.characters, 800_000);
  assert.equal(summary.chapterCount, 2);
  assert.equal(summary.blockCount, 2);

  setBookOwner(null);
  factory.clearData();
});

test("匿名迁移按摘要逐本迁移并保留有效阅读进度", async () => {
  setBookOwner(null);
  const book = bookFixture({ id: "book-migrated-progress", texts: ["进度跟着书一起迁移"] });
  await saveBook(book);
  await saveBookProgress({
    bookId: book.id,
    chapterId: "c1",
    blockId: "b1",
    readChapterIds: ["c1"],
    updatedAt: 1_700_000_000_500,
  });

  setBookOwner("summary-progress-user");
  const state = await retryBookMigration();
  assert.equal(state.status, "completed");
  assert.equal(state.migratedBooks, 1);
  assert.equal(state.migratedProgress, 1);

  const accountDb = "zhixu-books-u-summary-progress-user";
  const progress = factory.getStore(accountDb, "progress")?.get(book.id) as Record<string, unknown>;
  assert.equal(progress.chapterId, "c1");
  assert.equal(progress.blockId, "b1");

  setBookOwner(null);
  factory.clearData();
});

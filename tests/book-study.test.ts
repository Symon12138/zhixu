import assert from "node:assert/strict";
import test from "node:test";
import { prepareBookStudy } from "../src/lib/bookStudy";
import type { BookDocument } from "../src/bookTypes";

function bookWith(chapterSizes: number[], blockSize = 400): BookDocument {
  const chapters = chapterSizes.map((_, index) => ({ id: `chapter-${index}`, title: `第${index + 1}章`, blockIds: [] as string[] }));
  const blocks = chapters.flatMap((chapter, index) => Array.from({ length: chapterSizes[index] }, (_, ordinal) => {
    const id = `${chapter.id}-block-${ordinal}`;
    chapter.blockIds.push(id);
    return { id, chapterId: chapter.id, text: `${id}：${"原文".repeat(blockSize)}`, locator: `${chapter.title} · 第${ordinal + 1}段` };
  }));
  return { id: "owned-book", title: "本地示例读本", author: "示例作者", format: "epub", fileName: "owned.epub", byteLength: 100, sha256: "hash", importedAt: 1, chapters, blocks, warnings: [], original: new Blob(["fixture"]) };
}

test("长章按连续窗口提供原文，不把部分片段标成整章或整书", () => {
  const book = bookWith([60, 2], 800);
  const selected = book.blocks[35];
  const result = prepareBookStudy(book, { mode: "chapter", chapterId: selected.chapterId, blockId: selected.id });
  assert.ok(result.references.some(reference => reference.location?.blockId === selected.id));
  assert.equal(result.references[0].location!.blockId, book.blocks[34].id);
  assert.ok(result.references.length <= 20);
  assert.ok(result.references.reduce((sum, reference) => sum + reference.text.length, 0) <= 24_000);
  assert.equal(result.context.completeBook, false);
  assert.equal(result.context.completeChapter, false);
  for (const reference of result.references) assert.equal(reference.text, book.blocks.find(block => block.id === reference.location!.blockId)!.text);
  assert.deepEqual(result.context.suppliedBlockIds, result.references.map(reference => reference.location!.blockId));
});

test("目录导览只给章节开头，有省略则不声称完整读完", () => {
  const book = bookWith([3, 3, 3]);
  const result = prepareBookStudy(book, { mode: "overview" });
  assert.deepEqual(result.references.map(reference => reference.location!.blockId), ["chapter-0-block-0", "chapter-1-block-0", "chapter-2-block-0"]);
  assert.equal(result.context.completeBook, false);
  assert.equal(result.context.completeChapter, false);
  assert.deepEqual(result.context.tableOfContents, book.chapters.map(chapter => chapter.title));
});

test("提取警告与缺页阻止完整覆盖声明，即使当前文本都已提供", () => {
  const book = bookWith([2]);
  const clean = prepareBookStudy(book, { mode: "chapter", chapterId: "chapter-0" });
  assert.equal(clean.context.completeChapter, true);
  assert.equal(clean.context.completeBook, true);
  book.warnings.push("PDF文件第2页没有可读取的文本，未完成OCR");
  const limited = prepareBookStudy(book, { mode: "chapter", chapterId: "chapter-0" });
  assert.equal(limited.context.completeChapter, false);
  assert.equal(limited.context.completeBook, false);
});

test("不存在的章节或段落明确失败，不偷换为第一章", () => {
  const book = bookWith([2]);
  assert.throws(() => prepareBookStudy(book, { mode: "chapter", chapterId: "missing" }));
  assert.throws(() => prepareBookStudy(book, { mode: "chapter", chapterId: "chapter-0", blockId: "missing" }));
});

 test("长书名与章节名不会产生同名引文，不丢失原始段落身份", () => {
  const book = bookWith([2]);
  book.title = "很长的书名".repeat(100);
  book.chapters[0].title = "很长的章节".repeat(100);
  book.blocks.forEach(block => { block.locator = "位置".repeat(150); });
  const result = prepareBookStudy(book, { mode: "chapter" });
  assert.notEqual(result.references[0].name, result.references[1].name);
  assert.ok(result.references.every(reference => reference.name.length <= 300));
  assert.equal(result.references[0].location!.bookId, book.id);
});

test("章节标题独占首块时导览仍提供真正正文，而不是仅把目录再传一遍", () => {
  const book = bookWith([3, 3]);
  for (const chapter of book.chapters) book.blocks.find(block => block.id === chapter.blockIds[0])!.text = chapter.title;
  const result = prepareBookStudy(book, { mode: "overview" });
  assert.deepEqual(result.context.suppliedBlockIds, ["chapter-0-block-1", "chapter-1-block-1"]);
  assert.ok(result.references.every(reference => reference.text !== reference.location!.chapterTitle));
  assert.equal(result.context.completeBook, false);
});

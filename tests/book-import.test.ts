import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { extractEpubEntries, importBook } from "../src/lib/bookImport";

const originalParagraphs = ["原文、解读和个人笔记不能互相冒充。", "引用应能定位到所读原文，而不是只显示书名。", "看过一个章节并不等于理解它。"];

test("UTF8章节按正文顺序导入，空标题不制造空章节，段落文字不丢失", async () => {
  const text = `# 原创读本\n\n## 第一章 原文\n\n${originalParagraphs[0]}\n\n${originalParagraphs[1]}\n\n## 第二章 理解\n\n${originalParagraphs[2]}`;
  const result = await importBook(new File([text], "reading.md"));
  assert.deepEqual(result.chapters.map(chapter => chapter.title), ["第一章 原文", "第二章 理解"]);
  assert.deepEqual(result.blocks.map(block => block.text), originalParagraphs);
  assert.ok(result.blocks.every(block => result.chapters.find(chapter => chapter.id === block.chapterId)?.blockIds.includes(block.id)));
  assert.equal(await result.original.text(), text);
});

test("长段落只切块不省略文字，代理对与中文尾句保留", async () => {
  const text = "甲乙丙丁".repeat(1500) + "尾部🙂结论仍在。";
  const result = await importBook(new File([text], "long.txt"));
  assert.equal(result.blocks.map(block => block.text).join(""), text);
  assert.ok(result.blocks.every(block => block.text.length <= 1600));
  assert.equal(new Set(result.blocks.map(block => block.id)).size, result.blocks.length);
});

test("同文件内容重导入身份不变，内容改变则不会覆盖旧书", async () => {
  const first = await importBook(new File(["原始正文"], "one.txt"));
  const duplicate = await importBook(new File(["原始正文"], "renamed.txt"));
  const changed = await importBook(new File(["修订正文"], "one.txt"));
  assert.equal(first.id, duplicate.id);
  assert.equal(first.sha256, duplicate.sha256);
  assert.notEqual(first.id, changed.id);
});

test("错误编码、二进制、伪PDF、空文件和超限输入明确拒绝，不静默转换", async () => {
  const bad = [
    new File([Uint8Array.from([0xff, 0xfe, 0x61])], "legacy.txt"),
    new File(["text\u0000binary"], "binary.md"),
    new File(["not a PDF"], "fake.pdf"),
    new File([], "empty.txt"),
    new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.txt"),
    new File(["x".repeat(2_000_001)], "too-long.txt"),
  ];
  for (const file of bad) await assert.rejects(importBook(file));
});

test("已取消导入不读取文件也不产生书籍", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  const file = new File(["原文"], "book.txt");
  let reads = 0;
  file.arrayBuffer = async () => { reads++; return new ArrayBuffer(0); };
  await assert.rejects(importBook(file, undefined, controller.signal), error => error === reason);
  assert.equal(reads, 0);
});

test("EPUB压缩正文提取有界，路径穿越与超大正文文件拒绝", async () => {
  const minimal = { "META-INF/container.xml": strToU8("<container/>"), "OPS/one.xhtml": strToU8("<html>original</html>") };
  const result = await extractEpubEntries(zipSync(minimal));
  assert.equal(new TextDecoder().decode(result.get("OPS/one.xhtml")), "<html>original</html>");
  await assert.rejects(extractEpubEntries(zipSync({ ...minimal, "../escape.xml": strToU8("not allowed") })));
  await assert.rejects(extractEpubEntries(zipSync({ ...minimal, "OPS/giant.xhtml": new Uint8Array(12 * 1024 * 1024 + 1) })));
  await assert.rejects(extractEpubEntries(zipSync({ "OPS/book.xhtml": strToU8("missing container") })));
});

import type { BookDocument, BookStudyContext, BookStudySelection } from "../bookTypes";
import type { Reference } from "../types";

const MAX_SOURCE_BLOCKS = 20;
const MAX_SOURCE_CHARACTERS = 24_000;

/** Select actual source blocks; never pass an entire long book as chat history. */
export function prepareBookStudy(book: BookDocument, selection: BookStudySelection): {
  context: BookStudyContext;
  references: Reference[];
  prompt: string;
  topic: string;
} {
  if (!book.blocks.length || !book.chapters.length) throw new Error("书籍中没有可供学习的正文。");
  const chapter = book.chapters.find(item => item.id === selection.chapterId) ?? book.chapters[0];
  if (selection.chapterId && chapter.id !== selection.chapterId) throw new Error("这章已不存在，请重新打开书籍。");
  const byId = new Map(book.blocks.map(block => [block.id, block]));
  const chapterBlocks = chapter.blockIds.map(id => byId.get(id)).filter((block): block is BookDocument["blocks"][number] => !!block);
  if (!chapterBlocks.length) throw new Error("这章没有可读取的文本，请查看解析提示。");
  const focusIndex = selection.blockId ? chapterBlocks.findIndex(block => block.id === selection.blockId) : 0;
  if (selection.blockId && focusIndex < 0) throw new Error("没有找到这段原文，请重新选择。");
  // Overview samples chapter openings explicitly; chapter/review use a contiguous source window.
  const candidates = selection.mode === "overview"
    ? book.chapters.flatMap(item => {
        let first = byId.get(item.blockIds[0]);
        for (const id of item.blockIds) {
          const block = byId.get(id);
          if (block && block.text !== item.title) { first = block; break; }
        }
        return first ? [first] : [];
      })
    : chapterBlocks.slice(Math.max(0, focusIndex - (selection.blockId ? 1 : 0)));
  const chosen: typeof book.blocks = [];
  let characters = 0;
  for (const block of candidates) {
    if (chosen.length >= MAX_SOURCE_BLOCKS || characters + block.text.length > MAX_SOURCE_CHARACTERS) break;
    chosen.push(block);
    characters += block.text.length;
  }
  if (!chosen.length) throw new Error("所选段落过长，无法在本轮完整提供原文。请先拆分文件中的长段。");
  const references: Reference[] = chosen.map(block => {
    const sourceChapter = book.chapters.find(item => item.id === block.chapterId)!;
    return {
      name: `《${book.title.slice(0, 80)}》·${sourceChapter.title.slice(0, 55)}·${block.locator.slice(0, 90)} [${block.id}]`.slice(0, 300),
      text: block.text,
      location: {
        bookId: book.id,
        chapterId: block.chapterId,
        blockId: block.id,
        chapterTitle: sourceChapter.title,
        locator: block.locator,
        ...(block.page === undefined ? {} : { page: block.page }),
      },
    };
  });
  const completeBook = chosen.length === book.blocks.length && book.warnings.length === 0;
  const completeChapter = selection.mode !== "overview" && chosen.length === chapterBlocks.length && book.warnings.length === 0;
  const context: BookStudyContext = {
    bookId: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    mode: selection.mode,
    ...(selection.mode === "overview" ? {} : { chapterId: chapter.id, chapterTitle: chapter.title }),
    tableOfContents: book.chapters.map(item => item.title),
    totalChapters: book.chapters.length,
    totalBlocks: book.blocks.length,
    chapterBlocks: selection.mode === "overview" ? 0 : chapterBlocks.length,
    suppliedBlockIds: chosen.map(block => block.id),
    completeChapter,
    completeBook,
  };
  const scope = selection.mode === "overview"
    ? `本轮只提供目录和${chosen.length}段章节开头，不代表已通读全书。`
    : `本轮提供「${chapter.title}」的${chosen.length}/${chapterBlocks.length}段原文${completeChapter ? "，覆盖本章提取文本" : "，仅可根据这些片段讲解，未提供部分不能补写"}。`;
  const instruction = selection.mode === "overview"
    ? "请根据真实目录和已提供的章节开头，说明这本书提出什么问题、已见材料之间的联系，并给出建议阅读顺序。未读章节只能列出标题和待核对问题，不编造其论点、案例或结论。先讲清楚，不要把目录改成考试。"
    : selection.mode === "review"
      ? "请根据已提供原文做一次主动回忆：先只说明复习范围，不先重讲结论或演示解法；给一个原文没有直接解答的新小情境，问一个具体问题。引用可支持概念，但不能直接给出新情境答案；我的真实回答才作理解证据，不会时再补基础。"
      : selection.blockId
        ? "请围绕选中的这段及相邻原文陪我学习：先解释必要术语和作者这一步怎样论证，区分原文、你的解释与自拟例子，然后最多问一个聚焦问题。"
        : "请陪我学习这章已提供的原文：先说明它在解决什么问题，用原文的一个具体细节解释关键机制；不要先让我猜陌生术语，然后最多问一个聚焦问题。";
  return {
    context,
    references,
    topic: `《${book.title.slice(0, 140)}》${selection.mode === "overview" ? "·阅读导览" : `·${chapter.title.slice(0, 140)}`}`,
    prompt: `${scope}\n\n${instruction}\n\n讲解至少引用一段本轮实际提供的短原文，以便回看出处。${book.warnings.length ? `\n解析限制共${book.warnings.length}项，以下列前3项，其余请在原书阅读页查看：${book.warnings.slice(0, 3).join("；")}` : ""}`,
  };
}

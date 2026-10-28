import type { BookSourceLocation, BookStudyContext } from "../bookTypes";
import type { Reference } from "../types";

export class BookContextError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BookContextError(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 300, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new BookContextError(`${label}必须为${allowEmpty ? "" : "非空"}文字，最多${max}字符。`);
  return value.trim();
}
function integer(value: unknown, label: string, max: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) > max) throw new BookContextError(`${label}数量不合法。`);
  return value as number;
}

export function parseBookSourceLocation(value: unknown): BookSourceLocation | undefined {
  if (value === undefined || value === null) return undefined;
  const data = record(value, "书籍出处");
  return {
    bookId: string(data.bookId, "bookId", 150),
    chapterId: string(data.chapterId, "chapterId", 150),
    blockId: string(data.blockId, "blockId", 150),
    chapterTitle: string(data.chapterTitle, "chapterTitle"),
    locator: string(data.locator, "locator"),
    ...(data.page === undefined ? {} : { page: integer(data.page, "PDF文件页序", 3000) }),
  };
}

export function parseBookContext(value: unknown, references: Reference[] = []): BookStudyContext | undefined {
  if (value === undefined || value === null) {
    if (references.some(reference => reference.location)) throw new BookContextError("带书籍定位的原文需要明确bookContext，不能丢失范围声明。");
    return undefined;
  }
  const data = record(value, "bookContext");
  const bookId = string(data.bookId, "bookId", 150);
  const title = string(data.title, "书名");
  const author = string(data.author ?? "", "作者", 300, true);
  if (!["pdf", "epub", "txt", "md"].includes(String(data.format))) throw new BookContextError("书籍格式不合法。");
  if (!["chapter", "overview", "review"].includes(String(data.mode))) throw new BookContextError("书籍学习模式不合法。");
  const mode = data.mode as BookStudyContext["mode"];
  const totalChapters = integer(data.totalChapters, "总章节", 1000);
  const totalBlocks = integer(data.totalBlocks, "总段落", 100_000);
  const chapterBlocks = integer(data.chapterBlocks, "本章段落", 100_000, mode === "overview");
  if (chapterBlocks > totalBlocks) throw new BookContextError("本章段落数不能超过全书。");
  if (!Array.isArray(data.tableOfContents) || data.tableOfContents.length !== totalChapters) throw new BookContextError("目录与总章节数不一致。");
  const tableOfContents = data.tableOfContents.map(item => string(item, "章节标题"));
  if (!Array.isArray(data.suppliedBlockIds) || !data.suppliedBlockIds.length || data.suppliedBlockIds.length > 20) throw new BookContextError("每轮需要1–20段实际原文。");
  const suppliedBlockIds = data.suppliedBlockIds.map(item => string(item, "原文段落ID", 150));
  if (new Set(suppliedBlockIds).size !== suppliedBlockIds.length || suppliedBlockIds.length > totalBlocks) throw new BookContextError("原文段落身份重复或覆盖数量不合法。");
  if (references.length !== suppliedBlockIds.length || references.reduce((sum, reference) => sum + reference.text.length, 0) > 24_000) throw new BookContextError("书籍每轮仅可提供明确选择的20段、24000字符以内原文。");
  const names = new Set<string>();
  const locations = references.map(reference => {
    const location = parseBookSourceLocation(reference.location);
    if (!location || location.bookId !== bookId || !reference.text.trim() || names.has(reference.name)) throw new BookContextError("书籍原文缺少定位、正文、同名重复或混入另一书籍。");
    names.add(reference.name);
    return location;
  });
  if (locations.some((location, index) => location.blockId !== suppliedBlockIds[index])) throw new BookContextError("原文段落列表与实际引用身份不一致。");
  const chapterId = data.chapterId === undefined ? undefined : string(data.chapterId, "chapterId", 150);
  const chapterTitle = data.chapterTitle === undefined ? undefined : string(data.chapterTitle, "chapterTitle");
  if (mode !== "overview" && (!chapterId || !chapterTitle || !tableOfContents.includes(chapterTitle) || locations.some(location => location.chapterId !== chapterId || location.chapterTitle !== chapterTitle) || suppliedBlockIds.length > chapterBlocks)) throw new BookContextError("章节学习只能使用本章的真实段落，标题与目录需一致。");
  if (typeof data.completeChapter !== "boolean" || typeof data.completeBook !== "boolean") throw new BookContextError("原文覆盖范围必须明确提供布尔值。");
  if (data.completeChapter && (mode === "overview" || suppliedBlockIds.length !== chapterBlocks)) throw new BookContextError("只有实际提供全部本章段落，才能声明完整章节。");
  if (data.completeBook && suppliedBlockIds.length !== totalBlocks) throw new BookContextError("少量片段不能声明为全书原文。");
  if (mode === "overview" && chapterBlocks !== 0) throw new BookContextError("目录导览不应伪装为某个完整章节。");
  return { bookId, title, author, format: data.format as BookStudyContext["format"], mode, ...(chapterId ? { chapterId } : {}), ...(chapterTitle ? { chapterTitle } : {}), tableOfContents, totalChapters, totalBlocks, chapterBlocks, suppliedBlockIds, completeChapter: data.completeChapter, completeBook: data.completeBook };
}

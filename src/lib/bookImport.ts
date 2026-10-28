import { Unzip, UnzipInflate } from "fflate";
import type { BookBlock, BookChapter, BookDocument, BookFormat } from "../bookTypes";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT = 2_000_000;
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const MAX_CHAPTERS = 1000;
const MAX_BLOCKS = 100_000;
const BLOCK_SIZE = 1600;
const decoder = new TextDecoder("utf-8", { fatal: true });
async function nextFrame() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

function active(signal?: AbortSignal) { signal?.throwIfAborted(); }
function shorten(value: string, warnings: string[], field: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= 300) return text;
  warnings.push(`${field}超过300字符，显示名称已缩短；原始文件未改变。`);
  return text.slice(0, 300);
}

class BookBuilder {
  chapters: BookChapter[] = [];
  blocks: BookBlock[] = [];
  warnings: string[] = [];
  characters = 0;
  chapter(title: string): BookChapter {
    if (this.chapters.length >= MAX_CHAPTERS) throw new Error("书籍章节超过1000节，请拆分文件后导入。");
    const chapter = { id: `c${this.chapters.length + 1}`, title: shorten(title, this.warnings, "章节标题") || `第${this.chapters.length + 1}节`, blockIds: [] as string[] };
    this.chapters.push(chapter);
    return chapter;
  }
  add(chapter: BookChapter, raw: string, locatorPrefix?: string, page?: number) {
    const text = raw.replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    this.characters += text.length;
    if (this.characters > MAX_TEXT) throw new Error("提取正文超过200万字符，未截断保存。请按卷或章节拆分后导入。");
    for (const paragraph of text.split(/\n\s*\n/)) {
      let remaining = paragraph.trim();
      while (remaining) {
        if (this.blocks.length >= MAX_BLOCKS) throw new Error("书籍段落超过10万块，请拆分后导入。");
        let end = Math.min(BLOCK_SIZE, remaining.length);
        if (remaining.length > BLOCK_SIZE) {
          const head = remaining.slice(0, BLOCK_SIZE);
          const boundary = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf(". "), head.lastIndexOf("\n"));
          if (boundary > BLOCK_SIZE / 2) end = boundary + 1;
          if (/^[\uD800-\uDBFF]$/.test(remaining[end - 1])) end--;
        }
        const content = remaining.slice(0, end).trim();
        remaining = remaining.slice(end).trim();
        if (!content) continue;
        const ordinal = chapter.blockIds.length + 1;
        const block: BookBlock = { id: `${chapter.id}-b${ordinal}`, chapterId: chapter.id, text: content, locator: `${locatorPrefix ?? chapter.title.slice(0, 180)} · 第${ordinal}段`, ...(page === undefined ? {} : { page }) };
        chapter.blockIds.push(block.id);
        this.blocks.push(block);
      }
    }
  }
}

function parsePlain(text: string, builder: BookBuilder, title: string, markdown: boolean) {
  if (text.includes("\u0000")) throw new Error("文件含二进制内容，不能作为UTF-8文本书籍导入。");
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let current: BookChapter | undefined;
  let buffer: string[] = [];
  const flush = () => { if (buffer.some(line => line.trim())) { current ??= builder.chapter(title); builder.add(current, buffer.join("\n")); } buffer = []; };
  for (const line of lines) {
    const heading = (markdown ? line.match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/) : null)?.[1] ?? line.match(/^\s*((?:第[零一二三四五六七八九十百千万\d]+[章节部卷篇]|Chapter\s+\d+)(?:\s.*|[：:].*)?)\s*$/i)?.[1];
    if (heading) { flush(); current = builder.chapter(heading); }
    else buffer.push(line);
  }
  flush();
  builder.chapters = builder.chapters.filter(chapter => chapter.blockIds.length);
}

function zipPath(raw: string): string {
  const decoded = decodeURIComponent(raw.split("#")[0]);
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) throw new Error("EPUB包含不安全或外部文件路径，未导入。");
  const result: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!result.length) throw new Error("EPUB文件路径越出书籍范围。"); result.pop(); }
    else if (part && part !== ".") result.push(part);
  }
  return result.join("/");
}

/** Bounded streaming extraction: even forged ZIP size headers cannot expand without a limit. */
export async function extractEpubEntries(bytes: Uint8Array, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  let files = 0;
  let failure: Error | undefined;
  const unzip = new Unzip(file => {
    if (++files > 4000) throw new Error("EPUB包含超过4000个文件，请拆分或重新导出。");
    const name = zipPath(file.name);
    if (!name || file.name.endsWith("/")) return;
    if (!/\.(?:xml|opf|xhtml|html|htm|ncx)$/i.test(name) && name !== "mimetype") return;
    if (entries.has(name)) throw new Error("EPUB存在重复文件路径，无法确定真实正文。");
    if ((file.originalSize ?? 0) > MAX_ENTRY_BYTES) throw new Error("EPUB单个正文文件过大，未导入。");
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, chunk, final) => {
      if (error) { failure = new Error("EPUB解压失败，文件可能损坏或使用了不支持的压缩方式。"); return; }
      length += chunk.length; total += chunk.length;
      if (length > MAX_ENTRY_BYTES || total > MAX_ZIP_BYTES) { failure = new Error("EPUB解压后超过安全大小上限，未保存。"); file.terminate(); return; }
      chunks.push(chunk);
      if (final) {
        const output = new Uint8Array(length);
        let offset = 0;
        for (const part of chunks) { output.set(part, offset); offset += part.length; }
        entries.set(name, output);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      active(signal);
      unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
      if (failure) throw failure;
      if (offset % 131072 === 0) await nextFrame();
    }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error("EPUB压缩包无法读取。");
  }
  if (!entries.has("META-INF/container.xml")) throw new Error("不是完整的EPUB：缺少META-INF/container.xml。");
  return entries;
}

function xml(raw: string, label: string): Document {
  if (typeof DOMParser === "undefined") throw new Error("EPUB解析需要浏览器DOM解析能力。");
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    // XHTML's ordinary doctype is safe to omit; external/internal entity declarations are not accepted.
    if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(raw)) throw new Error(`${label}包含不支持的XML实体声明。`);
    raw = raw.replace(/<!DOCTYPE[^>]*>/gi, "");
  }
  const doc = new DOMParser().parseFromString(raw, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`${label}结构损坏，无法可靠提取正文。`);
  return doc;
}
function elements(doc: Document | Element, name: string): Element[] { return Array.from(doc.getElementsByTagNameNS("*", name)); }
function entryText(entries: Map<string, Uint8Array>, name: string): string {
  const data = entries.get(name);
  if (!data) throw new Error(`EPUB缺少正文文件：${name}，未跳过或假装完整。`);
  try { return decoder.decode(data); } catch { throw new Error(`EPUB文件不是有效UTF-8：${name}`); }
}
function bodyText(element: Element): string {
  const output: string[] = [];
  const blocked: Record<string, true> = { script: true, style: true, nav: true, iframe: true, object: true, embed: true, head: true, noscript: true, svg: true };
  const block: Record<string, true> = { p: true, div: true, section: true, article: true, li: true, blockquote: true, pre: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, tr: true, br: true };
  const walk = (node: Node) => {
    if (node.nodeType === 3) { output.push(node.textContent ?? ""); return; }
    if (node.nodeType !== 1) return;
    const item = node as Element;
    const name = item.localName.toLowerCase();
    if (Object.hasOwn(blocked, name)) return;
    if (Object.hasOwn(block, name)) output.push("\n\n");
    if (name === "td" || name === "th") output.push("\t");
    for (const child of Array.from(item.childNodes)) walk(child);
    if (Object.hasOwn(block, name)) output.push("\n\n");
  };
  walk(element);
  return output.join("").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function parseEpub(bytes: Uint8Array, builder: BookBuilder, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<{ title: string; author: string }> {
  const entries = await extractEpubEntries(bytes, signal);
  const encryption = entries.get("META-INF/encryption.xml");
  if (encryption) {
    const doc = xml(decoder.decode(encryption), "EPUB加密声明");
    if (elements(doc, "CipherReference").some(item => /\.(?:xhtml|html|htm|xml|opf)$/i.test(item.getAttribute("URI") ?? ""))) throw new Error("EPUB正文已加密或受DRM保护，请使用有权读取的未加密版本。");
  }
  const container = xml(entryText(entries, "META-INF/container.xml"), "EPUB容器");
  const packagePath = zipPath(elements(container, "rootfile")[0]?.getAttribute("full-path") ?? "");
  if (!packagePath) throw new Error("EPUB容器没有有效的OPF主文件。");
  const packageDoc = xml(entryText(entries, packagePath), "EPUB目录");
  const directory = packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/") + 1) : "";
  const metadata = elements(packageDoc, "metadata")[0];
  const title = metadata ? elements(metadata, "title")[0]?.textContent?.trim() ?? "" : "";
  const author = metadata ? elements(metadata, "creator").map(item => item.textContent?.trim()).filter(Boolean).join("、") : "";
  const manifest = new Map(elements(packageDoc, "item").map(item => [item.getAttribute("id"), item]));
  const spine = elements(packageDoc, "itemref");
  if (!spine.length) throw new Error("EPUB没有可读取的spine正文顺序。");
  const seen = new Set<string>();
  for (const [index, item] of spine.entries()) {
    active(signal);
    const resource = manifest.get(item.getAttribute("idref"));
    if (!resource) throw new Error("EPUB正文顺序引用了不存在的目录项。");
    const href = resource.getAttribute("href");
    if (!href) throw new Error("EPUB正文项缺少文件路径。");
    const source = zipPath(directory + href);
    if (seen.has(source)) { builder.warnings.push(`EPUB正文顺序重复引用${source}，仅提取一次。`); continue; }
    seen.add(source);
    onProgress?.(`正在读取EPUB第 ${index + 1}/${spine.length} 节…`);
    const doc = xml(entryText(entries, source), "EPUB章节");
    const body = elements(doc, "body")[0] ?? doc.documentElement;
    const chapterTitle = elements(body, "h1")[0]?.textContent?.trim() || elements(body, "h2")[0]?.textContent?.trim() || elements(doc, "title")[0]?.textContent?.trim() || `第${index + 1}节`;
    const text = bodyText(body);
    if (!text) { builder.warnings.push(`EPUB第${index + 1}节没有可读取的正文，可能仅含图片。`); continue; }
    const chapter = builder.chapter(chapterTitle);
    builder.add(chapter, text);
    await nextFrame();
  }
  return { title, author };
}

async function parsePdf(bytes: Uint8Array, builder: BookBuilder, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<{ title: string; author: string; pages: number }> {
  // PDF.js and Vite's worker URL exist only on the browser path; pure Node parser tests must not load them.
  const pdf = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdf.getDocument({ data: bytes, useSystemFonts: true, cMapUrl: "/pdf-resources/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdf-resources/standard_fonts/", enableXfa: false, verbosity: 0 });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  let document: PDFDocumentProxy | undefined;
  try {
    active(signal);
    document = await task.promise;
    if (document.numPages > 3000) throw new Error("PDF超过3000页，请按卷拆分后导入。");
    const metadata = await document.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    const labels = await document.getPageLabels().catch(() => null);
    const outline = await document.getOutline().catch(() => null);
    const headings = new Map<number, string>();
    if (outline?.length) {
      for (const heading of outline) {
        let destination = heading.dest;
        if (typeof destination === "string") destination = await document.getDestination(destination);
        if (!Array.isArray(destination) || !destination.length) continue;
        const target = destination[0];
        let page: number;
        try { page = typeof target === "number" ? target + 1 : await document.getPageIndex(target) + 1; } catch { continue; }
        if (page >= 1 && page <= document.numPages && !headings.has(page)) headings.set(page, heading.title);
      }
    }
    let current: BookChapter | undefined;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      active(signal);
      onProgress?.(`正在读取PDF文件第 ${pageNumber}/${document.numPages} 页…`);
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is TextItem => "str" in item);
      const text = items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("").trim();
      const pageLabel = labels?.[pageNumber - 1];
      const locator = `PDF文件第${pageNumber}页${pageLabel && pageLabel !== String(pageNumber) ? `（文档页标签${pageLabel.slice(0, 50)}）` : ""}`;
      if (!text) builder.warnings.push(`PDF文件第${pageNumber}页没有文本层，未做OCR；可能含未提取的图片内容。`);
      else {
        const heading = headings.get(pageNumber);
        if (!current || heading || !headings.size) current = builder.chapter(heading || locator);
        builder.add(current, text, locator, pageNumber);
      }
      page.cleanup();
      await nextFrame();
    }
    return { title: typeof info?.Title === "string" ? info.Title : "", author: typeof info?.Author === "string" ? info.Author : "", pages: document.numPages };
  } catch (cause) {
    active(signal);
    if (cause instanceof Error && cause.name === "PasswordException") throw new Error("PDF受密码保护，请使用你有权读取的未加密版本。");
    if (cause instanceof Error && /PDF|正文|章节|页|字符/.test(cause.message)) throw cause;
    throw new Error("PDF无法读取，可能损坏或格式不受支持；原文件未保存为可读书籍。");
  } finally {
    signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}

export async function importBook(file: File, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<BookDocument> {
  active(signal);
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const format: BookFormat | undefined = extension === "markdown" ? "md" : ["pdf", "epub", "txt", "md"].includes(extension ?? "") ? extension as BookFormat : undefined;
  if (!format) throw new Error("书架支持PDF文本层、EPUB、UTF-8 TXT和Markdown文件。");
  if (!file.size) throw new Error("文件是空的，未导入。");
  if (file.size > MAX_FILE_BYTES) throw new Error("单本书籍最大30MiB，请拆分后导入。");
  onProgress?.("正在本机检查书籍文件…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  active(signal);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  const builder = new BookBuilder();
  let title = file.name.replace(/\.[^.]+$/, "").trim() || "未命名书籍";
  let author = "";
  let pageCount: number | undefined;
  if (format === "epub") {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("不是有效的EPUB压缩文件。");
    const metadata = await parseEpub(bytes, builder, onProgress, signal);
    title = metadata.title || title; author = metadata.author;
  } else if (format === "pdf") {
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw new Error("文件内容不是有效的PDF。");
    const metadata = await parsePdf(bytes, builder, onProgress, signal);
    title = metadata.title || title; author = metadata.author; pageCount = metadata.pages;
  } else {
    let text: string;
    try { text = decoder.decode(bytes); } catch { throw new Error("文本不是有效UTF-8，请转换编码后再导入。"); }
    parsePlain(text, builder, title, format === "md");
  }
  active(signal);
  if (!builder.blocks.length) throw new Error(format === "pdf" ? "PDF中没有可读取的文本层，可能是扫描件。请先在本机做OCR，再导入；不会用模型猜测原书。" : "书籍没有可读取的正文，未导入。");
  if (builder.chapters.length > MAX_CHAPTERS) throw new Error("书籍章节过多，请拆分后导入。");
  return { id: `book-${sha256.slice(0, 24)}`, title: shorten(title, builder.warnings, "书名"), author: shorten(author, builder.warnings, "作者"), format, fileName: file.name, byteLength: file.size, sha256, importedAt: Date.now(), chapters: builder.chapters, blocks: builder.blocks, warnings: builder.warnings, ...(pageCount === undefined ? {} : { pageCount }), original: file };
}

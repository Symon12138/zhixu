import crypto from "node:crypto";
import express, { Router, type Request, type RequestHandler } from "express";
import type { BookBlock, BookChapter, BookFormat, BookMetadata } from "../src/bookTypes";
import { requireAuth } from "./auth";
import {
  LibraryTombstoneLimitError,
  MAX_LIBRARY_BOOKS,
  MAX_LIBRARY_ORIGINAL_BYTES_PER_USER,
  MAX_LIBRARY_TOMBSTONES_PER_USER,
  type LibraryOriginalWriteResult,
  type ZhixuDatabase,
} from "./db";
import { HttpError } from "./http";
import { acquireConcurrencySlot } from "./quota";
import { auditRequest } from "./security";

/**
 * 账号级跨设备书架：
 * - `/api/library/books` 全部要求登录，带 X-Zhixu-User 时必须是当前会话账户；
 * - 两阶段上传：先 PUT meta（pending），再 PUT original（服务端算 sha256 并比对）；
 * - meta 成功但原文件迟迟未上传的 pending 行由定期 cleanupExpiredData 回收（默认 24h）；
 * - 原文件存 SQLite BLOB，按 user_id 隔离，随账户删除级联清理，不写文件系统；
 * - 列表只返回 ready 书，摘要由服务端从已校验 meta 派生，永不信任客户端 summary；
 * - 大请求体在鉴权/限流/并发门禁之后才解析（server/index.ts 跳过全局 JSON 解析）。
 */

export { MAX_LIBRARY_BOOKS, MAX_LIBRARY_ORIGINAL_BYTES_PER_USER };

export const MAX_BOOK_META_BYTES = 8 * 1024 * 1024;
export const MAX_BOOK_ORIGINAL_BYTES = 30 * 1024 * 1024;
export const LIBRARY_UPLOADS_PER_MINUTE = 10;
export const LIBRARY_UPLOAD_CONCURRENCY = 2;

/** 原文件下载分片：1 MiB。每次只从 SQLite 取一段，写完再取下一段。 */
export const LIBRARY_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

const MAX_CHAPTERS = 1000;
const MAX_BLOCKS = 100_000;
const MAX_TOTAL_TEXT = 2_000_000;
const MAX_BLOCK_TEXT = 100_000;
const MAX_TITLE_LENGTH = 300;
const MAX_AUTHOR_LENGTH = 300;
const MAX_FILE_NAME_LENGTH = 300;
const MAX_CHAPTER_TITLE_LENGTH = 300;
const MAX_LOCATOR_LENGTH = 1000;
const MAX_WARNINGS = 1000;
const MAX_WARNING_LENGTH = 1000;
const MAX_PAGE = 1_000_000;

/** 书籍 id 使用导入端生成的小写形式（`book-` + hex）；大写/点/斜杠一律拒绝。 */
const BOOK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** 章节/段落 id 与客户端解析器一致：字母数字开头，允许 . _ : -。 */
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** 显示字段禁止全部 C0 控制字符与 DEL；客户端 cloudBooks 的 readDisplayString 与此保持一致。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/g;

const LIBRARY_META_PATH = /^\/api\/library\/books\/[^/]+\/meta\/?$/i;
const LIBRARY_ORIGINAL_PATH = /^\/api\/library\/books\/[^/]+\/original\/?$/i;
const LIBRARY_BOOK_PATH = /^\/api\/library\/books\/[^/]+\/?$/i;
/** 用户显式重新导入同一 id 时由客户端设置；只有它能清除服务端删除墓碑。 */
const REIMPORT_HEADER = "x-zhixu-reimport";

/** index.ts 用：这两条写路径的请求体由路由在门禁之后自行解析。 */
export function isLibraryBodyRoute(req: Request): boolean {
  if (req.method.toUpperCase() !== "PUT") return false;
  return LIBRARY_META_PATH.test(req.path) || LIBRARY_ORIGINAL_PATH.test(req.path);
}

/** index.ts 用：原文件是唯一的二进制写请求，守卫只对它放宽 JSON 内容类型要求。 */
export function isLibraryOriginalUpload(req: Request): boolean {
  return req.method.toUpperCase() === "PUT" && LIBRARY_ORIGINAL_PATH.test(req.path);
}

/** index.ts 用：删除请求没有请求体，同样不要求 application/json 内容类型。 */
export function isLibraryDeleteRoute(req: Request): boolean {
  return req.method.toUpperCase() === "DELETE" && LIBRARY_BOOK_PATH.test(req.path);
}

const DOWNLOAD_TYPES: Record<BookFormat, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

/* ── metadata 严格校验 ───────────────────────────────────────────────── */

function invalidMetadata(message: string): never {
  throw new HttpError(400, `书目元数据不合法：${message}`, { code: "invalid_metadata" });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidMetadata(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalidMetadata(`${label}必须是数组。`);
  if (value.length > max) invalidMetadata(`${label}最多 ${max} 项。`);
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (key === "original") {
      invalidMetadata("不能包含原文件，请使用原文件上传接口。");
    }
    invalidMetadata(`${label}包含不允许的字段：${key.slice(0, 40)}。`);
  }
}

function displayString(
  value: unknown,
  label: string,
  max: number,
  required: boolean,
): string {
  if (typeof value !== "string") invalidMetadata(`${label}必须是文本。`);
  if (value.length > max) invalidMetadata(`${label}最多 ${max} 个字符。`);
  if (CONTROL_CHARS.test(value)) invalidMetadata(`${label}不能包含控制字符。`);
  if (required && !value.trim()) invalidMetadata(`${label}不能为空。`);
  return value;
}

function bodyText(value: unknown, label: string): string {
  if (typeof value !== "string") invalidMetadata(`${label}必须是文本。`);
  if (value.length === 0) invalidMetadata(`${label}不能为空。`);
  if (value.length > MAX_BLOCK_TEXT) {
    invalidMetadata(`${label}超过 ${MAX_BLOCK_TEXT} 个字符。`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ITEM_ID_PATTERN.test(value)) {
    invalidMetadata(`${label}只能包含字母、数字、点、下划线、冒号和连字符。`);
  }
  return value;
}

function integerIn(value: unknown, label: string, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    invalidMetadata(`${label}必须是 ${min}-${max} 之间的整数。`);
  }
  return value;
}

function bookFormat(value: unknown): BookFormat {
  if (value !== "pdf" && value !== "epub" && value !== "txt" && value !== "md") {
    invalidMetadata("format 必须是 pdf、epub、txt 或 md。");
  }
  return value;
}

interface ParsedMetadata {
  metadata: BookMetadata;
  characters: number;
  serialized: string;
  warningsJson: string;
}

/**
 * 把客户端传来的 BookMetadata 规范化为只含白名单字段的对象：
 * 拒绝未知字段、大小写/路径注入 id、非法 sha、重复 id、悬空引用与超限内容。
 */
function parseBookMetadata(value: unknown, pathId: string): ParsedMetadata {
  const raw = asRecord(value, "metadata");
  const bodyId = raw.id;
  if (bodyId !== pathId) invalidMetadata("metadata.id 必须与请求路径中的书籍 id 一致。");
  if (typeof bodyId !== "string" || !BOOK_ID_PATTERN.test(bodyId)) {
    invalidMetadata("书籍 id 只能包含小写字母、数字、连字符和下划线。");
  }
  assertOnlyKeys(
    raw,
    [
      "id", "title", "author", "format", "fileName", "byteLength", "sha256",
      "importedAt", "chapters", "blocks", "warnings", "pageCount",
      // 客户端可能把 BookSummary 的派生字段一起传来：忽略而非信任，
      // 列表摘要只由本章校验后的 meta 计算。
      "chapterCount", "blockCount", "characters", "updatedAt",
    ],
    "metadata",
  );

  const title = displayString(raw.title, "title", MAX_TITLE_LENGTH, true);
  const author = displayString(raw.author, "author", MAX_AUTHOR_LENGTH, false);
  const format = bookFormat(raw.format);
  const fileName = displayString(raw.fileName, "fileName", MAX_FILE_NAME_LENGTH, true);
  const byteLength = integerIn(raw.byteLength, "byteLength", 1, MAX_BOOK_ORIGINAL_BYTES);
  const sha256 = raw.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    invalidMetadata("sha256 必须是 64 位小写十六进制字符串。");
  }
  const importedAt = integerIn(raw.importedAt, "importedAt", 0, Number.MAX_SAFE_INTEGER);

  const chapterRecords = asArray(raw.chapters, "chapters", MAX_CHAPTERS);
  const chapters: BookChapter[] = [];
  const chapterIds = new Set<string>();
  for (const [index, entry] of chapterRecords.entries()) {
    const chapter = asRecord(entry, `chapters[${index}]`);
    assertOnlyKeys(chapter, ["id", "title", "blockIds"], `chapters[${index}]`);
    const id = identifier(chapter.id, `chapters[${index}].id`);
    if (chapterIds.has(id)) invalidMetadata(`章节 id 重复：${id.slice(0, 60)}。`);
    chapterIds.add(id);
    const chapterTitle = displayString(
      chapter.title,
      `chapters[${index}].title`,
      MAX_CHAPTER_TITLE_LENGTH,
      false,
    );
    const blockIdValues = asArray(chapter.blockIds, `chapters[${index}].blockIds`, MAX_BLOCKS);
    const blockIds = blockIdValues.map((blockId, blockIndex) =>
      identifier(blockId, `chapters[${index}].blockIds[${blockIndex}]`),
    );
    chapters.push({ id, title: chapterTitle, blockIds });
  }

  const blockRecords = asArray(raw.blocks, "blocks", MAX_BLOCKS);
  const blocks: BookBlock[] = [];
  const blocksById = new Map<string, BookBlock>();
  let characters = 0;
  for (const [index, entry] of blockRecords.entries()) {
    const block = asRecord(entry, `blocks[${index}]`);
    assertOnlyKeys(block, ["id", "chapterId", "text", "locator", "page"], `blocks[${index}]`);
    const id = identifier(block.id, `blocks[${index}].id`);
    if (blocksById.has(id)) invalidMetadata(`段落 id 重复：${id.slice(0, 60)}。`);
    const chapterId = identifier(block.chapterId, `blocks[${index}].chapterId`);
    if (!chapterIds.has(chapterId)) {
      invalidMetadata(`段落 ${id.slice(0, 60)} 引用了不存在的章节。`);
    }
    const text = bodyText(block.text, `blocks[${index}].text`);
    characters += text.length;
    if (characters > MAX_TOTAL_TEXT) {
      invalidMetadata(`正文总字符数超过 ${MAX_TOTAL_TEXT}。`);
    }
    const locator = displayString(
      block.locator,
      `blocks[${index}].locator`,
      MAX_LOCATOR_LENGTH,
      true,
    );
    const normalized: BookBlock = { id, chapterId, text, locator };
    if (block.page !== undefined) {
      normalized.page = integerIn(block.page, `blocks[${index}].page`, 1, MAX_PAGE);
    }
    blocks.push(normalized);
    blocksById.set(id, normalized);
  }

  // 章节引用与段落归属必须一一对应：不能悬挂、重复引用或遗漏段落。
  const owner = new Map<string, string>();
  for (const chapter of chapters) {
    for (const blockId of chapter.blockIds) {
      const block = blocksById.get(blockId);
      if (!block) {
        invalidMetadata(`章节 ${chapter.id.slice(0, 60)} 引用了不存在的段落。`);
      }
      if (block.chapterId !== chapter.id) {
        invalidMetadata(`段落 ${blockId.slice(0, 60)} 的章节归属与章节引用不一致。`);
      }
      if (owner.has(blockId)) {
        invalidMetadata(`段落 ${blockId.slice(0, 60)} 被多个章节引用。`);
      }
      owner.set(blockId, chapter.id);
    }
  }
  if (owner.size !== blocks.length) invalidMetadata("有段落未归入任何章节。");

  const warningValues = asArray(raw.warnings, "warnings", MAX_WARNINGS);
  const warnings = warningValues.map((warning, index) => {
    if (typeof warning !== "string") {
      invalidMetadata(`warnings[${index}]必须是文本。`);
    }
    if (warning.length > MAX_WARNING_LENGTH) {
      invalidMetadata(`warnings[${index}]最多 ${MAX_WARNING_LENGTH} 个字符。`);
    }
    return warning;
  });

  let pageCount: number | undefined;
  if (raw.pageCount !== undefined) {
    pageCount = integerIn(raw.pageCount, "pageCount", 1, MAX_PAGE);
  }

  const metadata: BookMetadata = {
    id: bodyId,
    title,
    author,
    format,
    fileName,
    byteLength,
    sha256,
    importedAt,
    chapters,
    blocks,
    warnings,
    ...(pageCount === undefined ? {} : { pageCount }),
  };
  const serialized = JSON.stringify(metadata);
  const warningsJson = JSON.stringify(warnings);
  if (typeof serialized !== "string" || typeof warningsJson !== "string") {
    invalidMetadata("无法序列化为 JSON。");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_BOOK_META_BYTES) {
    throw new HttpError(
      413,
      `书目元数据过大，最大允许 ${MAX_BOOK_META_BYTES / (1024 * 1024)} MB。`,
      { code: "meta_too_large" },
    );
  }
  return { metadata, characters, serialized, warningsJson };
}

/* ── 写入门禁 ─────────────────────────────────────────────────────────── */

const UPLOAD_WINDOW_MS = 60_000;
const uploadWindows = new Map<string, { start: number; count: number }>();

/** 与 webHits 一样定期清理过期窗口，避免不活跃用户的 ID 永久占用内存。 */
function cleanupUploadWindows(now = Date.now()): void {
  for (const [userId, entry] of uploadWindows) {
    if (now - entry.start >= UPLOAD_WINDOW_MS) uploadWindows.delete(userId);
  }
}
const uploadWindowsCleanupTimer = setInterval(cleanupUploadWindows, UPLOAD_WINDOW_MS);
uploadWindowsCleanupTimer.unref();

/** 每用户原文件上传 10 次/分钟；返回剩余秒数或放行。 */
function uploadRateLimit(userId: string, now = Date.now()): number | undefined {
  cleanupUploadWindows(now);
  const current = uploadWindows.get(userId);
  if (!current || now - current.start >= UPLOAD_WINDOW_MS) {
    uploadWindows.set(userId, { start: now, count: 1 });
    return undefined;
  }
  if (current.count >= LIBRARY_UPLOADS_PER_MINUTE) {
    return Math.max(1, Math.ceil((current.start + UPLOAD_WINDOW_MS - now) / 1000));
  }
  current.count += 1;
  return undefined;
}

/**
 * 旧标签页仍认为自己是 A，但 Cookie 已换成 B：拒绝跨账户读写。
 * 与工作区使用同一头语义（X-Zhixu-User = 客户端认为的账户 id）。
 */
function accountBinding(): RequestHandler {
  return (req, _res, next) => {
    const expected = req.headers["x-zhixu-user"];
    if (expected === undefined) {
      next();
      return;
    }
    if (typeof expected !== "string" || expected !== req.authUser?.id) {
      next(
        new HttpError(409, "登录账户已在本浏览器的其他标签页变化，请刷新后重试。", {
          code: "account_mismatch",
        }),
      );
      return;
    }
    next();
  };
}

/**
 * 在解析 8 MB/30 MB 请求体之前执行：每用户同时最多 1 个、全进程最多 2 个；
 * 原文件上传另有 10 次/分钟限制（元数据 PUT 只受并发门禁，否则首次同步
 * 100 本书的合法场景会被限流卡住）。响应结束或断开即释放，release 幂等。
 */
function libraryWriteGate(db: ZhixuDatabase, rateLimited: boolean): RequestHandler {
  return (req, res, next) => {
    const userId = req.authUser?.id;
    if (!userId) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    if (rateLimited) {
      const retry = uploadRateLimit(userId);
      if (retry !== undefined) {
        auditRequest(db, req, "library.rate_limit", "denied");
        res.setHeader("Retry-After", String(retry));
        res.status(429).json({
          error: "原文件上传过于频繁，请稍后再试。",
          code: "rate_limited",
          resetAt: Date.now() + retry * 1000,
        });
        return;
      }
    }
    const userRelease = acquireConcurrencySlot(`library:user:${userId}`, 1);
    if (!userRelease) {
      auditRequest(db, req, "library.concurrency", "denied");
      res.setHeader("Retry-After", "2");
      res.status(429).json({
        error: "上一份书架数据仍在上传，请稍后再试。",
        code: "concurrency_limit",
        resetAt: Date.now() + 2_000,
      });
      return;
    }
    const globalRelease = acquireConcurrencySlot(
      "library:global",
      LIBRARY_UPLOAD_CONCURRENCY,
    );
    if (!globalRelease) {
      userRelease();
      auditRequest(db, req, "library.concurrency", "denied", "global");
      res.setHeader("Retry-After", "2");
      res.status(429).json({
        error: "服务器正在处理其他书架上传，请稍后再试。",
        code: "concurrency_limit",
        resetAt: Date.now() + 2_000,
      });
      return;
    }
    const release = () => {
      userRelease();
      globalRelease();
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

/* ── 路由 ─────────────────────────────────────────────────────────────── */

function currentUserId(req: Request): string {
  const userId = req.authUser?.id;
  if (!userId) {
    throw new HttpError(401, "请先登录后再继续。", { code: "auth_required" });
  }
  return userId;
}

function bookIdFromPath(req: Request): string {
  const raw = req.params.id;
  if (typeof raw !== "string" || !BOOK_ID_PATTERN.test(raw)) {
    throw new HttpError(400, "书籍 id 不合法。", { code: "invalid_book_id" });
  }
  return raw;
}

function originalFailure(reason: Exclude<LibraryOriginalWriteResult, { ok: true }>["reason"]): HttpError {
  switch (reason) {
    case "missing_meta":
      return new HttpError(409, "请先上传这本书的元数据，再上传原文件。", {
        code: "meta_required",
      });
    case "sha_mismatch":
      return new HttpError(409, "原文件校验值与已保存的元数据不一致，请重新导入后再上传。", {
        code: "sha_mismatch",
      });
    case "byte_length_mismatch":
      return new HttpError(409, "原文件大小与元数据声明不一致。", {
        code: "byte_length_mismatch",
      });
    case "book_deleted":
      return new HttpError(
        409,
        "这本书已在其他设备删除。如确需恢复，请从本机重新导入该文件。",
        { code: "book_deleted" },
      );
    default:
      return new HttpError(
        409,
        `该账户云端原文件总量最多 ${MAX_LIBRARY_ORIGINAL_BYTES_PER_USER / (1024 * 1024)} MB，请先删除部分书籍。`,
        { code: "library_quota_exceeded" },
      );
  }
}

function safeContentDisposition(fileName: string, format: BookFormat): string {
  const cleaned = fileName
    .replace(CONTROL_CHARS_GLOBAL, "")
    .replace(/[\\/"]/g, "_")
    .trim();
  const fallback = cleaned || `book.${format}`;
  const ascii = fallback.replace(/[^\x20-\x7e]/g, "_").slice(0, 200) || `book.${format}`;
  const encoded = encodeURIComponent(fallback).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 下载流所需的最小接口：单测可传入受控 writable，
 * 生产路径就是 Express 的 Response（Node 的 http.ServerResponse）。
 */
export interface OriginalChunkSource {
  /** 读取 `[offset, offset + length)`；undefined 表示书已不可见。 */
  read(offset: number, length: number): Uint8Array | undefined;
}

export interface OriginalChunkSink {
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  once(event: string, listener: () => void): unknown;
}

/**
 * 分块发送：读一块 → 写一块；`write` 返回 false 时等 `drain` 再继续，
 * 不把整份文件排进内存。响应 close/error（客户端提前断开）立即停止读取，
 * 之后的 drain 回调也会因 stopped 直接退出，不再触碰 BLOB。
 */
export function streamOriginalChunks(
  source: OriginalChunkSource,
  totalBytes: number,
  sink: OriginalChunkSink,
): void {
  let offset = 0;
  let stopped = false;

  const halt = (): void => {
    stopped = true;
  };
  sink.once("close", halt);
  sink.once("error", halt);

  const pump = (): void => {
    while (!stopped) {
      const remaining = totalBytes - offset;
      if (remaining <= 0) {
        stopped = true;
        sink.end();
        return;
      }
      let chunk: Uint8Array | undefined;
      try {
        chunk = source.read(offset, Math.min(LIBRARY_DOWNLOAD_CHUNK_BYTES, remaining));
      } catch {
        // 读库失败时无法再满足 Content-Length：截断连接而不是发送半真数据。
        stopped = true;
        sink.destroy();
        return;
      }
      if (!chunk || chunk.byteLength === 0) {
        // 下载途中书被删除或重新导入（pending 视为不存在）：中止响应。
        stopped = true;
        sink.destroy();
        return;
      }
      offset += chunk.byteLength;
      let writable: boolean;
      try {
        writable = sink.write(chunk);
      } catch {
        halt();
        return;
      }
      if (!writable) {
        sink.once("drain", pump);
        return;
      }
    }
  };

  pump();
}

export function registerLibraryRoutes(router: Router, db: ZhixuDatabase): void {
  const library = Router();
  library.use(requireAuth());
  library.use(accountBinding());

  const parseMetaJson = express.json({
    limit: MAX_BOOK_META_BYTES,
    inflate: false,
  });
  const parseOriginalBytes = express.raw({
    type: "application/octet-stream",
    limit: MAX_BOOK_ORIGINAL_BYTES,
    inflate: false,
  });

  library.get("/books", (req, res) => {
    const userId = currentUserId(req);
    res.status(200).json({
      books: db.listReadyLibraryBooks(userId),
      deleted: db.listLibraryDeletions(userId),
    });
  });

  library.put(
    "/books/:id/meta",
    libraryWriteGate(db, false),
    parseMetaJson,
    (req, res) => {
      const userId = currentUserId(req);
      const id = bookIdFromPath(req);
      const reimport = req.get(REIMPORT_HEADER) === "1";
      const parsed = parseBookMetadata(req.body, id);
      const written = db.upsertLibraryMeta(userId, {
        id,
        sha256: parsed.metadata.sha256,
        meta: parsed.serialized,
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        format: parsed.metadata.format,
        fileName: parsed.metadata.fileName,
        byteLength: parsed.metadata.byteLength,
        importedAt: parsed.metadata.importedAt,
        chapterCount: parsed.metadata.chapters.length,
        blockCount: parsed.metadata.blocks.length,
        characters: parsed.characters,
        warnings: parsed.warningsJson,
        pageCount: parsed.metadata.pageCount ?? null,
      }, { reimport });
      if (!written.ok) {
        auditRequest(db, req, "library.meta", "denied", written.reason);
        if (written.reason === "book_deleted") {
          throw new HttpError(
            409,
            "这本书已在其他设备删除。如确需恢复，请从本机重新导入该文件。",
            { code: "book_deleted" },
          );
        }
        throw new HttpError(
          409,
          `书架最多保存 ${MAX_LIBRARY_BOOKS} 本书，请先删除部分书籍。`,
          { code: "book_limit_reached" },
        );
      }
      auditRequest(
        db,
        req,
        "library.meta",
        "ok",
        `bytes:${Buffer.byteLength(parsed.serialized, "utf8")};revision:${written.revision}${
          reimport ? ";reimport" : ""
        }`,
      );
      res.status(200).json({ ok: true });
    },
  );

  library.put(
    "/books/:id/original",
    libraryWriteGate(db, true),
    parseOriginalBytes,
    (req, res) => {
      const userId = currentUserId(req);
      const id = bookIdFromPath(req);
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/octet-stream")) {
        throw new HttpError(415, "原文件必须使用 application/octet-stream 上传。", {
          code: "unsupported_media_type",
        });
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) {
        throw new HttpError(400, "缺少原文件内容。", { code: "missing_original" });
      }
      if (body.byteLength === 0) {
        throw new HttpError(400, "原文件不能为空。", { code: "empty_original" });
      }
      if (body.byteLength > MAX_BOOK_ORIGINAL_BYTES) {
        throw new HttpError(
          413,
          `单本原文件最大 ${MAX_BOOK_ORIGINAL_BYTES / (1024 * 1024)} MB。`,
          { code: "original_too_large" },
        );
      }
      const sha256 = crypto.createHash("sha256").update(body).digest("hex");
      const written = db.attachLibraryOriginal(userId, id, sha256, body.byteLength, body);
      if (!written.ok) {
        auditRequest(db, req, "library.original", "denied", written.reason);
        throw originalFailure(written.reason);
      }
      auditRequest(
        db,
        req,
        "library.original",
        "ok",
        `bytes:${body.byteLength};revision:${written.revision}`,
      );
      res.status(200).json({ ok: true, sha256, byteLength: body.byteLength });
    },
  );

  library.get("/books/:id/meta", (req, res) => {
    const userId = currentUserId(req);
    const id = bookIdFromPath(req);
    const record = db.getReadyLibraryMeta(userId, id);
    if (!record) {
      throw new HttpError(404, "这本书尚未同步完成或不存在。", { code: "not_found" });
    }
    let meta: BookMetadata;
    try {
      meta = JSON.parse(record.meta) as BookMetadata;
    } catch {
      throw new HttpError(500, "云端书目数据不可用，请重新上传这本书。", {
        code: "meta_corrupted",
      });
    }
    res.status(200).json({ meta });
  });

  library.get("/books/:id/original", (req, res) => {
    const userId = currentUserId(req);
    const id = bookIdFromPath(req);
    // 只取摘要/长度，不读 BLOB；pending、已删除与不存在一律 404。
    const info = db.getReadyLibraryOriginalInfo(userId, id);
    if (!info) {
      throw new HttpError(404, "这本书尚未同步完成或不存在。", { code: "not_found" });
    }
    res.setHeader("Content-Type", DOWNLOAD_TYPES[info.format] ?? "application/octet-stream");
    res.setHeader("Content-Disposition", safeContentDisposition(info.fileName, info.format));
    res.setHeader("X-Book-SHA256", info.sha256);
    res.setHeader("Cache-Control", "no-store, private");
    // 与历史一致：Content-Length 取 BLOB 实际长度，而不是元数据声明值。
    res.setHeader("Content-Length", String(info.storedBytes));
    auditRequest(db, req, "library.download", "ok", `bytes:${info.byteLength}`);
    res.status(200);
    if (req.method.toUpperCase() === "HEAD") {
      res.end();
      return;
    }
    streamOriginalChunks(
      {
        read: (offset, length) => {
          const read = db.readReadyLibraryOriginalChunk(userId, id, offset, length);
          // 书在背压暂停期间被重新上传：绝不把两份文件的字节拼进同一响应。
          if (!read || read.sha256 !== info.sha256) return undefined;
          return read.chunk;
        },
      },
      info.storedBytes,
      res,
    );
  });

  library.delete("/books/:id", (req, res) => {
    const userId = currentUserId(req);
    const id = bookIdFromPath(req);
    let deleted: boolean;
    try {
      deleted = db.deleteLibraryBook(userId, id);
    } catch (error) {
      if (error instanceof LibraryTombstoneLimitError) {
        auditRequest(db, req, "library.delete", "denied", "tombstone_limit");
        throw new HttpError(
          409,
          `已删除书籍的记录达到上限（${MAX_LIBRARY_TOMBSTONES_PER_USER} 条），请稍后再试或联系管理员清理旧记录。`,
          { code: "tombstone_limit" },
        );
      }
      throw error;
    }
    auditRequest(db, req, "library.delete", "ok", deleted ? "deleted" : "missing");
    res.status(200).json({ ok: true });
  });

  router.use("/library", library);
}

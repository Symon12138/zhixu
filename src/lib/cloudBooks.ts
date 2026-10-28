import type {
  BookBlock,
  BookChapter,
  BookDocument,
  BookFormat,
  BookMetadata,
  BookSummary,
  CloudBookSummary,
} from "../bookTypes";
import type { Fetcher } from "./cloudSync";
import { REQUEST_HEADER } from "./cloudSync";

/**
 * 账户级书架客户端。
 *
 * - 所有请求同源携带会话 Cookie；写请求带 X-Zhixu-Request，登录态下再带
 *   X-Zhixu-User 绑定当前账户，服务端会拒绝账户不匹配的请求。
 * - 上传分两阶段：先 PUT 元数据，再 PUT 原文件；原文件只从当前
 *   BookDocument.original 取得，元数据里绝不含 Blob。
 * - 云端数据先完整校验再返回，任何坏数据都不会进入 IndexedDB。
 */

export const CLOUD_BOOKS_PATH = "/api/library/books";
export const MAX_BOOK_META_BYTES = 8 * 1024 * 1024;
export const MAX_BOOK_ORIGINAL_BYTES = 30 * 1024 * 1024;
export const MAX_BOOKS_PER_USER = 100;
/** 服务端删除墓碑没有 100 本上限；给响应解析一个明确上界，避免恶意超大数组。 */
const MAX_DELETED_BOOKS = 10_000;
export const MAX_BOOK_CHAPTERS = 1000;
export const MAX_BOOK_BLOCKS = 100_000;
export const MAX_BOOK_TEXT = 2_000_000;

const MAX_TITLE = 300;
const MAX_AUTHOR = 300;
const MAX_FILE_NAME = 300;
const MAX_CHAPTER_TITLE = 300;
const MAX_LOCATOR = 1000;
const MAX_BLOCK_TEXT = 100_000;
const MAX_WARNING = 1000;
const MAX_WARNINGS = 1000;
const MAX_ID = 128;
const MAX_PAGE = 1_000_000;
const BOOK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORMATS: Record<string, true> = { pdf: true, epub: true, txt: true, md: true };
const METADATA_KEYS: Record<string, true> = {
  id: true,
  title: true,
  author: true,
  format: true,
  fileName: true,
  byteLength: true,
  sha256: true,
  importedAt: true,
  chapters: true,
  blocks: true,
  warnings: true,
  pageCount: true,
};
const SUMMARY_KEYS: Record<string, true> = {
  ...METADATA_KEYS,
  chapterCount: true,
  blockCount: true,
  characters: true,
  updatedAt: true,
};

/** 云端书架错误；status=0 表示网络、校验或本机预检失败。 */
export class CloudBooksError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "CloudBooksError";
    this.status = status;
    this.code = code;
  }
}

export function isCloudAuthError(error: unknown): error is CloudBooksError {
  return error instanceof CloudBooksError && error.status === 401;
}

export function isCloudNotFound(error: unknown): error is CloudBooksError {
  return error instanceof CloudBooksError && error.status === 404;
}

/* ── 校验 ─────────────────────────────────────────────────────── */

function requireRecord(value: unknown, field?: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("应为对象", field);
  return value as Record<string, unknown>;
}

function invalid(message: string, field?: string): never {
  throw new CloudBooksError(
    `书籍数据无效${field ? `（${field}）` : ""}：${message}`,
    0,
    "invalid_metadata",
  );
}

function assertKeys(value: Record<string, unknown>, allowed: Record<string, true>, what: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) invalid(`${what}含未知字段 ${key.slice(0, 80)}`);
  }
}

/**
 * 显示字段（标题、作者、文件名、章节标题、定位文本）禁止全部 C0 控制字符与 DEL，
 * 包括 tab/LF/CR；与 server/library.ts 的 displayString 保持同一契约。
 * 正文 block.text 按服务端 bodyText 的规则保留换行/制表符，不使用本检查。
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function readString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") invalid("应为文本", field);
  if (!allowEmpty && !value.trim()) invalid("不能为空", field);
  if (value.length > max) invalid(`超过${max}字符`, field);
  return value;
}

function readDisplayString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") invalid("应为文本", field);
  if (value.length > max) invalid(`超过${max}字符`, field);
  if (CONTROL_CHARS.test(value)) invalid("含控制字符（包括制表符、换行与回车）", field);
  if (!allowEmpty && !value.trim()) invalid("不能为空", field);
  return value;
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`应为${min}–${max}之间的整数`, field);
  }
  return value;
}

function readArray(value: unknown, field: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value)) invalid("应为数组", field);
  if (value.length < min || value.length > max) invalid(`数量应在${min}–${max}之间`, field);
  return value;
}

function readBookId(value: unknown, field: string): string {
  const id = readString(value, field, MAX_ID);
  if (!BOOK_ID_PATTERN.test(id)) invalid("格式不正确", field);
  return id;
}

function readId(value: unknown, field: string): string {
  const id = readString(value, field, MAX_ID);
  if (!ITEM_ID_PATTERN.test(id)) invalid("格式不正确", field);
  return id;
}

function readFormat(value: unknown, field: string): BookFormat {
  if (typeof value !== "string" || !Object.hasOwn(FORMATS, value)) {
    invalid("只支持 pdf、epub、txt 或 md", field);
  }
  return value as BookFormat;
}

function readSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid("应为64位小写十六进制 SHA-256", field);
  }
  return value;
}

function readWarnings(value: unknown): string[] {
  const raw = readArray(value, "warnings", MAX_WARNINGS);
  return raw.map((item, index) => readString(item, `warnings[${index}]`, MAX_WARNING, true));
}

/**
 * 严格校验并重建 BookMetadata（不使用服务端对象原样引用）。
 * expectedId 用于断言路径里的 id 与正文一致。
 */
export function parseBookMetadata(value: unknown, expectedId?: string): BookMetadata {
  const record = requireRecord(value);
  if ("original" in record) invalid("元数据不得包含原文件", "original");
  assertKeys(record, METADATA_KEYS, "元数据");
  const id = readBookId(record.id, "id");
  if (expectedId !== undefined && id !== expectedId) invalid("与请求路径的 id 不一致", "id");
  const title = readDisplayString(record.title, "title", MAX_TITLE);
  const author = readDisplayString(record.author, "author", MAX_AUTHOR, true);
  const format = readFormat(record.format, "format");
  const fileName = readDisplayString(record.fileName, "fileName", MAX_FILE_NAME);
  const byteLength = readInteger(record.byteLength, "byteLength", 1, MAX_BOOK_ORIGINAL_BYTES);
  const sha256 = readSha256(record.sha256, "sha256");
  const importedAt = readInteger(record.importedAt, "importedAt", 0, Number.MAX_SAFE_INTEGER);
  const pageCount = record.pageCount === undefined ? undefined : readInteger(record.pageCount, "pageCount", 1, MAX_PAGE);

  const rawBlocks = readArray(record.blocks, "blocks", MAX_BOOK_BLOCKS, 1);
  const blocks: BookBlock[] = [];
  const blockById = new Map<string, BookBlock>();
  let textLength = 0;
  for (let index = 0; index < rawBlocks.length; index++) {
    const rawBlock = requireRecord(rawBlocks[index], `blocks[${index}]`);
    const blockId = readId(rawBlock.id, `blocks[${index}].id`);
    if (blockById.has(blockId)) invalid("段落 id 重复", `blocks[${index}].id`);
    const chapterId = readId(rawBlock.chapterId, `blocks[${index}].chapterId`);
    const text = readString(rawBlock.text, `blocks[${index}].text`, MAX_BLOCK_TEXT);
    textLength += text.length;
    if (textLength > MAX_BOOK_TEXT) invalid(`正文超过${MAX_BOOK_TEXT}字符`, "blocks");
    const locator = readDisplayString(rawBlock.locator, `blocks[${index}].locator`, MAX_LOCATOR);
    const page = rawBlock.page === undefined ? undefined : readInteger(rawBlock.page, `blocks[${index}].page`, 1, MAX_PAGE);
    const block: BookBlock = {
      id: blockId,
      chapterId,
      text,
      locator,
      ...(page === undefined ? {} : { page }),
    };
    blocks.push(block);
    blockById.set(blockId, block);
  }

  const rawChapters = readArray(record.chapters, "chapters", MAX_BOOK_CHAPTERS, 1);
  const chapters: BookChapter[] = [];
  const chapterIds = new Set<string>();
  const referencedBlocks = new Set<string>();
  for (let index = 0; index < rawChapters.length; index++) {
    const rawChapter = requireRecord(rawChapters[index], `chapters[${index}]`);
    const chapterId = readId(rawChapter.id, `chapters[${index}].id`);
    if (chapterIds.has(chapterId)) invalid("章节 id 重复", `chapters[${index}].id`);
    chapterIds.add(chapterId);
    const chapterTitle = readDisplayString(rawChapter.title, `chapters[${index}].title`, MAX_CHAPTER_TITLE, true);
    const rawBlockIds = readArray(rawChapter.blockIds, `chapters[${index}].blockIds`, MAX_BOOK_BLOCKS);
    const blockIds: string[] = [];
    for (let blockIndex = 0; blockIndex < rawBlockIds.length; blockIndex++) {
      const blockId = readId(rawBlockIds[blockIndex], `chapters[${index}].blockIds[${blockIndex}]`);
      const block = blockById.get(blockId);
      if (!block) invalid("引用了不存在的段落", `chapters[${index}].blockIds[${blockIndex}]`);
      if (block.chapterId !== chapterId) invalid("段落所属章节与引用不一致", `chapters[${index}].blockIds[${blockIndex}]`);
      if (referencedBlocks.has(blockId)) invalid("同一段落被重复引用", `chapters[${index}].blockIds[${blockIndex}]`);
      referencedBlocks.add(blockId);
      blockIds.push(blockId);
    }
    chapters.push({ id: chapterId, title: chapterTitle, blockIds });
  }
  if (referencedBlocks.size !== blocks.length) invalid("存在未被章节引用的段落", "blocks");

  const warnings = readWarnings(record.warnings);

  return {
    id,
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
}

/** 把当前书籍转换为可上传元数据；显式挑选字段，绝不携带 original。 */
export function toBookMetadata(book: BookDocument): BookMetadata {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    fileName: book.fileName,
    byteLength: book.byteLength,
    sha256: book.sha256,
    importedAt: book.importedAt,
    chapters: book.chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      blockIds: [...chapter.blockIds],
    })),
    blocks: book.blocks.map(block => ({
      id: block.id,
      chapterId: block.chapterId,
      text: block.text,
      locator: block.locator,
      ...(block.page === undefined ? {} : { page: block.page }),
    })),
    warnings: [...book.warnings],
    ...(book.pageCount === undefined ? {} : { pageCount: book.pageCount }),
  };
}

/** 校验云端书目摘要；摘要只用于展示，永不写入 IndexedDB。 */
export function parseCloudBookSummary(value: unknown, expectedId?: string): CloudBookSummary {
  const record = requireRecord(value, "书目摘要");
  assertKeys(record, SUMMARY_KEYS, "书目摘要");
  const id = readBookId(record.id, "id");
  if (expectedId !== undefined && id !== expectedId) invalid("与请求路径的 id 不一致", "id");
  const title = readDisplayString(record.title, "title", MAX_TITLE);
  const author = readDisplayString(record.author, "author", MAX_AUTHOR, true);
  const format = readFormat(record.format, "format");
  const fileName = readDisplayString(record.fileName, "fileName", MAX_FILE_NAME);
  const byteLength = readInteger(record.byteLength, "byteLength", 1, MAX_BOOK_ORIGINAL_BYTES);
  const importedAt = readInteger(record.importedAt, "importedAt", 0, Number.MAX_SAFE_INTEGER);
  const chapterCount = readInteger(record.chapterCount, "chapterCount", 0, MAX_BOOK_CHAPTERS);
  const blockCount = readInteger(record.blockCount, "blockCount", 0, MAX_BOOK_BLOCKS);
  const characters = readInteger(record.characters, "characters", 0, MAX_BOOK_TEXT);
  const warnings = readWarnings(record.warnings);
  const pageCount = record.pageCount === undefined ? undefined : readInteger(record.pageCount, "pageCount", 1, MAX_PAGE);
  const updatedAt = readInteger(record.updatedAt, "updatedAt", 0, Number.MAX_SAFE_INTEGER);
  return {
    id,
    title,
    author,
    format,
    fileName,
    byteLength,
    importedAt,
    chapterCount,
    blockCount,
    characters,
    warnings,
    ...(pageCount === undefined ? {} : { pageCount }),
    updatedAt,
  };
}

/** 云端书架列表：ready 摘要 + 服务端删除墓碑 id（已删除书籍跨设备不可复活）。 */
export interface CloudBookList {
  books: CloudBookSummary[];
  deleted: string[];
}

export function parseCloudBookList(value: unknown): CloudBookList {
  const record = requireRecord(value, "书架响应");
  const rawBooks = readArray(record.books, "books", MAX_BOOKS_PER_USER);
  const seen = new Set<string>();
  const books = rawBooks.map((raw, index) => {
    const book = parseCloudBookSummary(raw);
    if (seen.has(book.id)) invalid("书目 id 重复", `books[${index}].id`);
    seen.add(book.id);
    return book;
  });
  const deleted: string[] = [];
  if (record.deleted !== undefined) {
    const rawDeleted = readArray(record.deleted, "deleted", MAX_DELETED_BOOKS);
    const deletedSeen = new Set<string>();
    for (let index = 0; index < rawDeleted.length; index += 1) {
      const id = readBookId(rawDeleted[index], `deleted[${index}]`);
      if (deletedSeen.has(id)) invalid("已删除书籍 id 重复", `deleted[${index}]`);
      if (seen.has(id)) invalid("同一书籍不能同时存在和已删除", `deleted[${index}]`);
      deletedSeen.add(id);
      deleted.push(id);
    }
  }
  return { books, deleted };
}

interface OriginalUploadResult {
  sha256: string;
  byteLength: number;
}

function parseOriginalUploadResponse(value: unknown): OriginalUploadResult {
  const record = requireRecord(value, "原文件上传响应");
  if (record.ok !== true) invalid("原文件上传响应不完整");
  const sha256 = readSha256(record.sha256, "sha256");
  const byteLength = readInteger(record.byteLength, "byteLength", 1, MAX_BOOK_ORIGINAL_BYTES);
  return { sha256, byteLength };
}

function parseOkResponse(value: unknown): void {
  if (requireRecord(value, "服务端响应").ok !== true) invalid("服务端未确认成功");
}

/**
 * 本地与云端书目合并：同一 id 以本地（已下载/已打开）为准，云端独有的补上。
 * `deleted` 是服务端删除墓碑 id：即使本机仍残留缓存也绝不展示，避免已删书籍复活。
 * 返回按导入时间倒序，绝不把两条同 id 记录同时放进书架。
 */
export function mergeBookSummaries(
  local: readonly BookSummary[],
  cloud: readonly CloudBookSummary[],
  deleted: readonly string[] = [],
): BookSummary[] {
  const excluded = new Set(deleted);
  const seen = new Set<string>();
  const merged: BookSummary[] = [];
  for (const book of local) {
    if (excluded.has(book.id) || seen.has(book.id)) continue;
    seen.add(book.id);
    merged.push(book);
  }
  for (const book of cloud) {
    if (excluded.has(book.id) || seen.has(book.id)) continue;
    seen.add(book.id);
    merged.push(book);
  }
  return merged.sort((left, right) => right.importedAt - left.importedAt);
}

/** 删除顺序：云端成功（或 404 已不存在）后才删本地；其它错误保留本地。 */
export async function deleteBookWithCloud(
  cloudDelete: (() => Promise<void>) | null,
  localDelete: () => Promise<void>,
): Promise<void> {
  if (cloudDelete) {
    try {
      await cloudDelete();
    } catch (error) {
      if (!isCloudNotFound(error)) throw error;
    }
  }
  await localDelete();
}

export interface BookUploadAttempt {
  upload: () => Promise<unknown>;
  onUploaded?: () => Promise<void> | void;
  onFailed?: (error: unknown) => void;
}

/**
 * 单次后台上传：失败只回报，不向调用方抛错，因此本地导入/阅读永远不会被云端故障拖垮。
 * 成功后清理待传标记；清理失败只意味着下次会幂等重传。
 */
export async function attemptBookUpload(attempt: BookUploadAttempt): Promise<boolean> {
  try {
    await attempt.upload();
  } catch (error) {
    try {
      attempt.onFailed?.(error);
    } catch {
      /* 失败处理本身不得影响本地书架。 */
    }
    return false;
  }
  try {
    await attempt.onUploaded?.();
  } catch {
    /* 上传已成功；标记清理失败会在下次重试时幂等覆盖。 */
  }
  return true;
}

export interface CloudBookRequestOptions {
  expectedUserId?: string;
  signal?: AbortSignal;
}

function bookPath(id: string, suffix = ""): string {
  return `${CLOUD_BOOKS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

async function readError(response: Response, fallback: string): Promise<CloudBooksError> {
  let message = "";
  let code: string | undefined;
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) message = record.error.trim().slice(0, 500);
    if (typeof record.code === "string" && record.code) code = record.code.slice(0, 100);
  }
  if (!message) {
    if (response.status === 401) message = "登录状态已失效，请重新登录。";
    else if (response.status === 403) message = "当前账户无权访问这份云端书架数据。";
    else if (response.status === 404) message = "云端书架中没有这本书。";
    else if (response.status === 409) message = "云端书籍数据与服务器不一致，请稍后重试。";
    else if (response.status === 413) message = "书籍或元数据超过云端大小限制。";
    else if (response.status === 429) message = "操作太频繁，请稍后再试。";
    else message = fallback;
  }
  return new CloudBooksError(message, response.status, code);
}

interface RequestInitOptions {
  method?: string;
  body?: BodyInit;
  contentType?: string;
  accept?: string;
  expectedUserId?: string;
  signal?: AbortSignal;
  /** 用户显式重新导入同一 id，允许服务端清除删除墓碑。 */
  reimport?: boolean;
}

async function request(
  fetcher: Fetcher,
  path: string,
  options: RequestInitOptions,
  fallback: string,
): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers();
  headers.set("Accept", options.accept ?? "application/json");
  if (options.contentType) headers.set("Content-Type", options.contentType);
  if (method !== "GET" && method !== "HEAD") headers.set(REQUEST_HEADER, "1");
  if (options.reimport) headers.set("X-Zhixu-Reimport", "1");
  if (options.expectedUserId) headers.set("X-Zhixu-User", options.expectedUserId);
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    if (cause instanceof CloudBooksError) throw cause;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new CloudBooksError(
      cause instanceof Error ? `网络连接失败：${cause.message}` : "网络连接失败，请稍后重试。",
      0,
      "network",
    );
  }
  if (!response.ok) throw await readError(response, fallback);
  return response;
}

async function readJson(response: Response, what: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CloudBooksError(`云端${what}返回了无法识别的数据。`, response.status, "invalid_response");
  }
}

function encodeMetaBody(meta: BookMetadata): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(meta));
  if (body.byteLength > MAX_BOOK_META_BYTES) {
    throw new CloudBooksError(`书籍元数据超过${MAX_BOOK_META_BYTES / 1024 / 1024}MiB，未上传。`, 0, "metadata_too_large");
  }
  return body;
}

function assertOriginal(meta: BookMetadata, original: Blob): void {
  if (!(original instanceof Blob)) {
    throw new CloudBooksError("原文件缺失，未上传。", 0, "invalid_original");
  }
  if (!original.size) throw new CloudBooksError("原文件是空的，未上传。", 0, "invalid_original");
  if (original.size > MAX_BOOK_ORIGINAL_BYTES) {
    throw new CloudBooksError(`单本书籍原文件最大${MAX_BOOK_ORIGINAL_BYTES / 1024 / 1024}MiB，未上传。`, 0, "original_too_large");
  }
  if (original.size !== meta.byteLength) {
    throw new CloudBooksError("原文件大小与书籍元数据不一致，未上传。", 0, "original_size_mismatch");
  }
}

/** 元数据写入选项；`reimport` 仅由用户显式重新导入设置。 */
export interface CloudBookMetaWriteOptions extends CloudBookRequestOptions {
  reimport?: boolean;
}

async function sendMeta(
  fetcher: Fetcher,
  meta: BookMetadata,
  body: Uint8Array,
  options: CloudBookMetaWriteOptions,
): Promise<void> {
  const response = await request(
    fetcher,
    bookPath(meta.id, "/meta"),
    {
      method: "PUT",
      body,
      contentType: "application/json",
      expectedUserId: options.expectedUserId,
      signal: options.signal,
      reimport: options.reimport === true,
    },
    "云端书籍信息保存失败，请稍后重试。",
  );
  parseOkResponse(await readJson(response, "元数据保存"));
}

async function sendOriginal(
  fetcher: Fetcher,
  meta: BookMetadata,
  original: Blob,
  options: CloudBookRequestOptions,
): Promise<OriginalUploadResult> {
  const response = await request(
    fetcher,
    bookPath(meta.id, "/original"),
    {
      method: "PUT",
      body: original,
      contentType: "application/octet-stream",
      expectedUserId: options.expectedUserId,
      signal: options.signal,
    },
    "原文件上传失败，请稍后重试。",
  );
  const result = parseOriginalUploadResponse(await readJson(response, "原文件上传"));
  if (result.sha256 !== meta.sha256 || result.byteLength !== original.size) {
    throw new CloudBooksError(
      "云端返回的原文件摘要与本地书籍不一致，已停止同步。",
      0,
      "sha256_mismatch",
    );
  }
  return result;
}

/** 只保存（创建或更新）pending 元数据；原文件随后单独上传。 */
export async function putCloudBookMeta(
  fetcher: Fetcher,
  meta: BookMetadata,
  options: CloudBookMetaWriteOptions = {},
): Promise<void> {
  const parsed = parseBookMetadata(meta);
  const body = encodeMetaBody(parsed);
  await sendMeta(fetcher, parsed, body, options);
}

/** 上传原文件；byteLength 与 sha256 必须和已保存的元数据一致。 */
export async function putCloudBookOriginal(
  fetcher: Fetcher,
  meta: BookMetadata,
  original: Blob,
  options: CloudBookRequestOptions = {},
): Promise<OriginalUploadResult> {
  const parsed = parseBookMetadata(meta);
  assertOriginal(parsed, original);
  return sendOriginal(fetcher, parsed, original, options);
}

export type BookUploadStage = "meta" | "original";

export interface UploadCloudBookInput extends CloudBookRequestOptions {
  meta: BookMetadata;
  /** 必须来自当前 BookDocument.original；元数据中不含 Blob。 */
  original: Blob;
  /**
   * 用户显式重新导入同一 id：meta 阶段带 X-Zhixu-Reimport，服务端据此清除删除墓碑。
   * 旧设备的后台补传绝不能设置它，否则会把已删除的书复活。
   */
  reimport?: boolean;
  /**
   * 每个网络阶段发出前的检查；抛出错误会立即中止，后续阶段绝不会再发请求。
   * 删除书籍后用它阻止在途上传把已删除的书重新写回云端。
   */
  beforeStage?: (stage: BookUploadStage) => Promise<void> | void;
}

/**
 * 两阶段上传：先完整做本地预检，再 PUT meta，成功后才 PUT original。
 * meta 失败时不会发送原文件；original 的大小/摘要问题也不会先污染元数据。
 * beforeStage 在每次网络写入前执行，用于在删除后中止剩余阶段。
 */
export async function uploadCloudBook(
  fetcher: Fetcher,
  input: UploadCloudBookInput,
): Promise<OriginalUploadResult> {
  const meta = parseBookMetadata(input.meta);
  const body = encodeMetaBody(meta);
  assertOriginal(meta, input.original);
  const options: CloudBookMetaWriteOptions = {
    ...(input.expectedUserId === undefined ? {} : { expectedUserId: input.expectedUserId }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.reimport === true ? { reimport: true } : {}),
  };
  await input.beforeStage?.("meta");
  await sendMeta(fetcher, meta, body, options);
  await input.beforeStage?.("original");
  return sendOriginal(fetcher, meta, input.original, options);
}

export async function listCloudBooks(
  fetcher: Fetcher,
  options: CloudBookRequestOptions = {},
): Promise<CloudBookList> {
  const response = await request(
    fetcher,
    CLOUD_BOOKS_PATH,
    {
      expectedUserId: options.expectedUserId,
      signal: options.signal,
    },
    "无法读取云端书架，请稍后重试。",
  );
  return parseCloudBookList(await readJson(response, "书架"));
}

export async function getCloudBookMeta(
  fetcher: Fetcher,
  id: string,
  options: CloudBookRequestOptions = {},
): Promise<BookMetadata> {
  const bookId = readBookId(id, "书籍 id");
  const response = await request(
    fetcher,
    bookPath(bookId, "/meta"),
    {
      expectedUserId: options.expectedUserId,
      signal: options.signal,
    },
    "无法读取云端书籍信息，请稍后重试。",
  );
  const payload = requireRecord(await readJson(response, "书籍信息"), "书籍信息");
  if (!("meta" in payload)) invalid("缺少 meta");
  return parseBookMetadata(payload.meta, bookId);
}

async function readLimitedBody(response: Response, limit: number): Promise<Blob> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) {
      throw new CloudBooksError("云端原文件超过声明大小，已拒绝保存。", 0, "sha256_mismatch");
    }
    return new Blob([buffer], { type: "application/octet-stream" });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new CloudBooksError("云端原文件超过声明大小，已拒绝保存。", 0, "sha256_mismatch");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CloudBooksError) throw error;
    throw new CloudBooksError(
      error instanceof Error ? `下载原文件时连接中断：${error.message}` : "下载原文件时连接中断，请稍后重试。",
      0,
      "network",
    );
  }
  return new Blob(chunks, { type: "application/octet-stream" });
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CloudBooksError("当前浏览器无法校验原文件摘要，已停止保存。", 0, "crypto_unavailable");
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 下载并校验原文件：字节数必须等于 meta.byteLength，SHA-256 必须等于 meta.sha256
 * （若服务端带 X-Book-SHA256，也必须一致）。校验通过前绝不返回可缓存的 Blob。
 */
export async function downloadCloudBookOriginal(
  fetcher: Fetcher,
  meta: BookMetadata,
  options: CloudBookRequestOptions = {},
): Promise<{ blob: Blob; sha256: string }> {
  const parsed = parseBookMetadata(meta);
  const response = await request(
    fetcher,
    bookPath(parsed.id, "/original"),
    {
      accept: "application/octet-stream",
      expectedUserId: options.expectedUserId,
      signal: options.signal,
    },
    "无法下载云端原文件，请稍后重试。",
  );
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const trimmed = declared.trim();
    if (!/^\d+$/.test(trimmed) || Number(trimmed) !== parsed.byteLength) {
      throw new CloudBooksError("云端原文件大小与书籍信息不一致，已拒绝保存。", 0, "sha256_mismatch");
    }
  }
  const blob = await readLimitedBody(response, parsed.byteLength);
  if (blob.size !== parsed.byteLength) {
    throw new CloudBooksError("云端原文件大小与书籍信息不一致，已拒绝保存。", 0, "sha256_mismatch");
  }
  const headerSha = response.headers.get("X-Book-SHA256");
  if (headerSha !== null) {
    const normalized = headerSha.trim().toLowerCase();
    if (!SHA256_PATTERN.test(normalized) || normalized !== parsed.sha256) {
      throw new CloudBooksError("云端原文件摘要与书籍信息不一致，已拒绝保存。", 0, "sha256_mismatch");
    }
  }
  const actual = await sha256Hex(await blob.arrayBuffer());
  if (actual !== parsed.sha256) {
    throw new CloudBooksError("原文件 SHA-256 校验失败，未保存到本机书架。", 0, "sha256_mismatch");
  }
  return { blob, sha256: actual };
}

/** DELETE 幂等：404 视为已经删除。 */
export async function deleteCloudBook(
  fetcher: Fetcher,
  id: string,
  options: CloudBookRequestOptions = {},
): Promise<void> {
  const bookId = readBookId(id, "书籍 id");
  try {
    const response = await request(
      fetcher,
      bookPath(bookId),
      {
        method: "DELETE",
        expectedUserId: options.expectedUserId,
        signal: options.signal,
      },
      "云端书籍删除失败，请稍后重试。",
    );
    parseOkResponse(await readJson(response, "书籍删除"));
  } catch (error) {
    if (isCloudNotFound(error)) return;
    throw error;
  }
}

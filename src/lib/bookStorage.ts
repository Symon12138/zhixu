import type { BookBlock, BookDocument, BookProgress, BookSummary } from "../bookTypes";
import {
  CloudBooksError,
  attemptBookUpload,
  deleteBookWithCloud,
  deleteCloudBook,
  downloadCloudBookOriginal,
  getCloudBookMeta,
  isCloudAuthError,
  listCloudBooks,
  mergeBookSummaries,
  toBookMetadata,
  uploadCloudBook,
} from "./cloudBooks";
import type { Fetcher } from "./cloudSync";

const ANONYMOUS_DB_NAME = "zhixu-books";
const BOOKS = "books";
const PROGRESS = "progress";
const PENDING = "pending";
const SUMMARIES = "summaries";
const DB_VERSION = 3;

/** 本机摘要对应的云端同步状态；仅用于书架展示，不参与云端校验。 */
export type LocalBookCloudState = "local" | "pending" | "ready";

/**
 * 本机书架摘要：只含列表页需要的字段与迁移用的 sha256。
 * 绝不包含 chapters/blocks/original，listLocalBooks 因此不会反序列化正文。
 * 字段与 BookSummary 对齐，可直接交给 mergeBookSummaries 与云端摘要合并。
 */
export interface LocalBookSummary extends BookSummary {
  sha256: string;
  updatedAt: number;
  cloudState: LocalBookCloudState;
}

const dbConnections = new Map<string, Promise<IDBDatabase>>();
let activeDbName = ANONYMOUS_DB_NAME;
let activeUserId: string | null = null;
let ownerEpoch = 0;
let cloudDisabled = false;
const ownerListeners = new Set<(userId: string | null) => void>();
const cloudFetcher: Fetcher = (input, init) => fetch(input, init);

interface OwnerSnapshot {
  userId: string;
  epoch: number;
}

interface MigrationTarget extends OwnerSnapshot {
  dbName: string;
}

export type BookMigrationStatus = "idle" | "running" | "completed" | "blocked" | "failed" | "cancelled";

/** 匿名书架迁移到账户书架的状态；blocked/failed 时可通过 retryBookMigration() 重试。 */
export interface BookMigrationState {
  status: BookMigrationStatus;
  userId: string | null;
  migratedBooks: number;
  migratedProgress: number;
  error?: string;
  canRetry: boolean;
}

let migrationGeneration = 0;
let migrationAttemptEpoch: number | null = null;
let migrationPromise: Promise<void> | null = null;
let migrationTarget: MigrationTarget | null = null;
let migrationState: BookMigrationState = {
  status: "idle",
  userId: null,
  migratedBooks: 0,
  migratedProgress: 0,
  canRetry: false,
};

const MIGRATION_LEDGER_PREFIX = "zhixu-book-migration:v1:";
const MIGRATION_LEDGER_VERSION = 1;

/** 仅记录已迁移的匿名书 id（内容哈希前缀），不含书名、作者或正文。 */
export interface BookMigrationLedger {
  version: typeof MIGRATION_LEDGER_VERSION;
  bookIds: string[];
}

/** 账户隔离的台账键；不同 userId 绝不共用记录。 */
export function bookMigrationLedgerKey(userId: string): string {
  return `${MIGRATION_LEDGER_PREFIX}${userId}`;
}

/** 校验台账 JSON；损坏、版本不符或非字符串 id 一律视为空台账。 */
export function parseBookMigrationLedger(raw: string | null): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.version !== MIGRATION_LEDGER_VERSION) return [];
  const rawIds = record.bookIds;
  if (!Array.isArray(rawIds)) return [];
  const ids = rawIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128,
  );
  return [...new Set(ids)];
}

/** 合并台账：保留已有 id、去重，序列化后只有 version 与 bookIds，不含书籍内容或密钥。 */
export function mergeBookMigrationLedger(raw: string | null, ids: readonly string[]): string {
  const merged = new Set(parseBookMigrationLedger(raw));
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && id.length <= 128) merged.add(id);
  }
  const ledger: BookMigrationLedger = {
    version: MIGRATION_LEDGER_VERSION,
    bookIds: [...merged],
  };
  return JSON.stringify(ledger);
}

function readMigratedBookIds(userId: string): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return parseBookMigrationLedger(localStorage.getItem(bookMigrationLedgerKey(userId)));
  } catch {
    return [];
  }
}

/** 成功提交到账户库后才追加；台账写入失败不回滚已完成的本地迁移。 */
function appendMigratedBookIds(userId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  try {
    if (typeof localStorage === "undefined") return;
    const current = localStorage.getItem(bookMigrationLedgerKey(userId));
    localStorage.setItem(bookMigrationLedgerKey(userId), mergeBookMigrationLedger(current, ids));
  } catch {
    /* 台账不可用只意味着下次可能幂等重扫，不影响本地书籍。 */
  }
}

/**
 * 清空指定账户（默认当前账户）的迁移台账。
 * 账户删除时调用；退出/切换账户不清，因为台账按 userId 隔离且仅含书籍 id。
 */
export function clearBookMigrationLedger(userId: string | null = activeUserId): void {
  if (!userId) return;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(bookMigrationLedgerKey(userId));
  } catch {
    /* 清理失败不影响账户删除本身。 */
  }
}

/* ── 书籍删除标记（按账户 + bookId） ───────────────────────────── */

const DELETION_MARKER_PREFIX = "zhixu-book-deleted:v1:";
const DELETION_MARKER_VERSION = 1;
const MAX_DELETION_MARKERS = 500;

/**
 * 本机删除标记的有效期。它只覆盖“本机删除与在途上传交错”的窗口：
 * 删除开始即写入，上传在每个网络阶段前读取；同一 id 重新导入或账户书架清空时立即移除。
 * 跨设备删除由服务端墓碑（library_deletions）长期负责，不依赖这里的过期时间。
 */
export const BOOK_DELETION_MARKER_TTL_MS = 60 * 60 * 1000;

export interface BookDeletionMarker {
  id: string;
  at: number;
}

const deletionMarkerMemory = new Map<string, BookDeletionMarker[]>();
const deletionMarkerStorageFailed = new Set<string>();

/** 账户隔离的删除标记键；只含书籍 id 与时间，不含书名、正文或原文件。 */
export function bookDeletionKey(userId: string): string {
  return `${DELETION_MARKER_PREFIX}${userId}`;
}

/** 校验删除标记 JSON；损坏、版本不符或非字符串 id 一律视为空。 */
export function parseBookDeletionMarkers(raw: string | null): BookDeletionMarker[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const rawBooks = record.books;
  if (record.version !== DELETION_MARKER_VERSION || !Array.isArray(rawBooks)) return [];
  const latest = new Map<string, number>();
  for (const item of rawBooks) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const marker = item as Record<string, unknown>;
    const id = marker.id;
    const at = marker.at;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) continue;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) continue;
    latest.set(id, Math.max(latest.get(id) ?? 0, at));
  }
  return [...latest].map(([id, at]) => ({ id, at }));
}

function readDeletionMarkers(userId: string): BookDeletionMarker[] {
  if (!deletionMarkerStorageFailed.has(userId)) {
    try {
      if (typeof localStorage !== "undefined") {
        return parseBookDeletionMarkers(localStorage.getItem(bookDeletionKey(userId)));
      }
    } catch {
      deletionMarkerStorageFailed.add(userId);
    }
  }
  return [...(deletionMarkerMemory.get(userId) ?? [])];
}

function writeDeletionMarkers(userId: string, markers: BookDeletionMarker[]): void {
  const bounded = [...markers].sort((left, right) => right.at - left.at).slice(0, MAX_DELETION_MARKERS);
  if (bounded.length) deletionMarkerMemory.set(userId, bounded);
  else deletionMarkerMemory.delete(userId);
  try {
    if (typeof localStorage === "undefined") return;
    if (!bounded.length) localStorage.removeItem(bookDeletionKey(userId));
    else {
      localStorage.setItem(
        bookDeletionKey(userId),
        JSON.stringify({ version: DELETION_MARKER_VERSION, books: bounded }),
      );
    }
    deletionMarkerStorageFailed.delete(userId);
  } catch {
    /* localStorage 不可用时本页内存标记仍能阻止上传。 */
    deletionMarkerStorageFailed.add(userId);
  }
}

/** 删除开始即写入；同账户的上传任务在每个网络阶段前读取它。 */
export function markBookDeleted(userId: string, bookId: string, now = Date.now()): void {
  if (!userId || !bookId) return;
  const markers = readDeletionMarkers(userId).filter(
    marker => marker.id !== bookId && now - marker.at < BOOK_DELETION_MARKER_TTL_MS,
  );
  markers.unshift({ id: bookId, at: now });
  writeDeletionMarkers(userId, markers);
}

/** 删除未完成（网络/鉴权失败）或用户重新导入同一本书时撤销标记。 */
export function unmarkBookDeleted(userId: string, bookId: string): void {
  if (!userId || !bookId) return;
  const markers = readDeletionMarkers(userId);
  const kept = markers.filter(marker => marker.id !== bookId);
  if (kept.length === markers.length) return;
  writeDeletionMarkers(userId, kept);
}

export function isBookDeleted(userId: string, bookId: string, now = Date.now()): boolean {
  return readDeletionMarkers(userId).some(
    marker => marker.id === bookId && now - marker.at < BOOK_DELETION_MARKER_TTL_MS,
  );
}

/** 清除账户的删除标记；账户删除时调用。退出/切换账户不清，删除窗口内重登仍会尊重删除决定。 */
export function clearBookDeletionMarkers(userId: string | null = activeUserId): void {
  if (!userId) return;
  deletionMarkerMemory.delete(userId);
  deletionMarkerStorageFailed.delete(userId);
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(bookDeletionKey(userId));
  } catch {
    /* 清理失败不影响账户删除本身。 */
  }
}

/** 过滤云端书目中仍处于删除窗口内的书，避免已删书籍从云端重新出现在书架。 */
export function withoutDeletedBooks<T extends BookSummary>(
  books: readonly T[],
  userId: string,
  now = Date.now(),
): T[] {
  if (!books.length) return [];
  const deleted = new Set(
    readDeletionMarkers(userId)
      .filter(marker => now - marker.at < BOOK_DELETION_MARKER_TTL_MS)
      .map(marker => marker.id),
  );
  return deleted.size ? books.filter(book => !deleted.has(book.id)) : [...books];
}

export interface TombstonePurgeOptions {
  /** 已预读的待传标记；缺省时从本机 pending 存储读取。测试可注入。 */
  reimportingIds?: readonly string[];
  /** 删除本机书目/进度/待传标记；缺省使用 IndexedDB。测试可注入。 */
  removeLocal?: (id: string) => Promise<void>;
}

export interface TombstonePurgeResult {
  /** 已清理本机缓存的 id。 */
  removed: string[];
  /** 用户已显式重新导入、等待清除服务端墓碑的 id。 */
  reimporting: string[];
}

/** 显式重新导入后的保护窗口：上传已清墓碑，但旧的列表响应可能仍在路上。 */
const RECENT_REIMPORT_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_REIMPORTS = 1000;
const recentReimports = new Map<string, number>();

function rememberRecentReimport(userId: string, bookId: string, now = Date.now()): void {
  recentReimports.set(`${userId}\u0000${bookId}`, now);
  if (recentReimports.size <= MAX_RECENT_REIMPORTS) return;
  for (const [key, at] of recentReimports) {
    if (now - at >= RECENT_REIMPORT_TTL_MS) recentReimports.delete(key);
  }
}

function forgetRecentReimportsForUser(userId: string): void {
  const prefix = `${userId}\u0000`;
  for (const key of recentReimports.keys()) {
    if (key.startsWith(prefix)) recentReimports.delete(key);
  }
}

/**
 * 应用服务端删除墓碑：清掉本机书目、阅读进度与待传标记，并取消尚未开始的上传。
 * 另一台设备因此不能凭本地缓存重新显示或重新上传已删除的书。
 * 用户已在本机显式重新导入（pending.reimport 或刚完成的导入）的 id 必须保留，
 * 等待带 X-Zhixu-Reimport 的上传清除服务端墓碑，而不是把这次导入一并删掉。
 */
export async function purgeTombstonedBooks(
  userId: string,
  deletedIds: readonly string[],
  options: TombstonePurgeOptions = {},
): Promise<TombstonePurgeResult> {
  if (!deletedIds.length) return { removed: [], reimporting: [] };
  // removeLocal 在本函数内逐个 await；期间切换账户会让后续删除落到新账户库。
  // 开始前捕获 owner，每次删除前复核，切换后立即停止，避免删错账户的书。
  const owner = { userId: activeUserId, epoch: ownerEpoch, dbName: activeDbName };
  const now = Date.now();
  const reimporting = new Set<string>(options.reimportingIds);
  if (options.reimportingIds === undefined) {
    try {
      for (const record of await listPendingUploads()) {
        if (record.reimport) reimporting.add(record.id);
      }
    } catch {
      // 读不到 pending 时按“无重新导入意图”处理：云端墓碑优先，宁可不展示。
    }
  }
  // 列表响应可能早于上传成功产生、晚于 pending 清除到达；保护窗口避免误删刚导入的书。
  const ownerPrefix = `${userId}\u0000`;
  for (const [key, at] of recentReimports) {
    if (now - at >= RECENT_REIMPORT_TTL_MS) {
      recentReimports.delete(key);
      continue;
    }
    if (key.startsWith(ownerPrefix)) reimporting.add(key.slice(ownerPrefix.length));
  }
  const removeLocal = options.removeLocal ?? deleteLocalBook;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const id of new Set(deletedIds)) {
    // removeLocal 默认删除当前 activeDbName 的库；owner 变了就必须停手。
    if (
      activeUserId !== owner.userId
      || ownerEpoch !== owner.epoch
      || activeDbName !== owner.dbName
    ) break;
    if (!id) continue;
    unmarkBookDeleted(userId, id);
    if (reimporting.has(id)) {
      kept.push(id);
      continue;
    }
    cancelQueuedBookUpload(userId, id);
    try {
      await removeLocal(id);
    } catch {
      /* 本机清理失败时，合并阶段仍会按墓碑隐藏该书，不会重新显示。 */
    }
    removed.push(id);
  }
  return { removed, reimporting: kept };
}

class BookDatabaseBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookDatabaseBlockedError";
  }
}

const migrationListeners = new Set<(state: BookMigrationState) => void>();

function publishMigrationState(state: BookMigrationState): void {
  migrationState = state;
  for (const listener of [...migrationListeners]) {
    try {
      listener({ ...state });
    } catch {
      /* 单个订阅失败不能影响迁移。 */
    }
  }
}

/** 订阅迁移状态；BookLibrary 用它在 blocked/failed 时显示重试入口。 */
export function onBookMigrationChange(listener: (state: BookMigrationState) => void): () => void {
  migrationListeners.add(listener);
  return () => {
    migrationListeners.delete(listener);
  };
}

function notifyBookOwners(userId: string | null): void {
  for (const listener of [...ownerListeners]) {
    try {
      listener(userId);
    } catch {
      /* 单个界面订阅失败不能影响账号切换或迁移。 */
    }
  }
}

/**
 * 书架按账号选择独立 IndexedDB。
 * - 未登录/本地模式使用匿名库，兼容原有书籍；
 * - 登录后使用 `zhixu-books-u-<userId>`，不同账号看不到彼此的书与阅读进度；
 * - 切换账号只切换活动库，不删除原账号书籍，返回该账号时仍可读取。
 * - 同时绑定云端书架账户；账号切换后 BookLibrary 会收到通知并重载。
 */
export function setBookOwner(userId: string | null): void {
  const previousDbName = activeDbName;
  const next = userId ? `zhixu-books-u-${userId}` : ANONYMOUS_DB_NAME;
  const changed = next !== activeDbName;
  const wasDisabled = cloudDisabled;
  activeDbName = next;
  activeUserId = userId;
  cloudDisabled = false;
  if (!changed && !wasDisabled) return;
  let target: MigrationTarget | null = null;
  if (changed) {
    ownerEpoch += 1;
    migrationGeneration += 1;
    migrationAttemptEpoch = null;
    migrationPromise = null;
    publishMigrationState({
      status: "idle",
      userId,
      migratedBooks: 0,
      migratedProgress: 0,
      canRetry: false,
    });
    // 只把匿名库迁移到合法账户库；A 账户切到 B 账户时绝不搬运书籍。
    if (previousDbName === ANONYMOUS_DB_NAME && userId) {
      target = { userId, epoch: ownerEpoch, dbName: next };
    }
    migrationTarget = target;
  }
  notifyBookOwners(userId);
  if (target) void startBookMigration(target, false);
}

/** 当前账号/本地库的版本；异步导入在保存前对比，避免切换账号后写入新账户库。 */
export function getBookOwnerEpoch(): number {
  return ownerEpoch;
}

/** 订阅账号/本地库切换；返回取消订阅函数。 */
export function onBookOwnerChange(listener: (userId: string | null) => void): () => void {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

/** 当前是否具备云端书架能力（已登录且会话未明确失效）。 */
export function isCloudShelfEnabled(): boolean {
  return activeUserId !== null && !cloudDisabled;
}

function currentOwner(): OwnerSnapshot | null {
  return activeUserId ? { userId: activeUserId, epoch: ownerEpoch } : null;
}

function cloudOwner(): OwnerSnapshot | null {
  const owner = currentOwner();
  return owner && !cloudDisabled ? owner : null;
}

function isCurrent(snapshot: OwnerSnapshot): boolean {
  return activeUserId === snapshot.userId && ownerEpoch === snapshot.epoch;
}



/** 删除当前账号书架（账户删除时调用）；其他账号的库不受影响。 */
export function clearBookLibrary(): Promise<void> {
  // 账户删除时让仍在进行的匿名→账户迁移立即失效，避免清理后又被写回。
  migrationGeneration += 1;
  migrationTarget = null;
  migrationAttemptEpoch = null;
  migrationPromise = null;
  publishMigrationState({
    status: "idle",
    userId: activeUserId,
    migratedBooks: 0,
    migratedProgress: 0,
    canRetry: false,
  });
  if (activeUserId) {
    clearBookMigrationLedger(activeUserId);
    clearBookDeletionMarkers(activeUserId);
    forgetRecentReimportsForUser(activeUserId);
    cancelOwnerBookUploads(activeUserId);
    const prefix = `${activeUserId}\u0000`;
    for (const key of [...syncOverrides.keys()]) {
      if (key.startsWith(prefix)) syncOverrides.delete(key);
    }
  }
  return transaction([BOOKS, PROGRESS, PENDING, SUMMARIES], "readwrite", (tx, setResult) => {
    tx.objectStore(BOOKS).clear();
    tx.objectStore(PROGRESS).clear();
    tx.objectStore(PENDING).clear();
    tx.objectStore(SUMMARIES).clear();
    setResult(undefined);
  });
}

function storageError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : "";
  return new Error(name === "QuotaExceededError" ? "本机书架存储空间不足，书籍尚未保存。请备份原书并清理空间后重试。" : `无法访问本机书架。请允许浏览器保存网站数据，避免无痕模式限制。${error instanceof Error ? `（${error.message}）` : ""}`);
}

function countBookCharacters(blocks: readonly BookBlock[]): number {
  let total = 0;
  for (const block of blocks) total += block.text.length;
  return total;
}

/**
 * 从完整书籍生成可长期保存的摘要；characters 在这里（导入保存时）统计一次，
 * 书架列表不再遍历 blocks。
 */
function summaryFromDocument(
  book: BookDocument,
  cloudState: LocalBookCloudState,
  characters = countBookCharacters(book.blocks),
  now = Date.now(),
): LocalBookSummary {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    fileName: book.fileName,
    byteLength: book.byteLength,
    importedAt: book.importedAt,
    chapterCount: book.chapters.length,
    blockCount: book.blocks.length,
    characters,
    warnings: [...book.warnings],
    ...(book.pageCount === undefined ? {} : { pageCount: book.pageCount }),
    sha256: book.sha256,
    updatedAt: now,
    cloudState,
  };
}

function isBookFormat(value: unknown): value is BookDocument["format"] {
  return value === "pdf" || value === "epub" || value === "txt" || value === "md";
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 宽容读取摘要 store；损坏或旧格式记录跳过，不影响其它书显示。 */
function readLocalBookSummary(value: unknown): LocalBookSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const title = record.title;
  const author = record.author;
  const fileName = record.fileName;
  const byteLength = readNonNegativeInteger(record.byteLength);
  const importedAt = readNonNegativeInteger(record.importedAt);
  const chapterCount = readNonNegativeInteger(record.chapterCount);
  const blockCount = readNonNegativeInteger(record.blockCount);
  const characters = readNonNegativeInteger(record.characters);
  const pageCount = record.pageCount === undefined ? undefined : readNonNegativeInteger(record.pageCount);
  if (
    typeof id !== "string" || !id
    || typeof title !== "string"
    || typeof author !== "string"
    || typeof fileName !== "string"
    || !isBookFormat(record.format)
    || byteLength === undefined
    || importedAt === undefined
    || chapterCount === undefined
    || blockCount === undefined
    || characters === undefined
    || (record.pageCount !== undefined && (pageCount === undefined || pageCount === 0))
  ) {
    return undefined;
  }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const sha256 = record.sha256;
  if (typeof sha256 !== "string" || !sha256) return undefined;
  const updatedAt = readNonNegativeInteger(record.updatedAt) ?? importedAt;
  const cloudState: LocalBookCloudState = record.cloudState === "pending" || record.cloudState === "ready"
    ? record.cloudState
    : "local";
  return {
    id,
    title,
    author,
    format: record.format,
    fileName,
    byteLength,
    importedAt,
    chapterCount,
    blockCount,
    characters,
    warnings,
    ...(pageCount === undefined ? {} : { pageCount }),
    sha256,
    updatedAt,
    cloudState,
  };
}

/** 列表 API 只需要 BookSummary 字段，不向调用方泄露内部摘要字段。 */
function toBookSummary(summary: LocalBookSummary): BookSummary {
  return {
    id: summary.id,
    title: summary.title,
    author: summary.author,
    format: summary.format,
    fileName: summary.fileName,
    byteLength: summary.byteLength,
    importedAt: summary.importedAt,
    chapterCount: summary.chapterCount,
    blockCount: summary.blockCount,
    characters: summary.characters,
    warnings: [...summary.warnings],
    ...(summary.pageCount === undefined ? {} : { pageCount: summary.pageCount }),
  };
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  const existing = dbConnections.get(dbName);
  if (existing) return existing;
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const tracked = promise.catch(error => { dbConnections.delete(dbName); throw error; });
  dbConnections.set(dbName, tracked);
  if (typeof indexedDB === "undefined") { reject(storageError("IndexedDB unavailable")); return tracked; }
  let request: IDBOpenDBRequest;
  try { request = indexedDB.open(dbName, DB_VERSION); } catch (error) { reject(storageError(error)); return tracked; }
  let blocked = false;
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: "id" });
    if (!db.objectStoreNames.contains(PROGRESS)) db.createObjectStore(PROGRESS, { keyPath: "bookId" });
    if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: "id" });
    if (!db.objectStoreNames.contains(SUMMARIES)) {
      const summaries = db.createObjectStore(SUMMARIES, { keyPath: "id" });
      // 从旧版本升级时一次性回填摘要；之后列表只读 summaries，不再触碰正文。
      const upgrade = request.transaction;
      if (upgrade) {
        const cursor = upgrade.objectStore(BOOKS).openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          try {
            summaries.put(summaryFromDocument(current.value as BookDocument, "local"));
          } catch {
            /* 损坏的旧书记录跳过，不阻塞整个书架升级。 */
          }
          current.continue();
        };
      }
    }
  };
  request.onblocked = () => {
    blocked = true;
    reject(new BookDatabaseBlockedError("书架升级被另一个页面阻止，请关闭其他知序标签页后重试。"));
  };
  request.onerror = () => reject(storageError(request.error));
  request.onsuccess = () => {
    const db = request.result;
    if (blocked) { db.close(); return; }
    // 已经发起的操作必须完成/失败，不能因随后切换 owner 而让 Promise 永久悬空。
    // 连接按数据库名复用；owner 切换不影响已开始的匿名/账户迁移。
    db.onversionchange = () => { db.close(); dbConnections.delete(dbName); };
    resolve(db);
  };
  return tracked;
}
async function transactionOn<T>(dbName: string, stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, setResult: (result: T) => void) => void): Promise<T> {
  const db = await openDatabase(dbName);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let tx: IDBTransaction;
  try {
    tx = db.transaction(stores, mode);
  } catch (error) {
    dbConnections.delete(dbName);
    throw storageError(error);
  }
  let result: T;
  tx.oncomplete = () => resolve(result!);
  tx.onerror = () => reject(storageError(tx.error));
  tx.onabort = () => reject(storageError(tx.error));
  try { operation(tx, value => { result = value; }); }
  catch (error) { tx.abort(); reject(storageError(error)); }
  return promise;
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, setResult: (result: T) => void) => void): Promise<T> {
  // 同步捕获当前数据库名：切换 owner 后，已经开始的调用仍落在原库。
  return transactionOn(activeDbName, stores, mode, operation);
}

/** 只读本机书架；不发网络请求。导入前判重可避免无谓的云端下载。 */
export function getLocalBook(id: string): Promise<BookDocument | undefined> {
  return transaction([BOOKS], "readonly", (tx, setResult) => {
    const request = tx.objectStore(BOOKS).get(id);
    request.onsuccess = () => setResult(request.result as BookDocument | undefined);
  });
}

/** 只检查书籍键是否存在，不读取原文件 Blob；上传阶段检查因此保持轻量。 */
function hasLocalBook(id: string): Promise<boolean> {
  return transaction<boolean>([BOOKS], "readonly", (tx, setResult) => {
    const request = tx.objectStore(BOOKS).getKey(id);
    request.onsuccess = () => setResult(request.result !== undefined);
  });
}

/** 书架列表只读取 summaries store；正文 blocks 与 original Blob 完全不会反序列化。 */
export function listLocalBooks(): Promise<BookSummary[]> {
  return transaction([SUMMARIES], "readonly", (tx, setResult) => {
    const result: BookSummary[] = [];
    setResult(result);
    const request = tx.objectStore(SUMMARIES).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { result.sort((a, b) => b.importedAt - a.importedAt); return; }
      const summary = readLocalBookSummary(cursor.value);
      if (summary) result.push(toBookSummary(summary));
      cursor.continue();
    };
  });
}

/** 只写本机书籍，不触发上传（用于云端原文件的本地缓存）。 */
function writeLocalBook(book: BookDocument): Promise<void> {
  return transaction([BOOKS, SUMMARIES], "readwrite", (tx, setResult) => {
    const store = tx.objectStore(BOOKS);
    const summaries = tx.objectStore(SUMMARIES);
    const request = store.get(book.id);
    request.onsuccess = () => {
      const stored = request.result as BookDocument | undefined;
      if (stored) {
        if (stored.sha256 !== book.sha256) { tx.abort(); return; }
      } else store.add(book);
      summaries.put(summaryFromDocument(stored ?? book, "ready"));
      setResult(undefined);
    };
  });
}

function deleteLocalBook(id: string): Promise<void> {
  return transaction([BOOKS, PROGRESS, PENDING, SUMMARIES], "readwrite", (tx, setResult) => {
    tx.objectStore(BOOKS).delete(id);
    tx.objectStore(PROGRESS).delete(id);
    tx.objectStore(PENDING).delete(id);
    tx.objectStore(SUMMARIES).delete(id);
    setResult(undefined);
  });
}

/** 上传成功后只更新摘要里的展示状态；失败不影响上传本身。 */
async function markSummaryCloudState(id: string, cloudState: LocalBookCloudState): Promise<void> {
  try {
    await transaction([SUMMARIES], "readwrite", (tx, setResult) => {
      const store = tx.objectStore(SUMMARIES);
      const request = store.get(id);
      request.onsuccess = () => {
        const summary = readLocalBookSummary(request.result);
        if (summary) store.put({ ...summary, cloudState, updatedAt: Date.now() });
        setResult(undefined);
      };
    });
  } catch {
    /* 摘要状态只是展示信息，写入失败不改变书籍与上传结果。 */
  }
}

interface PendingUploadRecord {
  id: string;
  /** 用户显式重新导入留下的待传标记：重试时必须继续带 X-Zhixu-Reimport。 */
  reimport?: true;
}

function listPendingUploads(): Promise<PendingUploadRecord[]> {
  return transaction([PENDING], "readonly", (tx, setResult) => {
    const request = tx.objectStore(PENDING).getAll();
    request.onsuccess = () => {
      const records: PendingUploadRecord[] = [];
      for (const value of request.result as unknown[]) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        if (typeof record.id !== "string" || !record.id) continue;
        records.push(record.reimport === true ? { id: record.id, reimport: true } : { id: record.id });
      }
      setResult(records);
    };
  });
}

function clearPendingMarker(id: string): Promise<void> {
  return transaction([PENDING], "readwrite", (tx, setResult) => {
    tx.objectStore(PENDING).delete(id);
    setResult(undefined);
  });
}

/* ── 匿名书架首次登录迁移 ─────────────────────────────────────── */

export interface BookMigrationPlan {
  books: BookDocument[];
  progress: BookProgress[];
  skippedBooks: string[];
  skippedProgress: string[];
}

export interface BookMigrationSource {
  /** 已加载的完整书籍；summary 路径先为空，选中候选后再按需装载。 */
  books: BookDocument[];
  progress: BookProgress[];
  /** 小体积摘要清单；提供时迁移计划只依赖摘要，不读取全部正文。 */
  summaries?: readonly LocalBookSummary[];
  /** 按 id 读取完整书籍；只应由迁移计划选中的候选调用。 */
  readBooks?: (ids: readonly string[]) => Promise<BookDocument[]>;
}

export interface BookMigrationDestination {
  bookShas: Record<string, string>;
  progressIds: string[];
}

export interface BookMigrationWriteResult {
  books: BookDocument[];
  progress: number;
  cancelled: boolean;
}

export interface BookMigrationSink {
  /** 必须在 isCurrent() 仍为真时写入；新增书同时写 PENDING。 */
  write: (
    plan: BookMigrationPlan,
    source: BookMigrationSource,
    isCurrent: () => boolean,
  ) => Promise<BookMigrationWriteResult>;
  enqueue: (book: BookDocument) => void;
  notify: () => void;
  /** 事务成功提交后追加台账；即使随后 owner 切换，也应记录到原账户。 */
  recordMigrated?: (books: readonly BookDocument[]) => void;
}

export interface BookMigrationRunResult {
  status: "completed" | "cancelled";
  migratedBooks: number;
  migratedProgress: number;
}

export interface RunBookMigrationInput {
  isCurrent: () => boolean;
  readSource: () => Promise<BookMigrationSource>;
  readDestination: () => Promise<BookMigrationDestination>;
  sink: BookMigrationSink;
  /** 该账户已经迁移过的匿名书 id；计划阶段直接排除，避免删书后又被补回。 */
  migratedBookIds?: readonly string[];
}

function progressFitsBook(progress: BookProgress, book: BookDocument): boolean {
  return book.chapters.some(chapter => chapter.id === progress.chapterId)
    && (!progress.blockId || book.blocks.some(block => block.id === progress.blockId && block.chapterId === progress.chapterId))
    && progress.readChapterIds.every(id => book.chapters.some(chapter => chapter.id === id));
}

/**
 * 纯合并计划：只补账户库缺失的书；同 id 已存在时绝不覆盖（无论 sha 是否相同）。
 * 进度只在该书已存在/将被补入、且账户本没有进度、引用仍有效时补入。
 */
export function planBookMigration(
  sourceBooks: readonly BookDocument[],
  sourceProgress: readonly BookProgress[],
  destinationBookShas: Readonly<Record<string, string>>,
  destinationProgressIds: readonly string[],
  migratedBookIds: readonly string[] = [],
): BookMigrationPlan {
  const destinationProgress = new Set(destinationProgressIds);
  const alreadyMigrated = new Set(migratedBookIds);
  const sourceById = new Map<string, BookDocument>();
  for (const book of sourceBooks) {
    if (!sourceById.has(book.id)) sourceById.set(book.id, book);
  }
  const plannedBooks = new Set<string>();
  const books: BookDocument[] = [];
  const skippedBooks: string[] = [];
  for (const book of sourceBooks) {
    const exists = Object.hasOwn(destinationBookShas, book.id);
    if (alreadyMigrated.has(book.id) || exists || plannedBooks.has(book.id)) {
      skippedBooks.push(book.id);
      continue;
    }
    plannedBooks.add(book.id);
    books.push(book);
  }
  const plannedProgress = new Set<string>();
  const progress: BookProgress[] = [];
  const skippedProgress: string[] = [];
  for (const item of sourceProgress) {
    const book = sourceById.get(item.bookId);
    const existingSha = Object.hasOwn(destinationBookShas, item.bookId)
      ? destinationBookShas[item.bookId]
      : undefined;
    const bookWillExist = plannedBooks.has(item.bookId)
      || (book !== undefined && existingSha === book.sha256);
    if (
      alreadyMigrated.has(item.bookId)
      || destinationProgress.has(item.bookId)
      || plannedProgress.has(item.bookId)
      || !book
      || !bookWillExist
      || !progressFitsBook(item, book)
    ) {
      skippedProgress.push(item.bookId);
      continue;
    }
    plannedProgress.add(item.bookId);
    progress.push(item);
  }
  return { books, progress, skippedBooks, skippedProgress };
}

/**
 * 摘要驱动迁移：每次只按 id 读一本正文并立即写入，内存峰值是一本书而不是整个书架。
 * 目标库已有同 sha 且无需补进度的书完全不读正文。
 */
async function runSummaryBookMigration(
  input: RunBookMigrationInput,
  source: BookMigrationSource & {
    summaries: readonly LocalBookSummary[];
    readBooks: (ids: readonly string[]) => Promise<BookDocument[]>;
  },
  destination: BookMigrationDestination,
  cancelled: () => BookMigrationRunResult,
): Promise<BookMigrationRunResult> {
  const migratedBookIds = input.migratedBookIds ?? [];
  const migrated = new Set(migratedBookIds);
  const progressByBook = new Map<string, BookProgress[]>();
  for (const item of source.progress) {
    const existing = progressByBook.get(item.bookId);
    if (existing) existing.push(item);
    else progressByBook.set(item.bookId, [item]);
  }
  let migratedBooks = 0;
  let migratedProgress = 0;
  for (const summary of source.summaries) {
    if (!input.isCurrent()) return cancelled();
    if (migrated.has(summary.id)) continue;
    const destinationSha = Object.hasOwn(destination.bookShas, summary.id)
      ? destination.bookShas[summary.id]
      : undefined;
    const progress = progressByBook.get(summary.id) ?? [];
    if (destinationSha !== undefined && (destinationSha !== summary.sha256 || progress.length === 0)) continue;
    const [book] = await source.readBooks([summary.id]);
    if (!input.isCurrent()) return cancelled();
    if (!book) continue;
    const plan = planBookMigration([book], progress, destination.bookShas, destination.progressIds, migratedBookIds);
    const written = await input.sink.write(plan, { ...source, books: [book] }, input.isCurrent);
    if (written.cancelled) return cancelled();
    migratedProgress += written.progress;
    if (!written.books.length) continue;
    migratedBooks += written.books.length;
    try {
      input.sink.recordMigrated?.(written.books);
    } catch {
      /* 台账写入失败不回滚已提交的本地迁移。 */
    }
    for (const writtenBook of written.books) {
      try {
        input.sink.enqueue(writtenBook);
      } catch {
        /* PENDING 已在写入事务中保存；触发上传失败不会回滚本地迁移。 */
      }
    }
  }
  if (migratedBooks || migratedProgress) {
    try {
      input.sink.notify();
    } catch {
      /* 通知失败不影响本地数据；下一次 owner 切换或手动刷新仍可看到书籍。 */
    }
  }
  return { status: "completed", migratedBooks, migratedProgress };
}

/**
 * 可注入的迁移流程：任一阶段前后都检查 owner epoch；切换账号后既不写入也不通知。
 * sink.write 必须在自己的事务内再次检查 isCurrent，以便中途切换时回滚。
 */
export async function runBookMigration(input: RunBookMigrationInput): Promise<BookMigrationRunResult> {
  const cancelled = (): BookMigrationRunResult => ({
    status: "cancelled",
    migratedBooks: 0,
    migratedProgress: 0,
  });
  if (!input.isCurrent()) return cancelled();
  const source = await input.readSource();
  if (!input.isCurrent()) return cancelled();
  const destination = await input.readDestination();
  if (!input.isCurrent()) return cancelled();
  if (source.summaries && source.readBooks) {
    return runSummaryBookMigration(input, { ...source, summaries: source.summaries, readBooks: source.readBooks }, destination, cancelled);
  }
  const plan = planBookMigration(
    source.books,
    source.progress,
    destination.bookShas,
    destination.progressIds,
    input.migratedBookIds ?? [],
  );
  if (!input.isCurrent()) return cancelled();
  const written = await input.sink.write(plan, source, input.isCurrent);
  if (!written.cancelled && written.books.length) {
    try {
      input.sink.recordMigrated?.(written.books);
    } catch {
      /* 台账写入失败不回滚已提交的本地迁移。 */
    }
  }
  if (written.cancelled || !input.isCurrent()) return cancelled();
  for (const book of written.books) {
    try {
      input.sink.enqueue(book);
    } catch {
      /* PENDING 已在写入事务中保存；触发上传失败不会回滚本地迁移。 */
    }
  }
  if (written.books.length || written.progress) {
    try {
      input.sink.notify();
    } catch {
      /* 通知失败不影响本地数据；下一次 owner 切换或手动刷新仍可看到书籍。 */
    }
  }
  return {
    status: "completed",
    migratedBooks: written.books.length,
    migratedProgress: written.progress,
  };
}

function readAnonymousBooks(ids: readonly string[]): Promise<BookDocument[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return Promise.resolve([]);
  return transactionOn(ANONYMOUS_DB_NAME, [BOOKS], "readonly", (tx, setResult) => {
    const byId = new Map<string, BookDocument>();
    let remaining = unique.length;
    for (const id of unique) {
      const request = tx.objectStore(BOOKS).get(id);
      request.onsuccess = () => {
        if (request.result) byId.set(id, request.result as BookDocument);
        remaining -= 1;
        if (remaining === 0) {
          const books: BookDocument[] = [];
          for (const key of unique) {
            const book = byId.get(key);
            if (book) books.push(book);
          }
          setResult(books);
        }
      };
    }
  });
}

function readMigrationSource(): Promise<BookMigrationSource> {
  return transactionOn(ANONYMOUS_DB_NAME, [SUMMARIES, PROGRESS], "readonly", (tx, setResult) => {
    let summaries: LocalBookSummary[] | undefined;
    let progress: BookProgress[] | undefined;
    const publish = () => {
      if (!summaries || !progress) return;
      setResult({ books: [], progress, summaries, readBooks: readAnonymousBooks });
    };
    const summaryRequest = tx.objectStore(SUMMARIES).getAll();
    summaryRequest.onsuccess = () => {
      summaries = [];
      for (const value of summaryRequest.result as unknown[]) {
        const summary = readLocalBookSummary(value);
        if (summary) summaries.push(summary);
      }
      publish();
    };
    const progressRequest = tx.objectStore(PROGRESS).getAll();
    progressRequest.onsuccess = () => { progress = progressRequest.result as BookProgress[]; publish(); };
  });
}

function readMigrationDestination(dbName: string): Promise<BookMigrationDestination> {
  return transactionOn(dbName, [SUMMARIES, PROGRESS], "readonly", (tx, setResult) => {
    const bookShas = Object.create(null) as Record<string, string>;
    let progressIds: string[] | undefined;
    let booksDone = false;
    const publish = () => {
      if (booksDone && progressIds) setResult({ bookShas, progressIds });
    };
    const cursor = tx.objectStore(SUMMARIES).openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { booksDone = true; publish(); return; }
      const summary = readLocalBookSummary(current.value);
      if (summary) bookShas[summary.id] = summary.sha256;
      current.continue();
    };
    const keys = tx.objectStore(PROGRESS).getAllKeys();
    keys.onsuccess = () => {
      progressIds = (keys.result as IDBValidKey[]).filter((key): key is string => typeof key === "string");
      publish();
    };
  });
}

function applyBookMigration(
  dbName: string,
  plan: BookMigrationPlan,
  source: BookMigrationSource,
  isCurrent: () => boolean,
): Promise<BookMigrationWriteResult> {
  return new Promise((resolve, reject) => {
    openDatabase(dbName).then(db => {
      if (!isCurrent()) {
        resolve({ books: [], progress: 0, cancelled: true });
        return;
      }
      let tx: IDBTransaction;
      try {
        tx = db.transaction([BOOKS, PROGRESS, PENDING, SUMMARIES], "readwrite");
      } catch (error) {
        dbConnections.delete(dbName);
        reject(storageError(error));
        return;
      }
      let settled = false;
      let cancelled = false;
      const added: BookDocument[] = [];
      let addedProgress = 0;
      const abort = () => {
        cancelled = true;
        try { tx.abort(); } catch { /* 事务可能已结束。 */ }
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve({ books: added, progress: addedProgress, cancelled: false });
      };
      tx.onerror = () => {
        if (settled) return;
        settled = true;
        reject(storageError(tx.error));
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        if (cancelled) resolve({ books: [], progress: 0, cancelled: true });
        else reject(storageError(tx.error));
      };
      const bookStore = tx.objectStore(BOOKS);
      const progressStore = tx.objectStore(PROGRESS);
      const pendingStore = tx.objectStore(PENDING);
      const summaryStore = tx.objectStore(SUMMARIES);
      const sourceShas = new Map(source.books.map(book => [book.id, book.sha256]));
      const sourceCharacters = new Map((source.summaries ?? []).map(summary => [summary.id, summary.characters]));
      const writeProgress = (index: number) => {
        if (settled) return;
        if (!isCurrent()) { abort(); return; }
        if (index >= plan.progress.length) return;
        const item = plan.progress[index];
        const bookRequest = bookStore.get(item.bookId);
        bookRequest.onsuccess = () => {
          const book = bookRequest.result as BookDocument | undefined;
          if (!book || book.sha256 !== sourceShas.get(item.bookId)) {
            writeProgress(index + 1);
            return;
          }
          const progressRequest = progressStore.get(item.bookId);
          progressRequest.onsuccess = () => {
            if (!progressRequest.result) {
              progressStore.add(item);
              addedProgress += 1;
            }
            writeProgress(index + 1);
          };
        };
      };
      const writeBooks = (index: number) => {
        if (settled) return;
        if (!isCurrent()) { abort(); return; }
        if (index >= plan.books.length) { writeProgress(0); return; }
        const book = plan.books[index];
        const request = bookStore.get(book.id);
        request.onsuccess = () => {
          const existing = request.result as BookDocument | undefined;
          if (!existing) {
            try {
              bookStore.add(book);
              pendingStore.put({ id: book.id, updatedAt: Date.now() });
              summaryStore.put(summaryFromDocument(book, "pending", sourceCharacters.get(book.id)));
              added.push(book);
            } catch {
              try { tx.abort(); } catch { /* 事务可能已结束。 */ }
              return;
            }
          } else {
            // 目标库已有同 id 书但摘要缺失（旧版本/损坏）时补写摘要，不覆盖正文。
            summaryStore.put(summaryFromDocument(existing, "local"));
          }
          writeBooks(index + 1);
        };
      };
      writeBooks(0);
    }).catch(reject);
  });
}

function startBookMigration(target: MigrationTarget, force: boolean): Promise<void> {
  if (!force && migrationAttemptEpoch === target.epoch) return migrationPromise ?? Promise.resolve();
  if (migrationState.status === "running" && migrationPromise) return migrationPromise;
  migrationAttemptEpoch = target.epoch;
  const generation = ++migrationGeneration;
  publishMigrationState({
    status: "running",
    userId: target.userId,
    migratedBooks: 0,
    migratedProgress: 0,
    canRetry: false,
  });
  const run = (async () => {
    try {
      const result = await runBookMigration({
        isCurrent: () => generation === migrationGeneration
          && activeUserId === target.userId
          && ownerEpoch === target.epoch
          && activeDbName === target.dbName,
        readSource: () => readMigrationSource(),
        readDestination: () => readMigrationDestination(target.dbName),
        migratedBookIds: readMigratedBookIds(target.userId),
        sink: {
          write: (plan, source, isCurrent) => applyBookMigration(target.dbName, plan, source, isCurrent),
          enqueue: book => enqueueBookUpload(book, { userId: target.userId, epoch: target.epoch }),
          notify: () => notifyBookOwners(target.userId),
          recordMigrated: books => appendMigratedBookIds(target.userId, books.map(book => book.id)),
        },
      });
      if (generation !== migrationGeneration) return;
      if (result.status === "cancelled") {
        publishMigrationState({
          status: "cancelled",
          userId: target.userId,
          migratedBooks: 0,
          migratedProgress: 0,
          canRetry: true,
        });
        return;
      }
      publishMigrationState({
        status: "completed",
        userId: target.userId,
        migratedBooks: result.migratedBooks,
        migratedProgress: result.migratedProgress,
        canRetry: false,
      });
    } catch (error) {
      if (generation !== migrationGeneration) return;
      publishMigrationState({
        status: error instanceof BookDatabaseBlockedError ? "blocked" : "failed",
        userId: target.userId,
        migratedBooks: 0,
        migratedProgress: 0,
        ...(error instanceof Error ? { error: error.message } : {}),
        canRetry: true,
      });
    }
  })();
  migrationPromise = run;
  void run.finally(() => { if (migrationPromise === run) migrationPromise = null; });
  return run;
}

export function getBookMigrationState(): BookMigrationState {
  return { ...migrationState };
}

/** 迁移失败或 IndexedDB 被阻塞后手动重试；同一 owner 周期不会自动循环重试。 */
export async function retryBookMigration(): Promise<BookMigrationState> {
  const target = migrationTarget;
  if (
    !target
    || target.epoch !== ownerEpoch
    || target.userId !== activeUserId
    || target.dbName !== activeDbName
  ) {
    return getBookMigrationState();
  }
  if (migrationState.status === "running") {
    if (migrationPromise) await migrationPromise;
    return getBookMigrationState();
  }
  if (migrationState.status !== "completed") {
    await startBookMigration(target, true);
  }
  return getBookMigrationState();
}

/* ── 后台上传队列：同一时刻只有一个上传，失败留在 pending 里等下次补传 ── */

export type BookUploadOutcome = "uploaded" | "cancelled" | "failed" | "network";
type UploadOutcome = BookUploadOutcome | "skipped";

/** 上传任务键按账户隔离：A 账户的删除绝不会取消或串到 B 账户的同 id 书。 */
export function bookUploadKey(userId: string, bookId: string): string {
  return `${userId}\u0000${bookId}`;
}

interface UploadQueueTask {
  key: string | null;
  ownerUserId: string | null;
  run: () => Promise<void>;
}

/**
 * 串行后台上传队列。key 用于去重与按书取消；单个任务失败不会中断队列。
 * 取消只移除尚未开始的任务，已经开始的任务由上传阶段前的删除检查自行中止。
 */
export class BookUploadQueue {
  private readonly tasks: UploadQueueTask[] = [];
  private readonly queuedKeys = new Set<string>();
  private running = false;
  private idleWaiters: Array<() => void> = [];

  /** 返回 false 表示相同 key 的任务已在排队。 */
  enqueue(key: string | null, ownerUserId: string | null, run: () => Promise<void>): boolean {
    if (key !== null) {
      if (this.queuedKeys.has(key)) return false;
      this.queuedKeys.add(key);
    }
    this.tasks.push({ key, ownerUserId, run });
    if (!this.running) void this.drain();
    return true;
  }

  cancel(key: string): boolean {
    const before = this.tasks.length;
    for (let index = this.tasks.length - 1; index >= 0; index--) {
      if (this.tasks[index].key === key) this.tasks.splice(index, 1);
    }
    this.queuedKeys.delete(key);
    return this.tasks.length !== before;
  }

  cancelOwner(ownerUserId: string): boolean {
    const before = this.tasks.length;
    for (let index = this.tasks.length - 1; index >= 0; index--) {
      const task = this.tasks[index];
      if (task.ownerUserId !== ownerUserId) continue;
      this.tasks.splice(index, 1);
      if (task.key !== null) this.queuedKeys.delete(task.key);
    }
    return this.tasks.length !== before;
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.tasks.length === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.idleWaiters.push(() => resolve());
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const task = this.tasks.shift();
        if (!task) break;
        try {
          await task.run();
        } catch {
          /* 单个后台上传的意外错误不影响队列，也不影响本地书架。 */
        }
        if (task.key !== null) this.queuedKeys.delete(task.key);
      }
    } finally {
      this.running = false;
      if (this.tasks.length) void this.drain();
      else {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }
}

const uploadQueue = new BookUploadQueue();
let pendingRetryOwner: string | null = null;

/** 账户删除时取消该账户尚未开始的上传；正在执行的任务由 owner epoch 检查中止。 */
function cancelOwnerBookUploads(userId: string): void {
  uploadQueue.cancelOwner(userId);
  if (pendingRetryOwner === userId) pendingRetryOwner = null;
}

export interface GuardedBookUploadInput {
  fetcher: Fetcher;
  userId: string;
  book: BookDocument;
  /** 用户显式重新导入：meta 阶段允许清除服务端删除墓碑。后台补传必须保持 false。 */
  reimport?: boolean;
  /** 每个网络阶段前调用；返回 false 时立即取消，后续阶段绝不会再发请求。 */
  shouldContinue: () => Promise<boolean>;
  /** 上传成功且删除决定未改变时执行（清理 pending 标记）。 */
  onUploaded?: () => Promise<void> | void;
  /** 已有请求发出后才取消时执行；用于补偿删除云端半成品。 */
  onCancelledAfterRequest?: () => Promise<void> | void;
  /** 失败观察者（如 401 时禁用云端）；抛错不影响上传流程。 */
  onFailed?: (error: unknown) => void;
}

/**
 * 带删除检查的两阶段上传：
 * - 每个网络阶段发出前调用 shouldContinue；
 * - 上传成功后再确认一次，删除决定晚于 original 完成时通过 onCancelledAfterRequest 补偿；
 * - 只有确实发出过阶段请求才补偿，排队阶段被删除不会产生任何云端写入。
 */
export async function runGuardedBookUpload(input: GuardedBookUploadInput): Promise<BookUploadOutcome> {
  let requestSent = false;
  let cancelled = false;
  let failure: unknown;
  const compensate = async (): Promise<void> => {
    try {
      await input.onCancelledAfterRequest?.();
    } catch {
      /* 补偿删除失败不应抛给本地上传流程；本地删除标记仍会阻止展示与再次上传。 */
    }
  };
  const uploaded = await attemptBookUpload({
    upload: () => uploadCloudBook(input.fetcher, {
      meta: toBookMetadata(input.book),
      original: input.book.original,
      expectedUserId: input.userId,
      ...(input.reimport === true ? { reimport: true } : {}),
      beforeStage: async () => {
        let keep = false;
        try {
          keep = await input.shouldContinue();
        } catch {
          keep = false;
        }
        if (!keep) {
          cancelled = true;
          throw new CloudBooksError("本地书籍已删除，已取消上传。", 0, "upload_cancelled");
        }
        requestSent = true;
      },
    }),
    onUploaded: async () => {
      let keep = false;
      try {
        keep = await input.shouldContinue();
      } catch {
        keep = false;
      }
      if (!keep) {
        cancelled = true;
        await compensate();
        return;
      }
      await input.onUploaded?.();
    },
    onFailed: error => {
      failure = error;
      try {
        input.onFailed?.(error);
      } catch {
        /* 观察者失败不影响上传流程。 */
      }
    },
  });
  if (cancelled) {
    if (!uploaded && requestSent) await compensate();
    return "cancelled";
  }
  if (!uploaded) {
    if (failure instanceof CloudBooksError) {
      if (failure.code === "network" || failure.status === 429 || failure.status >= 500) return "network";
    }
    return "failed";
  }
  return "uploaded";
}

/** 每个阶段前重新确认本机书仍存在：删除成功、账户切换或删除标记都会立即中止。 */
async function canUploadBook(book: BookDocument, snapshot: OwnerSnapshot): Promise<boolean> {
  if (!isCurrent(snapshot) || cloudDisabled) return false;
  if (isBookDeleted(snapshot.userId, book.id)) return false;
  if (!(await hasLocalBook(book.id))) return false;
  return isCurrent(snapshot) && !cloudDisabled && !isBookDeleted(snapshot.userId, book.id);
}

/** 在途上传可能已把半成品写到云端；删除决定仍有效时补发幂等 DELETE。 */
async function deleteCloudBookAfterDeletion(id: string, snapshot: OwnerSnapshot): Promise<void> {
  if (!isCurrent(snapshot) || cloudDisabled) return;
  if (!isBookDeleted(snapshot.userId, id)) return;
  try {
    await deleteCloudBook(cloudFetcher, id, { expectedUserId: snapshot.userId });
  } catch (error) {
    if (isCurrent(snapshot) && isCloudAuthError(error)) cloudDisabled = true;
    /* 补偿失败时本地已删除且删除标记仍在：书架不会再展示该书。 */
  }
}

async function uploadBook(
  book: BookDocument,
  snapshot: OwnerSnapshot,
  reimport = false,
): Promise<UploadOutcome> {
  if (!isCurrent(snapshot) || cloudDisabled || isBookDeleted(snapshot.userId, book.id)) return "skipped";
  publishBookSync(snapshot.userId, book.id, "uploading");
  const outcome = await runGuardedBookUpload({
    fetcher: cloudFetcher,
    userId: snapshot.userId,
    book,
    ...(reimport ? { reimport: true } : {}),
    shouldContinue: () => canUploadBook(book, snapshot),
    onUploaded: async () => {
      if (!isCurrent(snapshot)) return;
      await clearPendingMarker(book.id);
      if (isCurrent(snapshot)) await markSummaryCloudState(book.id, "ready");
    },
    onCancelledAfterRequest: () => deleteCloudBookAfterDeletion(book.id, snapshot),
    onFailed: error => {
      if (isCurrent(snapshot) && isCloudAuthError(error)) cloudDisabled = true;
    },
  });
  if (outcome === "uploaded") publishBookSync(snapshot.userId, book.id, "ready");
  else if (outcome === "failed" || outcome === "network") publishBookSync(snapshot.userId, book.id, "failed");
  else if (isCurrent(snapshot) && !isBookDeleted(snapshot.userId, book.id)) {
    // 取消/跳过（例如账号切换后由新账户继续）仍留在待传队列语义里。
    publishBookSync(snapshot.userId, book.id, "pending");
  }
  return outcome;
}

function enqueueBookUpload(
  book: BookDocument,
  snapshot: OwnerSnapshot,
  reimport = false,
): void {
  if (!isCurrent(snapshot) || cloudDisabled || isBookDeleted(snapshot.userId, book.id)) return;
  const key = bookUploadKey(snapshot.userId, book.id);
  // 显式重新导入必须覆盖仍排队的普通补传，否则旧任务会先被墓碑拒绝。
  if (reimport) uploadQueue.cancel(key);
  // 先发布 pending（已入队语义），再入队；队列空闲时任务会同步开始并发布 uploading，
  // 保证订阅者看到的顺序是 pending -> uploading，而非反序。
  publishBookSync(snapshot.userId, book.id, "pending");
  uploadQueue.enqueue(key, snapshot.userId, async () => {
    if (!isCurrent(snapshot) || cloudDisabled) return;
    if (isBookDeleted(snapshot.userId, book.id)) return;
    await uploadBook(book, snapshot, reimport);
  });
}

/** 删除开始时取消该书尚未开始的排队任务；运行中的任务由阶段检查中止。 */
function cancelQueuedBookUpload(userId: string, bookId: string): void {
  uploadQueue.cancel(bookUploadKey(userId, bookId));
}

/** 后续 listBooks 时补传本账户失败/未完成的书；任务异步执行，不阻塞书架显示。 */
function schedulePendingUploads(): void {
  const snapshot = cloudOwner();
  if (!snapshot || pendingRetryOwner === snapshot.userId) return;
  pendingRetryOwner = snapshot.userId;
  uploadQueue.enqueue(null, snapshot.userId, async () => {
    try {
      if (!isCurrent(snapshot) || cloudDisabled) return;
      const pending = await listPendingUploads();
      for (const record of pending) {
        if (!isCurrent(snapshot) || cloudDisabled) break;
        // 待传标记来自用户显式重新导入时，重试仍需携带清除墓碑的意图。
        if (record.reimport) unmarkBookDeleted(snapshot.userId, record.id);
        else if (isBookDeleted(snapshot.userId, record.id)) continue;
        const book = await getLocalBook(record.id);
        if (!book) {
          if (isCurrent(snapshot)) await clearPendingMarker(record.id);
          continue;
        }
        const outcome = await uploadBook(book, snapshot, record.reimport === true);
        if (outcome === "network" || outcome === "skipped") break;
      }
    } finally {
      if (pendingRetryOwner === snapshot.userId) pendingRetryOwner = null;
    }
  });
}

/* ── 书架同步状态（只供书架卡片展示，不参与云端校验） ───────── */

/**
 * 书架卡片的同步状态：
 * - local：仅保存在本机（未登录或登录状态已失效）
 * - pending：已入队，等待上传/补传
 * - uploading：正在上传
 * - ready：已在当前账户的云端书架
 * - failed：本次会话最近一次上传失败，可通过 retryBookSync 重试
 */
export type BookSyncState = "local" | "pending" | "uploading" | "ready" | "failed";

export interface BookSyncEvent {
  bookId: string;
  state: BookSyncState;
}

const syncListeners = new Set<(event: BookSyncEvent) => void>();
/** 本次会话的瞬时状态；只记录当前账户，刷新页面后回落到摘要里的 cloudState。 */
const syncOverrides = new Map<string, BookSyncState>();

function syncKey(userId: string | null, bookId: string): string {
  return `${userId ?? ""}\u0000${bookId}`;
}

/** 只向当前账户广播；切换账户后旧账户的上传结果不会改写新书架。 */
function publishBookSync(userId: string | null, bookId: string, state: BookSyncState): void {
  if (userId !== activeUserId) return;
  if (state === "ready") syncOverrides.delete(syncKey(userId, bookId));
  else syncOverrides.set(syncKey(userId, bookId), state);
  for (const listener of [...syncListeners]) {
    try {
      listener({ bookId, state });
    } catch {
      /* 单个界面订阅失败不能影响上传本身。 */
    }
  }
}

/** 订阅单本书的同步状态变化；返回取消订阅函数。 */
export function onBookSyncChange(listener: (event: BookSyncEvent) => void): () => void {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

/**
 * 读取当前账户每本书的同步状态：摘要里的持久状态 + 本次会话的上传/失败覆盖。
 * 只读 summaries store，不反序列化正文；切换账户时返回空对象，由调用方重新加载。
 */
export async function listBookSyncStates(): Promise<Record<string, BookSyncState>> {
  const epoch = ownerEpoch;
  const userId = activeUserId;
  const persisted = await transaction<Record<string, BookSyncState>>([SUMMARIES], "readonly", (tx, setResult) => {
    const result = Object.create(null) as Record<string, BookSyncState>;
    setResult(result);
    const request = tx.objectStore(SUMMARIES).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const summary = readLocalBookSummary(cursor.value);
      if (summary) result[summary.id] = summary.cloudState;
      cursor.continue();
    };
  });
  if (ownerEpoch !== epoch || activeUserId !== userId) return Object.create(null) as Record<string, BookSyncState>;
  const prefix = `${userId ?? ""}\u0000`;
  for (const [key, state] of syncOverrides) {
    if (key.startsWith(prefix)) persisted[key.slice(prefix.length)] = state;
  }
  return persisted;
}

/**
 * 手动重试单本书的上传（书架“未同步/同步失败”入口）。
 * 只重新入队，不等待上传完成；进度通过 onBookSyncChange 通知。
 */
export async function retryBookSync(id: string): Promise<void> {
  const snapshot = cloudOwner();
  if (!snapshot) throw new Error("当前未登录或登录状态已失效，无法同步到云端书架。");
  if (isBookDeleted(snapshot.userId, id)) throw new Error("这本书已标记为删除，未重新上传。");
  const assertSyncable = () => {
    if (!isCurrent(snapshot)) throw new Error("账号已切换，本次同步未开始。");
    if (cloudDisabled) throw new Error("登录状态已失效，请重新登录后再同步。");
  };
  const book = await getLocalBook(id);
  assertSyncable();
  if (!book) throw new Error("本机已找不到这本书，无法重新同步。");
  const pending = await listPendingUploads();
  assertSyncable();
  const record = pending.find(item => item.id === id);
  enqueueBookUpload(book, snapshot, record?.reimport === true);
}

/* ── 对外书架 API ─────────────────────────────────────────────── */

/** 本地优先；本机缺失时从云端取回 meta 与原文件，校验 SHA-256 后才缓存到本机。 */
export async function getBook(id: string): Promise<BookDocument | undefined> {
  const epoch = ownerEpoch;
  const local = await getLocalBook(id);
  if (ownerEpoch !== epoch) return getLocalBook(id);
  if (local) return local;
  const snapshot = cloudOwner();
  if (!snapshot) return undefined;
  if (isBookDeleted(snapshot.userId, id)) return undefined;
  try {
    const meta = await getCloudBookMeta(cloudFetcher, id, { expectedUserId: snapshot.userId });
    if (!isCurrent(snapshot)) return undefined;
    const downloaded = await downloadCloudBookOriginal(cloudFetcher, meta, { expectedUserId: snapshot.userId });
    if (!isCurrent(snapshot) || isBookDeleted(snapshot.userId, id)) return undefined;
    const document: BookDocument = { ...meta, original: downloaded.blob };
    try {
      await writeLocalBook(document);
    } catch {
      /* 本机空间不足时仍允许本次阅读；下次打开会重新从云端校验下载。 */
    }
    return document;
  } catch (error) {
    if (isCurrent(snapshot) && isCloudAuthError(error)) cloudDisabled = true;
    throw error;
  }
}

/**
 * 书架列表：本地 summary 与云端 ready summary 按 id 去重合并。
 * 云端返回的删除墓碑会先清理本机书目/进度/待传标记，并在合并时排除，
 * 因此另一台设备无法凭本地缓存让已删书籍重新出现。
 * 云端不可用（离线/401/坏数据）时只返回本机书架，不影响单机使用。
 */
export async function listBooks(): Promise<BookSummary[]> {
  const epoch = ownerEpoch;
  const local = await listLocalBooks();
  if (ownerEpoch !== epoch) return listLocalBooks();
  const snapshot = cloudOwner();
  if (!snapshot) return local;
  try {
    const cloud = await listCloudBooks(cloudFetcher, { expectedUserId: snapshot.userId });
    if (!isCurrent(snapshot)) return listLocalBooks();
    let localBooks = local;
    let tombstoned: string[] = [];
    if (cloud.deleted.length) {
      const purged = await purgeTombstonedBooks(snapshot.userId, cloud.deleted);
      if (!isCurrent(snapshot)) return listLocalBooks();
      const reimporting = new Set(purged.reimporting);
      tombstoned = cloud.deleted.filter(id => !reimporting.has(id));
      // 清理后重新读取，避免把刚清掉或刚重新导入的书按旧快照判断。
      localBooks = await listLocalBooks();
    }
    schedulePendingUploads();
    return mergeBookSummaries(
      localBooks,
      withoutDeletedBooks(cloud.books, snapshot.userId),
      tombstoned,
    );
  } catch (error) {
    if (isCurrent(snapshot) && isCloudAuthError(error)) cloudDisabled = true;
    return local;
  }
}

export interface SaveBookOptions {
  /** 调用方开始导入时捕获的 owner epoch；写入前不一致则拒绝，避免跨账户保存。 */
  expectedOwnerEpoch?: number;
}

/**
 * 本地先成功，再把同一本（含 original Blob）异步上传。
 * 用户导入是显式“重新导入”：待传标记会带 reimport，重试时 meta 也携带
 * X-Zhixu-Reimport，从而清除服务端删除墓碑；普通后台补传绝不会带这个意图。
 * 云端失败只留下 pending 标记，绝不回滚本地导入，也不会让调用方失败。
 */
export async function saveBook(book: BookDocument, options: SaveBookOptions = {}): Promise<void> {
  if (options.expectedOwnerEpoch !== undefined && ownerEpoch !== options.expectedOwnerEpoch) {
    throw new Error("账号已切换，本次导入未保存。请重新导入。");
  }
  if (!book.id || !book.sha256 || !book.blocks.length || !(book.original instanceof Blob)) throw new Error("书籍数据不完整，未保存。");
  const snapshot = currentOwner();
  const cloudState: LocalBookCloudState = snapshot && !cloudDisabled ? "pending" : "local";
  const characters = countBookCharacters(book.blocks);
  await transaction([BOOKS, PENDING, SUMMARIES], "readwrite", (tx, setResult) => {
    const store = tx.objectStore(BOOKS);
    const summaries = tx.objectStore(SUMMARIES);
    const request = store.get(book.id);
    request.onsuccess = () => {
      const stored = request.result as BookDocument | undefined;
      if (stored) {
        if (stored.sha256 !== book.sha256) { tx.abort(); return; }
      } else store.add(book);
      summaries.put(summaryFromDocument(stored ?? book, cloudState, characters));
      if (snapshot) tx.objectStore(PENDING).put({ id: book.id, updatedAt: Date.now(), reimport: true });
      setResult(undefined);
    };
  });
  if (snapshot) {
    // 用户重新导入同一本书即撤销本地删除决定；异步上传会清除服务端墓碑。
    // 同时进入保护窗口，避免早于上传完成产生的列表响应误删刚导入的书。
    rememberRecentReimport(snapshot.userId, book.id);
    unmarkBookDeleted(snapshot.userId, book.id);
    enqueueBookUpload(book, snapshot, true);
  }
}

/**
 * 先删云端（404 视为已删），成功后才删本机原书与阅读进度。
 * 删除开始即写本机删除标记并取消排队上传，在途上传会在下一阶段前中止；
 * 401/网络/账户不匹配时保留本机、撤销标记并报错；本地模式直接删本机。
 */
export async function deleteBook(id: string): Promise<void> {
  const snapshot = currentOwner();
  if (!snapshot) {
    await deleteLocalBook(id);
    syncOverrides.delete(syncKey(null, id));
    return;
  }
  if (cloudDisabled) {
    throw new CloudBooksError("登录状态已失效，云端书籍未删除；本机书籍仍保留。请重新登录后重试。", 401, "unauthorized");
  }
  recentReimports.delete(`${snapshot.userId}\u0000${id}`);
  markBookDeleted(snapshot.userId, id);
  cancelQueuedBookUpload(snapshot.userId, id);
  try {
    await deleteBookWithCloud(
      () => deleteCloudBook(cloudFetcher, id, { expectedUserId: snapshot.userId }),
      async () => {
        if (!isCurrent(snapshot)) throw new Error("账号已切换，未删除本机书籍。请刷新书架后重试。");
        await deleteLocalBook(id);
      },
    );
  } catch (error) {
    // 删除没有完成：本机与 pending 保持原行为，撤销标记以便稍后重试或重新上传。
    unmarkBookDeleted(snapshot.userId, id);
    if (isCurrent(snapshot) && isCloudAuthError(error)) cloudDisabled = true;
    throw error;
  }
  syncOverrides.delete(syncKey(snapshot.userId, id));
}

export function getBookProgress(bookId: string): Promise<BookProgress | undefined> {
  return transaction([PROGRESS], "readonly", (tx, setResult) => {
    const request = tx.objectStore(PROGRESS).get(bookId);
    request.onsuccess = () => setResult(request.result as BookProgress | undefined);
  });
}

export function saveBookProgress(progress: BookProgress): Promise<void> {
  return transaction([BOOKS, PROGRESS], "readwrite", (tx, setResult) => {
    const request = tx.objectStore(BOOKS).get(progress.bookId);
    request.onsuccess = () => {
      const book = request.result as BookDocument | undefined;
      if (!book || !book.chapters.some(chapter => chapter.id === progress.chapterId) || (progress.blockId && !book.blocks.some(block => block.id === progress.blockId && block.chapterId === progress.chapterId)) || progress.readChapterIds.some(id => !book.chapters.some(chapter => chapter.id === id))) { tx.abort(); return; }
      tx.objectStore(PROGRESS).put(progress);
      setResult(undefined);
    };
  });
}

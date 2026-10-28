import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BookFormat, CloudBookSummary } from "../src/bookTypes";

/**
 * SQLite 持久层（单节点正式版）：
 * - WAL、外键、busy_timeout；
 * - 启动迁移幂等；
 * - 全部查询走 prepared statements；
 * - 会话/恢复码只存哈希，密码哈希也不入日志。
 */

export interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: number;
}

export interface SessionRow {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkspaceRow {
  userId: string;
  revision: number;
  data: string | null;
  updatedAt: number;
}

export interface UserCredentialsRow {
  userId: string;
  payload: string;
  updatedAt: number;
}

export interface UsageRow {
  chat: number;
  diagnostic: number;
  review: number;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 会话有效期 30 天
export const SESSION_COOKIE_NAME = "zhixu_session";

export type UsageKind = keyof UsageRow;

/** 每用户书架配额：书目数量与已保存原文件总字节。 */
export const MAX_LIBRARY_BOOKS = 100;
export const MAX_LIBRARY_ORIGINAL_BYTES_PER_USER = 500 * 1024 * 1024;

/**
 * 每用户删除墓碑上限：DELETE 允许针对任意 id（包括从未存在的书），
 * 若不设上限，反复删除随机 id 会把 `library_deletions` 撑成无限增长。
 * 达到上限后拒绝新墓碑；同一 id 的幂等重复删除不受影响。
 */
export const MAX_LIBRARY_TOMBSTONES_PER_USER = 1000;
/** 删除墓碑保留天数：跨设备删除意图不应永久占用空间。 */
export const LIBRARY_TOMBSTONE_RETENTION_DAYS = 90;
/** pending 书目保留小时数：meta 成功但原文件迟迟未上传的中间态自动回收。 */
export const PENDING_LIBRARY_TTL_HOURS = 24;

/** 新墓碑会超过每用户上限时抛出；HTTP 层转换为 409 tombstone_limit。 */
export class LibraryTombstoneLimitError extends Error {
  constructor() {
    super(`每用户最多保留 ${MAX_LIBRARY_TOMBSTONES_PER_USER} 条书架删除墓碑。`);
    this.name = "LibraryTombstoneLimitError";
  }
}

/** 服务端从已校验 metadata 派生的摘要列，列表查询不读取 BLOB/整份 meta。 */
export interface LibraryMetaInput {
  id: string;
  sha256: string;
  meta: string;
  title: string;
  author: string;
  format: BookFormat;
  fileName: string;
  byteLength: number;
  importedAt: number;
  chapterCount: number;
  blockCount: number;
  characters: number;
  warnings: string;
  pageCount: number | null;
}

export type LibraryMetaWriteResult =
  | { ok: true; created: boolean; revision: number }
  | { ok: false; reason: "book_limit" | "book_deleted" };

export type LibraryOriginalWriteResult =
  | { ok: true; revision: number }
  | {
      ok: false;
      reason:
        | "missing_meta"
        | "sha_mismatch"
        | "byte_length_mismatch"
        | "original_quota"
        | "book_deleted";
    };

/** 写入书目元数据的选项；`reimport` 只能由用户显式重新导入触发。 */
export interface LibraryMetaWriteOptions {
  /** 用户重新导入同一 id 的书籍：同步清除跨设备删除墓碑。 */
  reimport?: boolean;
  now?: number;
}

/**
 * 原文件下载元信息：只有摘要、长度与文件名，不含 BLOB。
 * 下载路由先取它确定 Content-Length，再用 `readReadyLibraryOriginalChunk`
 * 分片读取，避免整份原文件驻留内存。
 */
export interface LibraryOriginalInfo {
  sha256: string;
  /** 元数据声明的大小（审计口径）。 */
  byteLength: number;
  /** BLOB 实际字节数，与历史上 Content-Length 的取值一致。 */
  storedBytes: number;
  fileName: string;
  format: BookFormat;
}

/**
 * 单个分片及其所属 BLOB 的 sha256。下载在背压时可能暂停任意长时间，
 * 期间同 id 的书可能被重新上传；调用方用 sha256 判断分片是否来自同一份文件，
 * 发现变化立即中止，避免新旧文件拼接出“字节一致”但内容错误的响应。
 */
export interface LibraryOriginalChunk {
  chunk: Uint8Array;
  sha256: string;
}

/** 单条原子扣减 SQL：并发下只有仍低于上限时才成功，杜绝先读后写超扣。 */
function consumeUsageSql(column: UsageKind): string {
  return `INSERT INTO daily_usage (user_id, day, chat, diagnostic, review) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET
      ${column} = ${column} + 1
    WHERE ${column} < ?`;
}

function usageInitial(kind: UsageKind): [number, number, number] {
  if (kind === "chat") return [1, 0, 0];
  if (kind === "diagnostic") return [0, 1, 0];
  return [0, 0, 1];
}

/** 用户 id：随机 128 位，无序、不可枚举。 */
export function newId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * 迁移按数组顺序执行，数组第 N 项（从 1 开始）对应 `PRAGMA user_version = N`。
 * 已发布的迁移只能追加，不能改写；旧库的 user_version=0 会按顺序补齐并保留数据。
 */
const MIGRATIONS: readonly string[] = [
  // 001：初始表结构
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS recovery_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

  CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    data TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    chat INTEGER NOT NULL DEFAULT 0,
    diagnostic INTEGER NOT NULL DEFAULT 0,
    review INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    event TEXT NOT NULL,
    result TEXT NOT NULL,
    user_id TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

  CREATE TABLE IF NOT EXISTS auth_rate_limit (
    subject TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 002：账号级书架（书目元数据 + 原文件 BLOB），按 user_id 隔离并随账户级联删除
  `
  CREATE TABLE IF NOT EXISTS library_books (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
    sha256 TEXT NOT NULL,
    meta TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    format TEXT NOT NULL,
    file_name TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    chapter_count INTEGER NOT NULL,
    block_count INTEGER NOT NULL,
    characters INTEGER NOT NULL,
    warnings TEXT NOT NULL,
    page_count INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_library_books_user
    ON library_books(user_id, state, updated_at DESC);

  CREATE TABLE IF NOT EXISTS library_originals (
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id),
    FOREIGN KEY (user_id, book_id) REFERENCES library_books(user_id, id) ON DELETE CASCADE
  );
  `,
  // 003：每用户加密保存的个人模型/搜索配置与 Key；不进入工作区/备份导出
  `
  CREATE TABLE IF NOT EXISTS user_credentials (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 004：跨设备删除墓碑；删除书目时记录，用户显式重新导入同一 id 时清除。
  // 表随账户级联删除；旧库升级只新增空表，不改动既有书架与原文件。
  `
  CREATE TABLE IF NOT EXISTS library_deletions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  `,
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** 迁移后必须存在的表；`user_credentials` 的缺失会让 BYOK 部署在运行期才失败。 */
const REQUIRED_TABLES = [
  "users",
  "sessions",
  "recovery_codes",
  "workspaces",
  "daily_usage",
  "audit_log",
  "auth_rate_limit",
  "library_books",
  "library_originals",
  "library_deletions",
  "user_credentials",
] as const;

export interface DatabaseHealth {
  ok: boolean;
  schemaVersion: number;
  latestSchemaVersion: number;
  missingTables: string[];
}

/**
 * 与 server/auth.ts 的 hashToken 保持一致：auth_rate_limit.subject 内的值
 * 都是 SHA-256 十六进制（`${scope}:${kind}:${sha256(value)}`）。
 */
function rateLimitHash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const raw = row && "user_version" in row ? row.user_version : undefined;
  const version = typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`数据库 user_version 非法：${String(raw)}`);
  }
  return version;
}

/** 启动/ready 用的结构健康检查：迁移版本必须匹配，所有必需表（含凭据表）必须存在。 */
export function inspectDatabaseHealth(db: DatabaseSync): DatabaseHealth {
  const schemaVersion = readSchemaVersion(db);
  const missingTables = REQUIRED_TABLES.filter(
    (table) =>
      db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  return {
    ok: schemaVersion === LATEST_SCHEMA_VERSION && missingTables.length === 0,
    schemaVersion,
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    missingTables: [...missingTables],
  };
}

/**
 * 用事务执行未完成的迁移：任一迁移失败则整体回滚，user_version 不前进，
 * 旧库保持迁移前的可用状态。导出以便回归测试验证回滚。
 */
export function migrateDatabase(
  db: DatabaseSync,
  migrations: readonly string[] = MIGRATIONS,
): void {
  const latest = migrations.length;
  const current = readSchemaVersion(db);
  if (current > latest) {
    throw new Error(
      `数据库结构版本 ${current} 高于当前程序支持的 ${latest}。请升级应用，或从升级前的备份恢复。`,
    );
  }
  if (current === latest) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = current; index < latest; index += 1) {
      db.exec(migrations[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 连接已不可用等场景：保留原始异常，ROLLBACK 失败不再覆盖。
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`数据库迁移失败（版本 ${current} → ${latest}）：${detail}`, {
      cause: error,
    });
  }
}

export class ZhixuDatabase {
  readonly db: DatabaseSync;
  private readonly statements: {
    insertUser: StatementRun;
    userByEmail: StatementGet;
    userById: StatementGet;
    updatePassword: StatementRun;
    deleteSessionsByUser: StatementRun;
    deleteRecoveryByUser: StatementRun;
    insertSession: StatementRun;
    sessionByToken: StatementGet;
    deleteSession: StatementRun;
    deleteExpiredSessions: StatementRun;
    insertRecovery: StatementRun;
    recoveryByHash: StatementGet;
    deleteRecovery: StatementRun;
    getWorkspace: StatementGet;
    initWorkspace: StatementRun;
    updateWorkspace: StatementRun;
    deleteWorkspace: StatementRun;
    getCredentials: StatementGet;
    anyCredentials: StatementGet;
    countCredentials: StatementGet;
    upsertCredentials: StatementRun;
    deleteCredentials: StatementRun;
    deleteUsage: StatementRun;
    getUsage: StatementGet;
    consumeStatements: Record<UsageKind, StatementRun>;
    insertAudit: StatementRun;
    getRateLimit: StatementGet;
    upsertRateLimit: StatementRun;
    deleteRateLimit: StatementRun;
    libraryBookCount: StatementGet;
    libraryBookExists: StatementGet;
    libraryBookDeletion: StatementGet;
    countLibraryDeletions: StatementGet;
    insertLibraryDeletion: StatementRun;
    deleteLibraryDeletion: StatementRun;
    listLibraryDeletions: StatementAll;
    insertLibraryMeta: StatementRun;
    updateLibraryMeta: StatementRun;
    libraryBookRevision: StatementGet;
    listReadyLibraryBooks: StatementAll;
    libraryBookForUpload: StatementGet;
    libraryOtherOriginalBytes: StatementGet;
    upsertLibraryOriginal: StatementRun;
    markLibraryBookReady: StatementRun;
    getReadyLibraryMeta: StatementGet;
    getReadyLibraryOriginalInfo: StatementGet;
    readReadyLibraryOriginalChunk: StatementGet;
    deleteLibraryBook: StatementRun;
  };
  private transactionDepth = 0;

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile) || ".", { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    try {
      migrateDatabase(this.db);
      const health = inspectDatabaseHealth(this.db);
      if (!health.ok) {
        throw new Error(
          `数据库结构校验失败：版本 ${health.schemaVersion}/${health.latestSchemaVersion}` +
            (health.missingTables.length
              ? `，缺少表：${health.missingTables.join("、")}`
              : ""),
        );
      }
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // 构造失败时尽力关闭连接，保留原始异常。
      }
      throw error;
    }
    this.statements = {
      insertUser: this.db.prepare(
        "INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      userByEmail: this.db.prepare("SELECT * FROM users WHERE email = ?"),
      userById: this.db.prepare("SELECT * FROM users WHERE id = ?"),
      updatePassword: this.db.prepare(
        "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
      ),
      deleteSessionsByUser: this.db.prepare("DELETE FROM sessions WHERE user_id = ?"),
      deleteRecoveryByUser: this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?"),
      insertSession: this.db.prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      ),
      sessionByToken: this.db.prepare(
        "SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?",
      ),
      deleteSession: this.db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
      deleteExpiredSessions: this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
      insertRecovery: this.db.prepare(
        "INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)",
      ),
      recoveryByHash: this.db.prepare("SELECT * FROM recovery_codes WHERE code_hash = ?"),
      deleteRecovery: this.db.prepare("DELETE FROM recovery_codes WHERE code_hash = ?"),
      getWorkspace: this.db.prepare("SELECT * FROM workspaces WHERE user_id = ?"),
      initWorkspace: this.db.prepare(
        "INSERT OR IGNORE INTO workspaces (user_id, revision, data, updated_at) VALUES (?, 0, NULL, ?)",
      ),
      updateWorkspace: this.db.prepare(
        `UPDATE workspaces SET revision = revision + 1, data = ?, updated_at = ?
         WHERE user_id = ? AND revision = ?`,
      ),
      deleteWorkspace: this.db.prepare("DELETE FROM workspaces WHERE user_id = ?"),
      getCredentials: this.db.prepare(
        "SELECT user_id, payload, updated_at FROM user_credentials WHERE user_id = ?",
      ),
      anyCredentials: this.db.prepare(
        "SELECT user_id, payload, updated_at FROM user_credentials LIMIT 1",
      ),
      countCredentials: this.db.prepare(
        "SELECT COUNT(*) AS count FROM user_credentials",
      ),
      upsertCredentials: this.db.prepare(
        `INSERT INTO user_credentials (user_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      ),
      deleteCredentials: this.db.prepare("DELETE FROM user_credentials WHERE user_id = ?"),
      deleteUsage: this.db.prepare("DELETE FROM daily_usage WHERE user_id = ?"),
      getUsage: this.db.prepare("SELECT * FROM daily_usage WHERE user_id = ? AND day = ?"),
      consumeStatements: {
        chat: this.db.prepare(consumeUsageSql("chat")),
        diagnostic: this.db.prepare(consumeUsageSql("diagnostic")),
        review: this.db.prepare(consumeUsageSql("review")),
      },
      insertAudit: this.db.prepare(
        "INSERT INTO audit_log (ts, request_id, event, result, user_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      getRateLimit: this.db.prepare("SELECT * FROM auth_rate_limit WHERE subject = ?"),
      upsertRateLimit: this.db.prepare(
        `INSERT INTO auth_rate_limit (subject, window_start, failures, blocked_until) VALUES (?, ?, ?, ?)
         ON CONFLICT(subject) DO UPDATE SET
           window_start = excluded.window_start, failures = excluded.failures, blocked_until = excluded.blocked_until`,
      ),
      deleteRateLimit: this.db.prepare("DELETE FROM auth_rate_limit WHERE subject = ?"),
      libraryBookCount: this.db.prepare(
        "SELECT COUNT(*) AS count FROM library_books WHERE user_id = ?",
      ),
      libraryBookExists: this.db.prepare(
        "SELECT 1 AS found FROM library_books WHERE user_id = ? AND id = ?",
      ),
      libraryBookDeletion: this.db.prepare(
        "SELECT 1 AS found FROM library_deletions WHERE user_id = ? AND book_id = ?",
      ),
      countLibraryDeletions: this.db.prepare(
        "SELECT COUNT(*) AS count FROM library_deletions WHERE user_id = ?",
      ),
      insertLibraryDeletion: this.db.prepare(
        `INSERT INTO library_deletions (user_id, book_id, deleted_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, book_id) DO NOTHING`,
      ),
      deleteLibraryDeletion: this.db.prepare(
        "DELETE FROM library_deletions WHERE user_id = ? AND book_id = ?",
      ),
      listLibraryDeletions: this.db.prepare(
        "SELECT book_id FROM library_deletions WHERE user_id = ? ORDER BY deleted_at DESC, book_id ASC",
      ),
      insertLibraryMeta: this.db.prepare(
        `INSERT INTO library_books (
           user_id, id, revision, state, sha256, meta, title, author, format, file_name,
           byte_length, imported_at, chapter_count, block_count, characters, warnings,
           page_count, created_at, updated_at
         ) VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateLibraryMeta: this.db.prepare(
        `UPDATE library_books SET
           revision = revision + 1, state = 'pending', sha256 = ?, meta = ?, title = ?,
           author = ?, format = ?, file_name = ?, byte_length = ?, imported_at = ?,
           chapter_count = ?, block_count = ?, characters = ?, warnings = ?, page_count = ?,
           updated_at = ?
         WHERE user_id = ? AND id = ?`,
      ),
      libraryBookRevision: this.db.prepare(
        "SELECT revision FROM library_books WHERE user_id = ? AND id = ?",
      ),
      listReadyLibraryBooks: this.db.prepare(
        `SELECT id, title, author, format, file_name, byte_length, imported_at,
                chapter_count, block_count, characters, warnings, page_count, updated_at
         FROM library_books
         WHERE user_id = ? AND state = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM library_deletions d
             WHERE d.user_id = library_books.user_id AND d.book_id = library_books.id
           )
         ORDER BY updated_at DESC, id ASC`,
      ),
      libraryBookForUpload: this.db.prepare(
        "SELECT sha256, byte_length FROM library_books WHERE user_id = ? AND id = ?",
      ),
      libraryOtherOriginalBytes: this.db.prepare(
        `SELECT COALESCE(SUM(byte_length), 0) AS total
         FROM library_originals WHERE user_id = ? AND book_id <> ?`,
      ),
      upsertLibraryOriginal: this.db.prepare(
        `INSERT INTO library_originals (user_id, book_id, sha256, byte_length, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, book_id) DO UPDATE SET
           sha256 = excluded.sha256, byte_length = excluded.byte_length,
           bytes = excluded.bytes, updated_at = excluded.updated_at`,
      ),
      markLibraryBookReady: this.db.prepare(
        `UPDATE library_books SET state = 'ready', revision = revision + 1, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      ),
      getReadyLibraryMeta: this.db.prepare(
        `SELECT meta FROM library_books b
         WHERE b.user_id = ? AND b.id = ? AND b.state = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM library_deletions d
             WHERE d.user_id = b.user_id AND d.book_id = b.id
           )`,
      ),
      getReadyLibraryOriginalInfo: this.db.prepare(
        `SELECT o.sha256 AS sha256, o.byte_length AS byte_length,
                length(o.bytes) AS stored_bytes,
                b.file_name AS file_name, b.format AS format
         FROM library_originals o
         JOIN library_books b ON b.user_id = o.user_id AND b.id = o.book_id
         WHERE o.user_id = ? AND o.book_id = ? AND b.state = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM library_deletions d
             WHERE d.user_id = o.user_id AND d.book_id = o.book_id
           )`,
      ),
      // substr 的偏移是 1-based，且只把该分片交给 JS；整份 BLOB 不会被取出。
      readReadyLibraryOriginalChunk: this.db.prepare(
        `SELECT substr(o.bytes, ?, ?) AS chunk, o.sha256 AS sha256
         FROM library_originals o
         JOIN library_books b ON b.user_id = o.user_id AND b.id = o.book_id
         WHERE o.user_id = ? AND o.book_id = ? AND b.state = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM library_deletions d
             WHERE d.user_id = o.user_id AND d.book_id = o.book_id
           )`,
      ),
      deleteLibraryBook: this.db.prepare(
        "DELETE FROM library_books WHERE user_id = ? AND id = ?",
      ),
    };
  }

  /** 启动时清理过期会话；返回删除数量。 */
  cleanupExpiredSessions(now = Date.now()): number {
    return Number(this.statements.deleteExpiredSessions.run(now).changes);
  }

  /**
   * 事务包装：嵌套调用退化为加入外层事务，避免 `cannot start a transaction
   * within a transaction`；外层失败时统一回滚。
   */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 连接已不可用等场景：保留原始异常，ROLLBACK 失败不再覆盖。
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  // ── users ───────────────────────────────────────────────────────────────
  createUser(user: { id: string; email: string; name: string; passwordHash: string; passwordSalt: string }): void {
    this.statements.insertUser.run(
      user.id, user.email, user.name, user.passwordHash, user.passwordSalt, Date.now(),
    );
  }

  userByEmail(email: string): UserRow | undefined {
    return toUser(this.statements.userByEmail.get(email));
  }

  userById(id: string): UserRow | undefined {
    return toUser(this.statements.userById.get(id));
  }

  /** 删除用户并级联：会话、恢复码、工作区、每日用量、限流记录、书架（含原文件 BLOB 与删除墓碑）。 */
  deleteUser(userId: string): void {
    this.transaction(() => {
      const user = this.userById(userId);
      this.statements.deleteSessionsByUser.run(userId);
      this.statements.deleteRecoveryByUser.run(userId);
      this.statements.deleteWorkspace.run(userId);
      this.statements.deleteCredentials.run(userId);
      this.statements.deleteUsage.run(userId);
      // subject 是 `${scope}:${kind}:${sha256(value)}`；旧写法 `user:${userId}%`
      // 永远匹配不到，会留下账户级（account/recovery-rotate）与邮箱级限流孤儿行。
      const userHash = rateLimitHash(userId);
      const subjects = [
        `account:user:${userHash}`,
        `recovery-rotate:user:${userHash}`,
        ...(user
          ? [
              `login:email:${rateLimitHash(user.email)}`,
              `recover:email:${rateLimitHash(user.email)}`,
            ]
          : []),
      ];
      for (const subject of subjects) this.statements.deleteRateLimit.run(subject);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    });
  }

  /** 账户恢复时轮换密码；返回是否命中用户。 */
  updatePassword(userId: string, passwordHash: string, passwordSalt: string): boolean {
    return Number(this.statements.updatePassword.run(passwordHash, passwordSalt, userId).changes) === 1;
  }

  // ── sessions ────────────────────────────────────────────────────────────
  createSession(userId: string, tokenHash: string, now = Date.now()): void {
    this.statements.insertSession.run(tokenHash, userId, now, now + SESSION_TTL_MS);
  }

  sessionByTokenHash(tokenHash: string, now = Date.now()): SessionRow | undefined {
    const row = this.statements.sessionByToken.get(tokenHash, now);
    if (!row) return undefined;
    return {
      tokenHash: String(row.token_hash),
      userId: String(row.user_id),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  deleteSession(tokenHash: string): void {
    this.statements.deleteSession.run(tokenHash);
  }

  deleteSessionsForUser(userId: string): void {
    this.statements.deleteSessionsByUser.run(userId);
  }

  // ── recovery codes ──────────────────────────────────────────────────────
  createRecoveryCode(userId: string, codeHash: string, now = Date.now()): void {
    this.statements.insertRecovery.run(codeHash, userId, now);
  }

  recoveryByCodeHash(codeHash: string): { userId: string } | undefined {
    const row = this.statements.recoveryByHash.get(codeHash);
    return row ? { userId: String(row.user_id) } : undefined;
  }

  deleteRecoveryCode(codeHash: string): void {
    this.statements.deleteRecovery.run(codeHash);
  }

  deleteRecoveryCodesForUser(userId: string): void {
    this.statements.deleteRecoveryByUser.run(userId);
  }

  // ── workspace ───────────────────────────────────────────────────────────
  getWorkspace(userId: string): WorkspaceRow | undefined {
    const row = this.statements.getWorkspace.get(userId);
    if (!row) return undefined;
    return {
      userId: String(row.user_id),
      revision: Number(row.revision),
      data: row.data === null || row.data === undefined ? null : String(row.data),
      updatedAt: Number(row.updated_at),
    };
  }

  /** 确保工作区行存在（注册时调用）。 */
  initWorkspace(userId: string, now = Date.now()): void {
    this.statements.initWorkspace.run(userId, now);
  }

  /** 乐观并发：只有当前 revision 匹配才 +1；返回更新后的行或 undefined（冲突）。 */
  updateWorkspace(
    userId: string,
    expectedRevision: number,
    data: string | null,
    now = Date.now(),
  ): WorkspaceRow | undefined {
    const changes = this.statements.updateWorkspace.run(data, now, userId, expectedRevision).changes;
    if (Number(changes) !== 1) return undefined;
    return this.getWorkspace(userId);
  }

  // ── user_credentials（服务端加密凭据） ─────────────────────────────────
  getCredentials(userId: string): UserCredentialsRow | undefined {
    const row = this.statements.getCredentials.get(userId);
    if (!row) return undefined;
    return {
      userId: String(row.user_id),
      payload: String(row.payload),
      updatedAt: Number(row.updated_at),
    };
  }

  /** 任取一条已保存凭据，用于确认当前密钥仍能解密既有数据（不返回给客户端）。 */
  anyCredentials(): UserCredentialsRow | undefined {
    const row = this.statements.anyCredentials.get();
    if (!row) return undefined;
    return {
      userId: String(row.user_id),
      payload: String(row.payload),
      updatedAt: Number(row.updated_at),
    };
  }

  countCredentials(): number {
    const row = this.statements.countCredentials.get();
    return Number(row?.count ?? 0);
  }

  saveCredentials(userId: string, payload: string, now = Date.now()): number {
    this.statements.upsertCredentials.run(userId, payload, now);
    return now;
  }

  deleteCredentials(userId: string): void {
    this.statements.deleteCredentials.run(userId);
  }

  // ── library（账号级书架） ────────────────────────────────────────────────
  /**
   * 写入书目元数据（两阶段上传的第一阶段）：新书受 100 本配额约束，
   * 已有书原地更新并回到 pending，等待同 id 原文件重新校验。
   * 已删除（存在墓碑）的 id 默认拒绝，避免旧设备用本机缓存把书复活；
   * 只有用户显式重新导入（reimport）才在同一事务内清除墓碑并重新建立 pending。
   * 数量检查与写入在同一个 IMMEDIATE 事务内完成，避免并发越过上限。
   */
  upsertLibraryMeta(
    userId: string,
    book: LibraryMetaInput,
    options: LibraryMetaWriteOptions = {},
  ): LibraryMetaWriteResult {
    const now = options.now ?? Date.now();
    return this.transaction(() => {
      const deleted =
        this.statements.libraryBookDeletion.get(userId, book.id) !== undefined;
      if (deleted && !options.reimport) return { ok: false, reason: "book_deleted" } as const;
      const exists = this.statements.libraryBookExists.get(userId, book.id) !== undefined;
      if (!exists) {
        const row = this.statements.libraryBookCount.get(userId);
        if (Number(row?.count ?? 0) >= MAX_LIBRARY_BOOKS) {
          return { ok: false, reason: "book_limit" } as const;
        }
        // 只有确定能写入时才清除墓碑：配额失败不能让删除决定提前失效。
        if (deleted) this.statements.deleteLibraryDeletion.run(userId, book.id);
        this.statements.insertLibraryMeta.run(
          userId, book.id, book.sha256, book.meta, book.title, book.author,
          book.format, book.fileName, book.byteLength, book.importedAt,
          book.chapterCount, book.blockCount, book.characters, book.warnings,
          book.pageCount, now, now,
        );
        return { ok: true, created: true, revision: 1 } as const;
      }
      if (deleted) this.statements.deleteLibraryDeletion.run(userId, book.id);
      this.statements.updateLibraryMeta.run(
        book.sha256, book.meta, book.title, book.author, book.format, book.fileName,
        book.byteLength, book.importedAt, book.chapterCount, book.blockCount,
        book.characters, book.warnings, book.pageCount, now, userId, book.id,
      );
      const revision = Number(
        this.statements.libraryBookRevision.get(userId, book.id)?.revision ?? 0,
      );
      return { ok: true, created: false, revision } as const;
    });
  }

  /**
   * 两阶段上传的第二阶段：原文件必须与已保存元数据的 id/sha256/大小一致，
   * 且写入后该账户原文件总量不超过 500 MiB；检查与写入同一事务，成功后 ready。
   * 存在删除墓碑时明确拒绝，而不是把旧设备的在途原文件写回。
   */
  attachLibraryOriginal(
    userId: string,
    bookId: string,
    sha256: string,
    byteLength: number,
    bytes: Uint8Array,
    now = Date.now(),
  ): LibraryOriginalWriteResult {
    return this.transaction(() => {
      if (this.statements.libraryBookDeletion.get(userId, bookId) !== undefined) {
        return { ok: false, reason: "book_deleted" } as const;
      }
      const meta = this.statements.libraryBookForUpload.get(userId, bookId);
      if (!meta) return { ok: false, reason: "missing_meta" } as const;
      if (String(meta.sha256) !== sha256) return { ok: false, reason: "sha_mismatch" } as const;
      if (Number(meta.byte_length) !== byteLength) {
        return { ok: false, reason: "byte_length_mismatch" } as const;
      }
      const stored = this.statements.libraryOtherOriginalBytes.get(userId, bookId);
      if (Number(stored?.total ?? 0) + byteLength > MAX_LIBRARY_ORIGINAL_BYTES_PER_USER) {
        return { ok: false, reason: "original_quota" } as const;
      }
      this.statements.upsertLibraryOriginal.run(
        userId, bookId, sha256, byteLength, bytes, now,
      );
      this.statements.markLibraryBookReady.run(now, userId, bookId);
      const revision = Number(
        this.statements.libraryBookRevision.get(userId, bookId)?.revision ?? 0,
      );
      return { ok: true, revision } as const;
    });
  }

  /** 列表只读取派生摘要列，不触碰 BLOB 与整份 meta JSON。 */
  listReadyLibraryBooks(userId: string): CloudBookSummary[] {
    const rows = this.statements.listReadyLibraryBooks.all(userId);
    return rows.map((row) => {
      let warnings: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row.warnings));
        if (Array.isArray(parsed)) {
          warnings = parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        warnings = [];
      }
      const summary: CloudBookSummary = {
        id: String(row.id),
        title: String(row.title),
        author: String(row.author),
        format: String(row.format) as BookFormat,
        fileName: String(row.file_name),
        byteLength: Number(row.byte_length),
        importedAt: Number(row.imported_at),
        chapterCount: Number(row.chapter_count),
        blockCount: Number(row.block_count),
        characters: Number(row.characters),
        warnings,
        updatedAt: Number(row.updated_at),
      };
      if (row.page_count !== null && row.page_count !== undefined) {
        summary.pageCount = Number(row.page_count);
      }
      return summary;
    });
  }

  /** 只有 ready 的书对客户端可见，pending 视为不存在。 */
  getReadyLibraryMeta(userId: string, bookId: string): { meta: string } | undefined {
    const row = this.statements.getReadyLibraryMeta.get(userId, bookId);
    return row ? { meta: String(row.meta) } : undefined;
  }

  /**
   * 下载前的轻量查询：只读摘要/长度/文件名，不触碰 BLOB。
   * 书被重新导入（pending）或删除后，这里与历史行为一样返回 undefined。
   */
  getReadyLibraryOriginalInfo(
    userId: string,
    bookId: string,
  ): LibraryOriginalInfo | undefined {
    const row = this.statements.getReadyLibraryOriginalInfo.get(userId, bookId);
    if (!row) return undefined;
    return {
      sha256: String(row.sha256),
      byteLength: Number(row.byte_length),
      storedBytes: Number(row.stored_bytes),
      fileName: String(row.file_name),
      format: String(row.format) as BookFormat,
    };
  }

  /**
   * 按 `[offset, offset + length)` 读取原文件分片：SQL 用 substr 只取这一段，
   * 下载路由据此分块写响应，不再为整份 BLOB 驻留 JS 内存。
   * 同时返回该行的 sha256，供调用方识别“下载途中被重新上传”的情况。
   * 返回 undefined 表示书在下载过程中被删除或回到 pending（调用方应中止响应）；
   * 空分片表示已到 BLOB 末尾。
   */
  readReadyLibraryOriginalChunk(
    userId: string,
    bookId: string,
    offset: number,
    length: number,
  ): LibraryOriginalChunk | undefined {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`原文件分片偏移不合法：${String(offset)}`);
    }
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new RangeError(`原文件分片长度不合法：${String(length)}`);
    }
    const row = this.statements.readReadyLibraryOriginalChunk.get(
      offset + 1,
      length,
      userId,
      bookId,
    );
    if (!row) return undefined;
    const chunk = row.chunk;
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("library original chunk is not stored as binary");
    }
    return { chunk, sha256: String(row.sha256) };
  }

  /**
   * 删除书目并记录跨设备墓碑：原文件经外键级联同删；
   * 同 id 再次 DELETE 幂等，墓碑只保留首次删除时间。
   * 即使书目行不存在也记录墓碑：删除意图可能先于另一台设备的上传到达，
   * 必须阻止旧缓存随后把同 id 重新写回。返回值只表示是否删掉了书目行。
   * 新墓碑超过每用户上限时抛出 LibraryTombstoneLimitError，防止随机 id
   * 的重复 DELETE 无限膨胀墓碑表；已存在墓碑的幂等删除仍可成功。
   */
  deleteLibraryBook(userId: string, bookId: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const existing = this.statements.libraryBookDeletion.get(userId, bookId);
      if (existing === undefined) {
        const row = this.statements.countLibraryDeletions.get(userId);
        if (Number(row?.count ?? 0) >= MAX_LIBRARY_TOMBSTONES_PER_USER) {
          throw new LibraryTombstoneLimitError();
        }
      }
      this.statements.insertLibraryDeletion.run(userId, bookId, now);
      return Number(this.statements.deleteLibraryBook.run(userId, bookId).changes) > 0;
    });
  }

  /** 该账户全部删除墓碑的书籍 id；客户端据此清掉其它设备残留的本地缓存。 */
  listLibraryDeletions(userId: string): string[] {
    return this.statements.listLibraryDeletions
      .all(userId)
      .map((row) => String(row.book_id));
  }

  // ── daily usage ─────────────────────────────────────────────────────────
  usage(userId: string, day: string): UsageRow {
    const row = this.statements.getUsage.get(userId, day);
    return {
      chat: row ? Number(row.chat) : 0,
      diagnostic: row ? Number(row.diagnostic) : 0,
      review: row ? Number(row.review) : 0,
    };
  }

  /**
   * 原子扣减：单条 UPSERT ... WHERE 当前值 < 上限，天然防并发超扣；
   * 不再依赖事务内先读后写（也不会与外层事务嵌套冲突）。
   * 返回扣减后的用量；已达上限时返回 undefined。
   */
  consumeUsage(
    userId: string,
    day: string,
    kind: UsageKind,
    limit: number,
  ): UsageRow | undefined {
    if (!Number.isFinite(limit) || limit <= 0) return undefined;
    const [chat, diagnostic, review] = usageInitial(kind);
    const changes = this.statements.consumeStatements[kind].run(
      userId, day, chat, diagnostic, review, limit,
    ).changes;
    if (Number(changes) !== 1) return undefined;
    return this.usage(userId, day);
  }

  // ── audit log ───────────────────────────────────────────────────────────
  audit(event: string, result: "ok" | "denied" | "failed", requestId: string, userId?: string, detail?: string): void {
    this.statements.insertAudit.run(Date.now(), requestId, event, result, userId ?? null, detail ?? null);
  }

  // ── auth rate limit ─────────────────────────────────────────────────────
  getRateLimit(subject: string): { failures: number; windowStart: number; blockedUntil: number } | undefined {
    const row = this.statements.getRateLimit.get(subject);
    if (!row) return undefined;
    return {
      failures: Number(row.failures),
      windowStart: Number(row.window_start),
      blockedUntil: Number(row.blocked_until),
    };
  }

  setRateLimit(subject: string, windowStart: number, failures: number, blockedUntil: number): void {
    this.statements.upsertRateLimit.run(subject, windowStart, failures, blockedUntil);
  }

  clearRateLimit(subject: string): void {
    this.statements.deleteRateLimit.run(subject);
  }

  /**
   * 定期清理运维数据，避免审计/额度/限流/书架中间态行无限增长：
   * - audit 超过保留天数删除；
   * - daily_usage 早于 UTC 日期保留窗口删除；
   * - 已过期超过 30 天的认证限流行删除；
   * - library_deletions 超过保留天数删除（默认 90 天）；
   * - 超过 pending 窗口仍未上传原文件的 pending 书目删除（默认 24 小时），
   *   原文件行随外键级联清理。
   * 账户学习数据不在清理范围。
   */
  cleanupExpiredData(
    retention: {
      auditDays: number;
      usageDays: number;
      /** 删除墓碑保留天数；缺省 90，<=0 表示跳过。 */
      tombstoneDays?: number;
      /** pending 书目保留小时数；缺省 24，<=0 表示跳过。 */
      pendingLibraryHours?: number;
    },
    now = Date.now(),
  ): {
    audit: number;
    usage: number;
    rateLimits: number;
    tombstones: number;
    pendingLibraryBooks: number;
  } {
    let audit = 0;
    let usage = 0;
    let rateLimits = 0;
    let tombstones = 0;
    let pendingLibraryBooks = 0;
    const tombstoneDays = retention.tombstoneDays ?? LIBRARY_TOMBSTONE_RETENTION_DAYS;
    const pendingLibraryHours =
      retention.pendingLibraryHours ?? PENDING_LIBRARY_TTL_HOURS;
    this.transaction(() => {
      if (retention.auditDays > 0) {
        audit = Number(
          this.db
            .prepare("DELETE FROM audit_log WHERE ts < ?")
            .run(now - retention.auditDays * 86_400_000).changes,
        );
      }
      if (retention.usageDays > 0) {
        const cutoff = new Date(now - retention.usageDays * 86_400_000)
          .toISOString()
          .slice(0, 10);
        usage = Number(
          this.db
            .prepare("DELETE FROM daily_usage WHERE day < ?")
            .run(cutoff).changes,
        );
      }
      rateLimits = Number(
        this.db
          .prepare("DELETE FROM auth_rate_limit WHERE blocked_until < ? AND window_start < ?")
          .run(now - 30 * 86_400_000, now - 30 * 86_400_000).changes,
      );
      if (tombstoneDays > 0) {
        tombstones = Number(
          this.db
            .prepare("DELETE FROM library_deletions WHERE deleted_at < ?")
            .run(now - tombstoneDays * 86_400_000).changes,
        );
      }
      if (pendingLibraryHours > 0) {
        // 先删书目，library_originals 由 (user_id, book_id) 外键级联删除。
        pendingLibraryBooks = Number(
          this.db
            .prepare("DELETE FROM library_books WHERE state = 'pending' AND updated_at < ?")
            .run(now - pendingLibraryHours * 3_600_000).changes,
        );
      }
    });
    return { audit, usage, rateLimits, tombstones, pendingLibraryBooks };
  }

  /** 检查 DB 可用性与迁移/凭据表结构（/api/ready 与启动自检使用）。 */
  ping(): boolean {
    return this.db.prepare("SELECT 1 AS ok").get() !== undefined;
  }

  schemaHealth(): DatabaseHealth {
    return inspectDatabaseHealth(this.db);
  }

  close(): void {
    this.db.close();
  }
}

interface StatementRun {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface StatementGet {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface StatementAll {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

function toUser(row: Record<string, unknown> | undefined): UserRow | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    createdAt: Number(row.created_at),
  };
}

/** UTC 日期键（YYYY-MM-DD），额度按 UTC 日重置。 */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

#!/usr/bin/env node
/**
 * SQLite 数据库 + 凭据密钥备份脚本。
 *
 * - 用 SQLite `VACUUM INTO` 生成带时间戳的一致性快照，写入临时路径后原子
 *   rename 到最终文件名，避免半写文件被误认为可用备份；
 * - 同一次备份同时产出 `zhixu-<stamp>.db`、`zhixu-<stamp>.credentials.key`
 *   （存在时）和 `zhixu-<stamp>.manifest.json`，manifest 记录 SHA-256 与
 *   配套关系；数据库里已有加密凭据但密钥缺失/损坏时直接失败，绝不生成
 *   “成功”的缺密钥备份；
 * - 密钥副本与数据库快照权限收紧为 0600，manifest 同为 0600，输出目录
 *   收紧为 0700；保留清理按 stamp 成组删除 db/key/manifest。
 *
 * 用法：node --env-file=.env scripts/backup-db.ts
 * 也可直接 `npm run backup:db`（脚本会自行读取项目 .env，不修改它）。
 * 可选参数：--out <目录>    备份输出目录，默认 ${ZHIXU_DATA_DIR}/backups
 *          --retention <n>  保留最近 n 份备份，默认 14；0 表示不清理
 *          --help           显示帮助
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  CREDENTIAL_KEY_BYTES,
  CREDENTIAL_KEY_FILE,
  CredentialVault,
  type StoredCredentialSample,
} from "../server/credentialVault";

export const BACKUP_FORMAT = "zhixu-db-backup";
export const BACKUP_VERSION = 1;
export const DEFAULT_RETENTION = 14;

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_FILE_PATTERN =
  /^zhixu-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:\.db|\.credentials\.key|\.manifest\.json)$/;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  stamp: string;
  createdAt: string;
  dataDir: string;
  database: { file: string; bytes: number; sha256: string };
  credentialKey: { file: string; bytes: number; sha256: string } | null;
  credentialRows: number;
}

export interface BackupResult {
  stamp: string;
  database: string;
  credentialKey: string | null;
  manifest: string;
  credentialRows: number;
}

export interface BackupOptions {
  dataDir: string;
  outDir?: string;
  retention?: number;
  log?: (message: string) => void;
}

export interface ParsedBackupArgs {
  dataDir: string;
  outDir: string;
  retention: number;
  help: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失败清理时保留原始异常：临时/半成品文件删不掉也不能掩盖真正错误。 */
function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 保留原始异常。
  }
}

function backupStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** 读取 key 副本内容；不存在返回 null，存在但长度/内容异常直接失败。 */
function readCredentialKey(file: string): Buffer | null {
  let key: Buffer;
  try {
    key = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`凭据密钥文件无法读取：${errorMessage(error)}`);
  }
  if (key.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `凭据密钥文件长度必须是 ${CREDENTIAL_KEY_BYTES} 字节，当前为 ${key.length}；` +
        "请从备份恢复正确的 credentials.key，然后再做备份。",
    );
  }
  return key;
}

/** 权限收紧：Windows/FAT 等环境可能不支持 chmod，失败不阻断备份。 */
function tightenPermissions(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // 创建时已尽量使用私有模式；不要因为无法 chmod 让备份失败。
  }
}

/** 临时文件写入 + fsync + rename，确保最终文件出现时内容完整。 */
function writeFileAtomic(file: string, data: Buffer | string, mode: number): void {
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  tightenPermissions(file, mode);
}

function integrityCheck(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    return row?.integrity_check ?? "unknown";
  } finally {
    db.close();
  }
}

interface CredentialInspection {
  rows: number;
  sample?: StoredCredentialSample;
}

function inspectCredentials(file: string): CredentialInspection {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM user_credentials").get() as
      | { count?: number | bigint }
      | undefined;
    const sampleRow = db
      .prepare("SELECT user_id, payload FROM user_credentials LIMIT 1")
      .get() as { user_id?: unknown; payload?: unknown } | undefined;
    return {
      rows: Number(countRow?.count ?? 0),
      ...(sampleRow
        ? { sample: { userId: String(sampleRow.user_id), payload: String(sampleRow.payload) } }
        : {}),
    };
  } finally {
    db.close();
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 按 stamp 成组清理备份：db、credentials.key、manifest 一起删除，绝不留下
 * 孤立密钥或缺少密钥的“半份”备份。retention=0 不清理。
 */
export function pruneBackups(
  outDir: string,
  retention: number,
  log: (message: string) => void = () => {},
): string[] {
  if (!Number.isInteger(retention) || retention < 0) {
    throw new Error(`保留数量必须是非负整数，当前值：${retention}`);
  }
  if (retention === 0) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const byStamp = new Map<string, string[]>();
  for (const name of entries) {
    const match = BACKUP_FILE_PATTERN.exec(name);
    if (!match) continue;
    const stamp = match[1];
    const files = byStamp.get(stamp) ?? [];
    files.push(name);
    byStamp.set(stamp, files);
  }

  const keep = new Set(
    [...byStamp.entries()]
      .filter(([, files]) => files.some((name) => name.endsWith(".db")))
      .map(([stamp]) => stamp)
      .sort()
      .reverse()
      .slice(0, retention),
  );
  const stale = [...byStamp.keys()].filter((stamp) => !keep.has(stamp));
  for (const stamp of stale) {
    for (const name of byStamp.get(stamp) ?? []) {
      fs.rmSync(path.join(outDir, name), { force: true });
      log(`已清理过期备份：${name}`);
    }
  }
  return stale;
}

/**
 * 生成一份自校验的备份集。数据库里有加密凭据时，key 必须存在且 32 字节；
 * 备份期间 key 被删除/替换也会失败，并在失败时清理本次产生的半成品。
 */
export function createDatabaseBackup(options: BackupOptions): BackupResult {
  const dataDir = path.resolve(options.dataDir);
  const outDir = path.resolve(options.outDir ?? path.join(dataDir, "backups"));
  const retention = options.retention ?? DEFAULT_RETENTION;
  const log = options.log ?? (() => {});
  if (!Number.isInteger(retention) || retention < 0) {
    throw new Error(`保留数量必须是非负整数，当前值：${retention}`);
  }

  const dbPath = path.join(dataDir, "zhixu.db");
  const sourceKeyPath = path.join(dataDir, CREDENTIAL_KEY_FILE);
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `找不到数据库文件：${dbPath}。请确认 ZHIXU_DATA_DIR 指向运行中的数据目录。`,
    );
  }

  const sourceCredentialRows = inspectCredentials(dbPath).rows;
  const keyBytes = readCredentialKey(sourceKeyPath);
  if (sourceCredentialRows > 0 && !keyBytes) {
    throw new Error(
      `数据库中有 ${sourceCredentialRows} 条加密的个人凭据，但凭据密钥文件缺失：${sourceKeyPath}。` +
        "缺少密钥的备份无法恢复这些数据，已取消备份；请先恢复 credentials.key。",
    );
  }

  const stamp = backupStamp();
  const dbName = `zhixu-${stamp}.db`;
  const keyName = `zhixu-${stamp}.credentials.key`;
  const manifestName = `zhixu-${stamp}.manifest.json`;
  const finalDb = path.join(outDir, dbName);
  const finalKey = path.join(outDir, keyName);
  const finalManifest = path.join(outDir, manifestName);
  for (const file of [finalDb, finalKey, finalManifest]) {
    if (fs.existsSync(file)) {
      throw new Error(`目标备份文件已存在，拒绝覆盖：${file}。请手动归档后重试。`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  tightenPermissions(outDir, 0o700);
  const tmpDb = `${finalDb}.tmp`;
  const tmpKey = `${finalKey}.tmp`;
  const tmpManifest = `${finalManifest}.tmp`;
  const produced: string[] = [];

  try {
    fs.rmSync(tmpDb, { force: true });
    log(`正在从 ${dbPath} 生成一致性快照…`);
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try {
      source.exec("PRAGMA busy_timeout = 5000;");
      source.exec(`VACUUM INTO ${sqlString(tmpDb)}`);
    } finally {
      source.close();
    }
    // 数据库快照同样含用户数据与加密凭据，VACUUM INTO 默认受 umask 影响，显式收紧到 0600。
    tightenPermissions(tmpDb, 0o600);

    const integrity = integrityCheck(tmpDb);
    if (integrity !== "ok") {
      throw new Error(`备份文件完整性校验失败：${integrity}`);
    }
    const backupCredentials = inspectCredentials(tmpDb);
    const backupCredentialRows = backupCredentials.rows;
    if (backupCredentialRows > 0 && !keyBytes) {
      throw new Error(
        `备份快照中有 ${backupCredentialRows} 条加密凭据，但没有凭据密钥；已取消备份。`,
      );
    }

    // 备份期间 key 被删除或替换时，快照与密钥可能不配套，直接失败。
    const currentKeyBytes = readCredentialKey(sourceKeyPath);
    const keyChanged =
      (currentKeyBytes === null) !== (keyBytes === null) ||
      (currentKeyBytes !== null &&
        keyBytes !== null &&
        !currentKeyBytes.equals(keyBytes));
    if (keyChanged) {
      throw new Error("备份期间凭据密钥文件发生变化，请停止写入后重试。");
    }
    const backupSample = backupCredentials.sample;
    if (backupSample) {
      try {
        new CredentialVault(dataDir).verifyExisting(
          backupSample.userId,
          backupSample.payload,
        );
      } catch (error) {
        throw new Error(
          "凭据密钥无法解密备份快照中的已保存凭据" +
            `（${errorMessage(error)}），拒绝生成无法恢复的备份；请恢复正确的 credentials.key。`,
        );
      }
    }

    fs.renameSync(tmpDb, finalDb);
    tightenPermissions(finalDb, 0o600);
    produced.push(finalDb);

    if (keyBytes) {
      writeFileAtomic(finalKey, keyBytes, 0o600);
      produced.push(finalKey);
      if (!fs.readFileSync(finalKey).equals(keyBytes)) {
        throw new Error("凭据密钥备份校验失败：副本内容与源文件不一致。");
      }
      log(`凭据密钥已同时备份：${finalKey}（权限 0600）`);
    } else {
      log("数据库中没有已保存的个人凭据，本次备份无需凭据密钥。");
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      stamp,
      createdAt: new Date().toISOString(),
      dataDir,
      database: {
        file: dbName,
        bytes: fs.statSync(finalDb).size,
        sha256: sha256File(finalDb),
      },
      credentialKey: keyBytes
        ? {
            file: keyName,
            bytes: fs.statSync(finalKey).size,
            sha256: sha256File(finalKey),
          }
        : null,
      credentialRows: backupCredentialRows,
    };
    writeFileAtomic(finalManifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    produced.push(finalManifest);

    log(`备份完成并通过完整性校验：${finalDb}`);
    if (keyBytes) log(`凭据密钥副本：${finalKey}`);
    log(`配套清单：${finalManifest}`);

    try {
      pruneBackups(outDir, retention, log);
    } catch (error) {
      log(`警告：过期备份清理失败（不影响本次备份）：${errorMessage(error)}`);
    }

    return {
      stamp,
      database: finalDb,
      credentialKey: keyBytes ? finalKey : null,
      manifest: finalManifest,
      credentialRows: backupCredentialRows,
    };
  } catch (error) {
    for (const file of produced.reverse()) {
      removeQuietly(file);
    }
    removeQuietly(tmpDb);
    removeQuietly(tmpKey);
    removeQuietly(tmpManifest);
    throw error;
  }
}

function usage(): string {
  return [
    "用法：npm run backup:db -- [--out <目录>] [--retention <n>]",
    "  --out <目录>      备份输出目录，默认 ${ZHIXU_DATA_DIR}/backups",
    "  --retention <n>   保留最近 n 份备份，默认 14；0 表示不清理",
    "  --help            显示帮助",
  ].join("\n");
}

export function parseBackupArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedBackupArgs {
  let outArg: string | undefined;
  let retention = DEFAULT_RETENTION;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new Error("参数 --out 缺少目录值。用法：--out <目录>");
      }
      outArg = value;
      i += 1;
      continue;
    }
    if (arg === "--retention") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new Error(
          "参数 --retention 缺少保留数量。用法：--retention <n>，0 表示不清理。",
        );
      }
      if (!/^\d+$/.test(value.trim())) {
        throw new Error(`参数 --retention 必须是非负整数，当前值：${value}`);
      }
      retention = Number(value.trim());
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}。\n${usage()}`);
  }

  const dataDir = path.resolve(env.ZHIXU_DATA_DIR?.trim() || "./.data");
  return {
    dataDir,
    outDir: outArg ? path.resolve(outArg) : path.join(dataDir, "backups"),
    retention,
    help,
  };
}

function main(): void {
  try {
    // 读取项目 .env（不使用 override，环境变量优先），只读取、不修改真实密钥文件。
    loadDotenv({ path: path.join(SCRIPT_ROOT, ".env"), override: false });
    const options = parseBackupArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    console.log(`数据目录：${options.dataDir}`);
    console.log(`备份目录：${options.outDir}`);
    createDatabaseBackup({
      dataDir: options.dataDir,
      outDir: options.outDir,
      retention: options.retention,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error(`备份失败：${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.platform === "win32"
    ? path.resolve(process.argv[1]).toLowerCase() === scriptPath.toLowerCase()
    : path.resolve(process.argv[1]) === scriptPath);
if (invokedDirectly) main();

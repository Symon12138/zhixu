import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProviderSettings } from "../src/types";

/**
 * 服务端凭据加密：
 * - AES-256-GCM，AAD 绑定用户 ID，防止密文跨账户替换；
 * - key 文件放在 ZHIXU_DATA_DIR/credentials.key，首次保存时生成；
 * - key 文件丢失/损坏/被替换后旧密文不可恢复，备份/迁移必须同时包含该文件。
 *
 * 本模块不缓存密钥：每次都从磁盘读取，避免进程内缓存掩盖 key 文件被删除、
 * 替换或损坏，进而在重启后产生无法恢复的新密文。key 文件以 0600 创建，
 * 并通过同目录临时文件 + 原子链接/重命名发布。
 */
export const CREDENTIAL_KEY_FILE = "credentials.key";
export const CREDENTIAL_KEY_BYTES = 32;

export type CredentialKeyStatus = "ok" | "not_initialized" | "missing" | "invalid" | "mismatch";

export interface CredentialKeyHealth {
  ok: boolean;
  status: CredentialKeyStatus;
  /** 数据库中已保存的加密凭据条数（健康检查时用于判断缺 key 是否致命）。 */
  storedCredentials: number;
  message: string;
}

export interface CredentialKeyInspection {
  ok: boolean;
  status: "ok" | "missing" | "invalid";
  keyFile: string;
  message: string;
}

export interface StoredCredentialSample {
  userId: string;
  payload: string;
}

function keyFilePath(dataDir: string): string {
  return path.join(dataDir, CREDENTIAL_KEY_FILE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 权限收紧：Windows/FAT 等环境可能不支持 chmod，创建时已尽力使用 0600。 */
function tightenPermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 保留读取能力；不要因为无法 chmod 而让已有部署无法启动。
  }
}

/** 读取已有 key；不存在返回 null，存在但损坏直接抛错。 */
function readKeyFileIfPresent(file: string): Buffer | null {
  let key: Buffer;
  try {
    key = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`凭据密钥文件无法读取：${errorMessage(error)}`);
  }
  if (key.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `凭据密钥文件长度必须是 ${CREDENTIAL_KEY_BYTES} 字节，当前为 ${key.length}；请从备份恢复正确的 credentials.key。`,
    );
  }
  tightenPermissions(file);
  return key;
}

/**
 * 首次创建 key：先写同目录临时文件并 fsync，再尝试硬链接到最终路径。
 * 硬链接在目标存在时原子失败（EEXIST），避免并发创建时互相覆盖；不支持
 * 硬链接的文件系统退回 O_EXCL 独占创建。
 */
function atomicCreateKey(file: string): Buffer {
  fs.mkdirSync(path.dirname(file) || ".", { recursive: true });
  const key = crypto.randomBytes(CREDENTIAL_KEY_BYTES);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try {
      fs.linkSync(tmp, file);
      tightenPermissions(file);
      return key;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const existing = readKeyFileIfPresent(file);
        if (!existing) throw new Error("凭据密钥文件创建竞争失败，请重试。");
        return existing;
      }
      if (
        code !== "EPERM" &&
        code !== "EINVAL" &&
        code !== "ENOTSUP" &&
        code !== "ENOSYS" &&
        code !== "EXDEV"
      ) {
        throw error;
      }
      // 部分网络卷/文件系统不支持硬链接。
      try {
        fs.writeFileSync(file, key, { flag: "wx", mode: 0o600 });
        tightenPermissions(file);
        return key;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "EEXIST") throw fallbackError;
        const existing = readKeyFileIfPresent(file);
        if (!existing) throw new Error("凭据密钥文件创建竞争失败，请重试。");
        return existing;
      }
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不覆盖原始异常。
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 临时文件清理失败不影响已经发布的 key。
    }
  }
}

/**
 * 读取密钥。create=true 仅在确实允许初始化新密钥时使用；已有密文时调用方
 * 必须先确认 key 存在，绝不能因缺失而生成新 key 覆盖旧密钥。
 */
function readKeyFile(file: string, create: boolean): Buffer {
  const existing = readKeyFileIfPresent(file);
  if (existing) return existing;
  if (!create) {
    throw new Error("凭据密钥文件缺失，无法读取已保存的个人配置；请从备份恢复 credentials.key。");
  }
  return atomicCreateKey(file);
}

function aad(userId: string): Buffer {
  return Buffer.from(`zhixu-credentials:v1:${userId}`, "utf8");
}

function encryptWithKey(key: Buffer, userId: string, settings: ProviderSettings): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(settings), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

function decryptWithKey(key: Buffer, userId: string, payload: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("凭据密文格式损坏。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("凭据密文格式损坏。");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.iv !== "string" ||
    typeof record.tag !== "string" ||
    typeof record.data !== "string"
  ) {
    throw new Error("凭据密文版本或字段无效。");
  }
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("凭据密文 IV/tag 无效。");

  let plaintext: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.data, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new Error("凭据密钥与密文不匹配或密文已损坏，无法解密。");
  }

  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("凭据解密结果不是合法的 JSON。");
  }
}

export class CredentialVault {
  constructor(private readonly dataDir: string) {}

  /**
   * 保存前使用：已有密文时只读取现有 key 并先验证能解密既有样本；
   * 缺 key/损坏/key 被替换都会显式失败，绝不生成新 key 覆盖旧数据。
   */
  encryptForStore(
    userId: string,
    settings: ProviderSettings,
    existing: StoredCredentialSample | undefined,
  ): string {
    const file = keyFilePath(this.dataDir);
    let key: Buffer;
    if (existing) {
      try {
        key = readKeyFile(file, false);
      } catch (error) {
        throw new Error(
          `已有加密凭据，但${errorMessage(error)}已拒绝保存新的个人配置，以免产生无法恢复的数据。`,
        );
      }
      try {
        decryptWithKey(key, existing.userId, existing.payload);
      } catch (error) {
        throw new Error(
          `已有加密凭据无法用当前凭据密钥解密（${errorMessage(error)}），` +
            "已拒绝保存新的个人配置，以免产生无法恢复的数据。请从备份恢复正确的 credentials.key 后重试。",
        );
      }
    } else {
      key = readKeyFile(file, true);
    }

    return this.sealWithCurrentKey(key, userId, settings);
  }

  encrypt(userId: string, settings: ProviderSettings): string {
    const key = readKeyFile(keyFilePath(this.dataDir), true);
    return this.sealWithCurrentKey(key, userId, settings);
  }

  /** 加密后确认 key 文件仍是同一把 key，避免写入重启后无法解密的密文。 */
  private sealWithCurrentKey(
    key: Buffer,
    userId: string,
    settings: ProviderSettings,
  ): string {
    const payload = encryptWithKey(key, userId, settings);
    const current = readKeyFileIfPresent(keyFilePath(this.dataDir));
    if (!current || !current.equals(key)) {
      throw new Error(
        "凭据密钥在保存过程中被删除或替换，已拒绝写入新的个人配置，以免产生无法恢复的数据。",
      );
    }
    return payload;
  }

  decrypt(userId: string, payload: string): unknown {
    const key = readKeyFile(keyFilePath(this.dataDir), false);
    return decryptWithKey(key, userId, payload);
  }

  /** 验证当前 key 能解密指定既有密文；供保存前一致性检查使用。 */
  verifyExisting(userId: string, payload: string): void {
    const key = readKeyFile(keyFilePath(this.dataDir), false);
    decryptWithKey(key, userId, payload);
  }

  /** 只读检查 key 文件本身，不创建、不缓存。 */
  inspectKey(): CredentialKeyInspection {
    const keyFile = keyFilePath(this.dataDir);
    try {
      const key = readKeyFileIfPresent(keyFile);
      if (!key) {
        return {
          ok: false,
          status: "missing",
          keyFile,
          message: "凭据密钥文件不存在。",
        };
      }
      return { ok: true, status: "ok", keyFile, message: "凭据密钥可用。" };
    } catch (error) {
      return { ok: false, status: "invalid", keyFile, message: errorMessage(error) };
    }
  }

  /**
   * ready/健康检查：无凭据且无 key 是正常初始状态；有凭据但缺 key、
   * key 损坏或 key 与已保存密文不匹配均为不健康。
   */
  health(storedCredentials: number, sample?: StoredCredentialSample): CredentialKeyHealth {
    const inspected = this.inspectKey();
    if (inspected.status === "missing") {
      if (storedCredentials === 0) {
        return {
          ok: true,
          status: "not_initialized",
          storedCredentials,
          message: "尚未生成凭据密钥；首次保存个人配置时会创建。",
        };
      }
      return {
        ok: false,
        status: "missing",
        storedCredentials,
        message:
          `凭据密钥文件缺失，但数据库中有 ${storedCredentials} 条加密凭据，这些数据无法解密；` +
          "请从备份恢复 credentials.key。",
      };
    }
    if (inspected.status === "invalid") {
      return {
        ok: false,
        status: "invalid",
        storedCredentials,
        message:
          inspected.message +
          (storedCredentials > 0 ? `（数据库中有 ${storedCredentials} 条加密凭据）` : ""),
      };
    }
    if (storedCredentials > 0) {
      if (!sample) {
        return {
          ok: false,
          status: "mismatch",
          storedCredentials,
          message: "无法取得已保存凭据样本，无法确认当前凭据密钥是否匹配。",
        };
      }
      try {
        this.verifyExisting(sample.userId, sample.payload);
      } catch (error) {
        return {
          ok: false,
          status: "mismatch",
          storedCredentials,
          message: `当前凭据密钥无法解密已保存的数据：${errorMessage(error)}`,
        };
      }
    }
    return {
      ok: true,
      status: "ok",
      storedCredentials,
      message: "凭据密钥可用。",
    };
  }
}

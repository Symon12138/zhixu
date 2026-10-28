import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../src/types";
import { ZhixuDatabase } from "../server/db";
import { UserCredentialStore } from "../server/credentials";
import {
  CREDENTIAL_KEY_BYTES,
  CREDENTIAL_KEY_FILE,
  CredentialVault,
} from "../server/credentialVault";
import {
  createDatabaseBackup,
  parseBackupArgs,
  pruneBackups,
} from "../scripts/backup-db";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BACKUP_SCRIPT = path.join(REPO_ROOT, "scripts", "backup-db.ts");

const SETTINGS: ProviderSettings = {
  provider: "gemini",
  apiKey: "AIza-credential-secret",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
};

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function addUser(db: ZhixuDatabase, id: string): void {
  db.createUser({
    id,
    email: `${id}@example.com`,
    name: id,
    passwordHash: "test-password-hash",
    passwordSalt: "test-password-salt",
  });
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function nonTempFiles(dir: string): string[] {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => !name.endsWith(".tmp"))
    : [];
}

function runBackupCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  // 避免测试运行器的 tsx loader 再次注入到显式 `node tsx-cli script` 子进程。
  delete childEnv.NODE_OPTIONS;
  return spawnSync(process.execPath, [TSX_CLI, BACKUP_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("凭据密钥：重启后可解密，跨账户 AAD 与密钥替换都会被拒绝", () => {
  const dir = tempDir("zhixu-vault-aad-");
  try {
    const vault = new CredentialVault(dir);
    const payload = vault.encrypt("user-a", SETTINGS);
    assert.deepEqual(new CredentialVault(dir).decrypt("user-a", payload), SETTINGS);
    assert.throws(() => vault.decrypt("user-b", payload), /不匹配|无法解密/);

    const keyPath = path.join(dir, CREDENTIAL_KEY_FILE);
    const originalKey = fs.readFileSync(keyPath);
    assert.equal(originalKey.length, CREDENTIAL_KEY_BYTES);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(keyPath).mode & 0o077, 0);
    }

    // 同一个 vault 实例（原先会被缓存掩盖）在 key 被替换后必须立即失败。
    fs.writeFileSync(keyPath, crypto.randomBytes(CREDENTIAL_KEY_BYTES), { mode: 0o600 });
    assert.throws(() => vault.decrypt("user-a", payload), /不匹配|无法解密/);

    fs.writeFileSync(keyPath, originalKey, { mode: 0o600 });
    assert.deepEqual(new CredentialVault(dir).decrypt("user-a", payload), SETTINGS);
  } finally {
    cleanup(dir);
  }
});

test("缺少凭据密钥时已有凭据拒绝保存，且不会生成新密钥", () => {
  const root = tempDir("zhixu-vault-missing-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
  try {
    addUser(db, "user-a");
    addUser(db, "user-b");
    const store = new UserCredentialStore(db, dataDir);
    store.save("user-a", SETTINGS);
    assert.equal(db.getCredentials("user-a")?.userId, "user-a");

    const keyPath = path.join(dataDir, CREDENTIAL_KEY_FILE);
    const originalKey = fs.readFileSync(keyPath);
    fs.rmSync(keyPath);

    assert.throws(
      () => store.save("user-b", { ...SETTINGS, apiKey: "AIza-new-secret" }),
      /密钥文件缺失|拒绝保存/,
    );
    assert.equal(fs.existsSync(keyPath), false, "保存失败时不得自动生成新密钥");
    assert.equal(db.countCredentials(), 1, "既有凭据行必须保留");
    assert.throws(() => store.get("user-a"), /密钥文件缺失/);

    const health = store.health();
    assert.equal(health.ok, false);
    assert.equal(health.status, "missing");
    assert.equal(health.storedCredentials, 1);

    // 恢复正确的 key 后，重启进程/重新构造 store 仍能读取并继续保存。
    fs.writeFileSync(keyPath, originalKey, { mode: 0o600 });
    assert.equal(store.get("user-a")?.settings.apiKey, SETTINGS.apiKey);
    store.save("user-b", { ...SETTINGS, apiKey: "AIza-user-b-secret" });
    assert.equal(store.get("user-b")?.settings.apiKey, "AIza-user-b-secret");
    assert.equal(store.health().status, "ok");
  } finally {
    db.close();
    cleanup(root);
  }
});

test("密钥被替换或损坏后缓存不掩盖，保存被拒绝且健康检查失败", () => {
  const root = tempDir("zhixu-vault-replaced-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
  try {
    addUser(db, "user-a");
    addUser(db, "user-b");
    const store = new UserCredentialStore(db, dataDir);
    store.save("user-a", SETTINGS);

    const keyPath = path.join(dataDir, CREDENTIAL_KEY_FILE);
    const originalKey = fs.readFileSync(keyPath);

    fs.writeFileSync(keyPath, crypto.randomBytes(CREDENTIAL_KEY_BYTES), { mode: 0o600 });
    assert.throws(() => store.get("user-a"), /不匹配|无法解密/);
    assert.throws(
      () => store.save("user-b", { ...SETTINGS, apiKey: "AIza-after-replace" }),
      /无法用当前凭据密钥解密|拒绝保存/,
    );
    assert.equal(db.countCredentials(), 1);
    const mismatched = store.health();
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.status, "mismatch");

    fs.writeFileSync(keyPath, Buffer.from("broken"), { mode: 0o600 });
    assert.throws(
      () => store.save("user-b", { ...SETTINGS, apiKey: "AIza-after-corrupt" }),
      /长度|拒绝保存/,
    );
    assert.equal(db.countCredentials(), 1);
    assert.equal(fs.readFileSync(keyPath).toString("utf8"), "broken");
    const invalid = store.health();
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, "invalid");

    fs.writeFileSync(keyPath, originalKey, { mode: 0o600 });
    const restored = store.health();
    assert.equal(restored.ok, true);
    assert.equal(restored.status, "ok");
    assert.equal(store.get("user-a")?.settings.apiKey, SETTINGS.apiKey);
  } finally {
    db.close();
    cleanup(root);
  }
});

test("损坏的密钥文件不会被静默重建", () => {
  const dir = tempDir("zhixu-vault-broken-");
  try {
    const keyPath = path.join(dir, CREDENTIAL_KEY_FILE);
    const broken = Buffer.from("not-a-valid-key");
    fs.writeFileSync(keyPath, broken, { mode: 0o600 });
    const vault = new CredentialVault(dir);
    assert.throws(() => vault.encrypt("user-a", SETTINGS), /长度/);
    assert.deepEqual(fs.readFileSync(keyPath), broken);
  } finally {
    cleanup(dir);
  }
});

test("尚无凭据时缺密钥是正常初始状态，健康检查不会创建密钥", () => {
  const root = tempDir("zhixu-vault-empty-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
  try {
    const health = new UserCredentialStore(db, dataDir).health();
    assert.equal(health.ok, true);
    assert.equal(health.status, "not_initialized");
    assert.equal(health.storedCredentials, 0);
    assert.equal(fs.existsSync(path.join(dataDir, CREDENTIAL_KEY_FILE)), false);
  } finally {
    db.close();
    cleanup(root);
  }
});

test("备份同时包含数据库与可解密密钥，恢复后凭据可读", () => {
  const root = tempDir("zhixu-backup-roundtrip-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
  let dbClosed = false;
  try {
    addUser(db, "user-a");
    const store = new UserCredentialStore(db, dataDir);
    store.save("user-a", SETTINGS);
    const sourceKey = fs.readFileSync(path.join(dataDir, CREDENTIAL_KEY_FILE));

    const outDir = path.join(root, "backups");
    const result = createDatabaseBackup({ dataDir, outDir, retention: 0 });
    assert.equal(result.credentialRows, 1);
    const keyBackup = result.credentialKey;
    assert.ok(keyBackup, "有加密凭据时备份必须包含密钥文件");

    const manifest = JSON.parse(fs.readFileSync(result.manifest, "utf8")) as {
      format: string;
      version: number;
      stamp: string;
      credentialRows: number;
      database: { file: string; sha256: string };
      credentialKey: { file: string; sha256: string } | null;
    };
    assert.equal(manifest.format, "zhixu-db-backup");
    assert.equal(manifest.version, 1);
    assert.equal(manifest.stamp, result.stamp);
    assert.equal(manifest.credentialRows, 1);
    assert.equal(manifest.database.file, path.basename(result.database));
    assert.equal(manifest.database.sha256, sha256(result.database));
    const manifestKey = manifest.credentialKey;
    assert.ok(manifestKey, "manifest 必须记录配套密钥文件");
    assert.equal(manifestKey.file, path.basename(keyBackup));
    assert.equal(manifestKey.sha256, sha256(keyBackup));
    assert.deepEqual(fs.readFileSync(keyBackup), sourceKey);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(keyBackup).mode & 0o777, 0o600);
      assert.equal(fs.statSync(result.database).mode & 0o777, 0o600);
      assert.equal(fs.statSync(result.manifest).mode & 0o777, 0o600);
      assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
    }
    assert.deepEqual(
      nonTempFiles(outDir).sort(),
      [
        `zhixu-${result.stamp}.db`,
        `zhixu-${result.stamp}.credentials.key`,
        `zhixu-${result.stamp}.manifest.json`,
      ].sort(),
    );

    // 源数据目录整体移除后，仅用备份集恢复仍必须能解密。
    db.close();
    dbClosed = true;
    cleanup(dataDir);

    const restoredDir = path.join(root, "restored");
    fs.mkdirSync(restoredDir);
    fs.copyFileSync(result.database, path.join(restoredDir, "zhixu.db"));
    fs.copyFileSync(keyBackup, path.join(restoredDir, CREDENTIAL_KEY_FILE));
    const restoredDb = new ZhixuDatabase(path.join(restoredDir, "zhixu.db"));
    try {
      const restoredStore = new UserCredentialStore(restoredDb, restoredDir);
      const loaded = restoredStore.get("user-a");
      assert.equal(loaded?.settings.apiKey, SETTINGS.apiKey);
      assert.equal(loaded?.settings.model, SETTINGS.model);
      assert.equal(restoredStore.health().ok, true);
    } finally {
      restoredDb.close();
    }
  } finally {
    if (!dbClosed) db.close();
    cleanup(root);
  }
});

test("有加密凭据但缺密钥或密钥损坏时备份显式失败且不留半成品", () => {
  const root = tempDir("zhixu-backup-no-key-");
  const makeSource = (name: string): { dataDir: string; outDir: string; db: ZhixuDatabase } => {
    const dataDir = path.join(root, name, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
    addUser(db, "user-a");
    new UserCredentialStore(db, dataDir).save("user-a", SETTINGS);
    return { dataDir, outDir: path.join(root, name, "backups"), db };
  };
  try {
    const missing = makeSource("missing");
    try {
      const keyPath = path.join(missing.dataDir, CREDENTIAL_KEY_FILE);
      fs.rmSync(keyPath);
      assert.throws(
        () =>
          createDatabaseBackup({
            dataDir: missing.dataDir,
            outDir: missing.outDir,
            retention: 0,
          }),
        /凭据密钥文件缺失|已取消备份/,
      );
      assert.equal(fs.existsSync(keyPath), false, "备份脚本不得生成新密钥");
      assert.deepEqual(nonTempFiles(missing.outDir), []);
      assert.equal(missing.db.countCredentials(), 1);
    } finally {
      missing.db.close();
    }

    const wrongLength = makeSource("wrong-length");
    try {
      const keyPath = path.join(wrongLength.dataDir, CREDENTIAL_KEY_FILE);
      fs.writeFileSync(keyPath, Buffer.from("broken"), { mode: 0o600 });
      assert.throws(
        () =>
          createDatabaseBackup({
            dataDir: wrongLength.dataDir,
            outDir: wrongLength.outDir,
            retention: 0,
          }),
        /长度|拒绝生成无法恢复的备份/,
      );
      assert.equal(fs.readFileSync(keyPath).toString("utf8"), "broken");
      assert.deepEqual(nonTempFiles(wrongLength.outDir), []);
    } finally {
      wrongLength.db.close();
    }

    const mismatched = makeSource("mismatched");
    try {
      const keyPath = path.join(mismatched.dataDir, CREDENTIAL_KEY_FILE);
      const wrongKey = crypto.randomBytes(CREDENTIAL_KEY_BYTES);
      fs.writeFileSync(keyPath, wrongKey, { mode: 0o600 });
      assert.throws(
        () =>
          createDatabaseBackup({
            dataDir: mismatched.dataDir,
            outDir: mismatched.outDir,
            retention: 0,
          }),
        /无法解密|拒绝生成无法恢复的备份/,
      );
      assert.deepEqual(fs.readFileSync(keyPath), wrongKey);
      assert.deepEqual(nonTempFiles(mismatched.outDir), []);
      assert.equal(mismatched.db.countCredentials(), 1);
    } finally {
      mismatched.db.close();
    }
  } finally {
    cleanup(root);
  }
});

test("没有个人凭据时备份成功，manifest 明确记录无密钥", () => {
  const root = tempDir("zhixu-backup-empty-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
  try {
    db.close();
    const result = createDatabaseBackup({
      dataDir,
      outDir: path.join(root, "backups"),
      retention: 0,
    });
    assert.equal(result.credentialRows, 0);
    assert.equal(result.credentialKey, null);
    const manifest = JSON.parse(fs.readFileSync(result.manifest, "utf8")) as {
      credentialKey: unknown;
      credentialRows: number;
    };
    assert.equal(manifest.credentialKey, null);
    assert.equal(manifest.credentialRows, 0);
  } finally {
    try {
      db.close();
    } catch {
      // 已关闭。
    }
    cleanup(root);
  }
});

test("没有个人凭据但密钥已存在时仍备份密钥", () => {
  const root = tempDir("zhixu-backup-key-only-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const key = crypto.randomBytes(CREDENTIAL_KEY_BYTES);
  fs.writeFileSync(path.join(dataDir, CREDENTIAL_KEY_FILE), key, { mode: 0o600 });
  const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
  const outDir = path.join(root, "backups");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
  if (process.platform !== "win32") fs.chmodSync(outDir, 0o755);
  try {
    db.close();
    const result = createDatabaseBackup({
      dataDir,
      outDir,
      retention: 0,
    });
    assert.equal(result.credentialRows, 0);
    const keyBackup = result.credentialKey;
    assert.ok(keyBackup, "已存在的密钥即使暂时没有凭据也必须备份");
    assert.deepEqual(fs.readFileSync(keyBackup), key);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(result.database).mode & 0o777, 0o600);
      assert.equal(fs.statSync(keyBackup).mode & 0o777, 0o600);
      assert.equal(fs.statSync(result.manifest).mode & 0o777, 0o600);
    }
    const manifest = JSON.parse(fs.readFileSync(result.manifest, "utf8")) as {
      credentialKey: { file: string; sha256: string } | null;
    };
    const manifestKey = manifest.credentialKey;
    assert.ok(manifestKey);
    assert.equal(manifestKey.file, path.basename(keyBackup));
    assert.equal(manifestKey.sha256, sha256(keyBackup));
  } finally {
    try {
      db.close();
    } catch {
      // 已关闭。
    }
    cleanup(root);
  }
});

test("保留清理按 stamp 成组删除 db/key/manifest，并保留 0 不清语义", () => {
  const outDir = tempDir("zhixu-backup-retention-");
  try {
    const stamps = ["2026-01-01_00-00-00", "2026-01-02_00-00-00", "2026-01-03_00-00-00"];
    for (const stamp of stamps) {
      for (const suffix of [".db", ".credentials.key", ".manifest.json"]) {
        fs.writeFileSync(path.join(outDir, `zhixu-${stamp}${suffix}`), `${stamp}${suffix}`);
      }
    }
    const unrelated = path.join(outDir, "notes.txt");
    fs.writeFileSync(unrelated, "keep");

    const removed = pruneBackups(outDir, 2);
    assert.deepEqual(removed, [stamps[0]]);
    for (const suffix of [".db", ".credentials.key", ".manifest.json"]) {
      assert.equal(fs.existsSync(path.join(outDir, `zhixu-${stamps[0]}${suffix}`)), false);
      assert.equal(fs.existsSync(path.join(outDir, `zhixu-${stamps[1]}${suffix}`)), true);
      assert.equal(fs.existsSync(path.join(outDir, `zhixu-${stamps[2]}${suffix}`)), true);
    }
    assert.equal(fs.existsSync(unrelated), true);

    // 孤立 key（没有对应 db）也必须被配套清理，且不能挤占真实备份的保留名额。
    const orphanStamp = "2026-01-04_00-00-00";
    const orphanKey = path.join(outDir, `zhixu-${orphanStamp}.credentials.key`);
    fs.writeFileSync(orphanKey, "orphan");
    assert.deepEqual(pruneBackups(outDir, 2), [orphanStamp]);
    assert.equal(fs.existsSync(orphanKey), false);

    const keptBeforeZero = nonTempFiles(outDir).length;
    assert.deepEqual(pruneBackups(outDir, 0), []);
    assert.equal(nonTempFiles(outDir).length, keptBeforeZero);
    assert.throws(() => pruneBackups(outDir, -1), /非负整数/);
  } finally {
    cleanup(outDir);
  }
});

test("备份参数：--retention 0 生效，缺值/非法值/未知参数明确报错", () => {
  const env = { ZHIXU_DATA_DIR: path.join(os.tmpdir(), "zhixu-args-data") };
  const zero = parseBackupArgs(["--retention", "0"], env);
  assert.equal(zero.retention, 0);
  assert.equal(zero.dataDir, path.resolve(env.ZHIXU_DATA_DIR));
  assert.equal(zero.outDir, path.join(path.resolve(env.ZHIXU_DATA_DIR), "backups"));
  assert.equal(parseBackupArgs([], env).retention, 14);

  const custom = parseBackupArgs(["--out", "relative-backups", "--retention", "3"], env);
  assert.equal(custom.outDir, path.resolve("relative-backups"));
  assert.equal(custom.retention, 3);

  assert.throws(() => parseBackupArgs(["--retention"], env), /缺少保留数量/);
  assert.throws(() => parseBackupArgs(["--retention", "-1"], env), /非负整数/);
  assert.throws(() => parseBackupArgs(["--retention", "abc"], env), /非负整数/);
  assert.throws(() => parseBackupArgs(["--out"], env), /缺少目录值/);
  assert.throws(() => parseBackupArgs(["--unknown"], env), /未知参数/);
});

test("备份脚本 CLI：打印实际数据目录并以非零码报告缺失数据库/参数/密钥", () => {
  const root = tempDir("zhixu-backup-cli-");
  try {
    const emptyDataDir = path.join(root, "empty-data");
    fs.mkdirSync(emptyDataDir);
    const missingDb = runBackupCli(
      ["--out", path.join(root, "out-a"), "--retention", "0"],
      { ZHIXU_DATA_DIR: emptyDataDir },
    );
    assert.equal(missingDb.status, 1);
    assert.ok(missingDb.stdout.includes("数据目录："));
    assert.ok(missingDb.stdout.includes(path.resolve(emptyDataDir)));
    assert.match(missingDb.stderr, /找不到数据库文件/);
    assert.equal(fs.existsSync(path.join(emptyDataDir, "zhixu.db")), false);

    const missingValue = runBackupCli(["--retention"], { ZHIXU_DATA_DIR: emptyDataDir });
    assert.equal(missingValue.status, 1);
    assert.match(missingValue.stderr, /缺少保留数量/);

    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir);
    const db = new ZhixuDatabase(path.join(dataDir, "zhixu.db"));
    try {
      addUser(db, "user-a");
      new UserCredentialStore(db, dataDir).save("user-a", SETTINGS);
    } finally {
      db.close();
    }
    fs.rmSync(path.join(dataDir, CREDENTIAL_KEY_FILE));
    const outDir = path.join(root, "out-b");
    const missingKey = runBackupCli(
      ["--out", outDir, "--retention", "0"],
      { ZHIXU_DATA_DIR: dataDir },
    );
    assert.equal(missingKey.status, 1);
    assert.match(missingKey.stderr, /凭据密钥文件缺失|已取消备份/);
    assert.deepEqual(nonTempFiles(outDir), []);
  } finally {
    cleanup(root);
  }
});

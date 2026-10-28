import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Request } from "express";
import {
  loadAiRuntimeConfig,
  loadConfig,
  loadWebConfig,
  type Env,
} from "../server/config";
import {
  LATEST_SCHEMA_VERSION,
  ZhixuDatabase,
  inspectDatabaseHealth,
  migrateDatabase,
} from "../server/db";
import { auditRequest } from "../server/security";
import { runProductionChecks } from "../scripts/check-production-env";
import { isDirectExecution } from "../scripts/cli";

const PRODUCTION_ENV: Env = {
  ZHIXU_PUBLIC_ORIGIN: "https://study.example.com",
  ZHIXU_HOST: "127.0.0.1",
  ZHIXU_PORT: "3001",
  ZHIXU_TRUST_PROXY: "true",
  ZHIXU_AUTH_REQUIRED: "true",
  ZHIXU_ALLOW_BYOK: "false",
  ZHIXU_COOKIE_SECURE: "true",
  ZHIXU_AUDIT_RETENTION_DAYS: "90",
  ZHIXU_USAGE_RETENTION_DAYS: "90",
  GEMINI_API_KEY: "test-gemini-key",
  ZHIXU_WEB_FETCH: "false",
  ZHIXU_WEB_SEARCH: "false",
};

function productionEnv(overrides: Env = {}): Env {
  return { ...PRODUCTION_ENV, ...overrides };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-production-config-"));
}

function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row && "user_version" in row ? row.user_version : undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`无法读取 user_version：${String(value)}`);
  }
  return value;
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = tempDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("生产配置：合理环境通过，预检退出码为 0", () => {
  withTempDir((dir) => {
    const env = productionEnv({ ZHIXU_DATA_DIR: dir });
    const config = loadConfig(true, env);
    assert.equal(config.production, true);
    assert.equal(config.publicOrigin, "https://study.example.com");
    assert.equal(config.authRequired, true);
    assert.equal(config.cookieSecure, true);
    assert.equal(config.auditRetentionDays, 90);
    assert.deepEqual(config.byokAllowedOrigins, []);

    const { exitCode, results } = runProductionChecks(env);
    assert.equal(exitCode, 0, JSON.stringify(results, null, 2));
    assert.equal(results.some((item) => !item.ok), false);
    assert.match(
      results.map((item) => item.message).join("\n"),
      /生产配置校验通过/,
    );
  });
});

test("生产配置：非法布尔、来源、白名单、保留期和网页/模型数值都直接失败", () => {
  const cases: Array<[Env, RegExp]> = [
    [{ ZHIXU_AUTH_REQUIRED: "false" }, /禁止 ZHIXU_AUTH_REQUIRED=false/],
    [{ ZHIXU_AUTH_REQUIRED: "maybe" }, /ZHIXU_AUTH_REQUIRED/],
    [{ ZHIXU_COOKIE_SECURE: "maybe" }, /ZHIXU_COOKIE_SECURE/],
    [{ ZHIXU_TRUST_PROXY: "yes" }, /ZHIXU_TRUST_PROXY/],
    [{ ZHIXU_PUBLIC_ORIGIN: "https://study.example.com/app" }, /不能包含路径/],
    [{ ZHIXU_PUBLIC_ORIGIN: "ftp://study.example.com" }, /http/],
    [{ ZHIXU_BYOK_BASEURLS: "https://example.test, not a url" }, /来源不是合法的 URL/],
    [{ ZHIXU_WEB_FETCH: "yes" }, /ZHIXU_WEB_FETCH/],
    [{ ZHIXU_WEB_SEARCH: "1" }, /ZHIXU_WEB_SEARCH/],
    [{ ZHIXU_WEB_ALLOWED_HOSTS: "https://example.com" }, /纯域名/],
    [{ ZHIXU_SEARCH_ORDER: "google" }, /不支持的搜索供应商/],
    [{ ZHIXU_WEB_MAX_BYTES: "0" }, /ZHIXU_WEB_MAX_BYTES/],
    [{ ZHIXU_WEB_MAX_TEXT: "999999" }, /ZHIXU_WEB_MAX_TEXT/],
    [{ ZHIXU_WEB_HOURLY_LIMIT: "0" }, /ZHIXU_WEB_HOURLY_LIMIT/],
    [{ ZHIXU_AUDIT_RETENTION_DAYS: "0" }, /保留天数/],
    [{ ZHIXU_USAGE_RETENTION_DAYS: "abc" }, /整数/],
    [{ AI_MODEL_CALL_TIMEOUT_MS: "999" }, /AI_MODEL_CALL_TIMEOUT_MS/],
    [{ AI_MAX_OUTPUT_TOKENS: "99999" }, /AI_MAX_OUTPUT_TOKENS/],
    [{ AI_STRUCTURED_OUTPUT: "1" }, /AI_STRUCTURED_OUTPUT/],
    [{ AI_THINKING_LEVEL: "max" }, /AI_THINKING_LEVEL/],
    [{ AI_REVIEW_THINKING_LEVEL: "maximum" }, /AI_REVIEW_THINKING_LEVEL/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => loadConfig(true, productionEnv(overrides)),
      pattern,
      JSON.stringify(overrides),
    );
  }
});

test("生产配置：非法值让预检返回非零，且不修改全局 process.env", () => {
  const marker = process.env.ZHIXU_PUBLIC_ORIGIN;
  const dir = tempDir();
  try {
    const { exitCode, results } = runProductionChecks(
      productionEnv({
        ZHIXU_DATA_DIR: dir,
        ZHIXU_WEB_FETCH: "yes",
        ZHIXU_PUBLIC_ORIGIN: "https://study.example.com/private",
      }),
    );
    assert.equal(exitCode, 1);
    assert.ok(results.some((item) => !item.ok && /生产配置无效/.test(item.message)));
    assert.equal(process.env.ZHIXU_PUBLIC_ORIGIN, marker);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("生产预检：BYOK 空白名单仍可通过，但给出明确的配置提示", () => {
  const dir = tempDir();
  try {
    const { exitCode, results } = runProductionChecks(
      productionEnv({
        ZHIXU_DATA_DIR: dir,
        GEMINI_API_KEY: "",
        OPENAI_API_KEY: "",
        ZHIXU_ALLOW_BYOK: "true",
        ZHIXU_BYOK_BASEURLS: "",
      }),
    );
    assert.equal(exitCode, 0, JSON.stringify(results, null, 2));
    const text = results.map((item) => item.message).join("\n");
    assert.match(text, /ZHIXU_BYOK_BASEURLS/);
    assert.match(text, /官方 Gemini \/ OpenAI 端点/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("网页与模型配置：合法值被解析，非法值不回退默认值", () => {
  const web = loadWebConfig({
    ZHIXU_WEB_FETCH: "true",
    ZHIXU_WEB_SEARCH: "true",
    ZHIXU_WEB_ALLOWED_HOSTS: "Example.COM, docs.example.com, example.com",
    ZHIXU_WEB_MAX_BYTES: "100000",
    ZHIXU_WEB_MAX_TEXT: "10000",
    ZHIXU_WEB_TIMEOUT_MS: "5000",
    ZHIXU_WEB_HOURLY_LIMIT: "12",
    ZHIXU_SEARCH_ORDER: "brave,you",
  });
  assert.equal(web.fetchEnabled, true);
  assert.equal(web.searchEnabled, true);
  assert.deepEqual(web.allowedHosts, ["example.com", "docs.example.com"]);
  assert.equal(web.maxBytes, 100000);
  assert.equal(web.maxTextChars, 10000);
  assert.equal(web.timeoutMs, 5000);
  assert.equal(web.hourlyLimit, 12);
  assert.deepEqual(web.searchOrder, ["brave", "you"]);

  const ai = loadAiRuntimeConfig({
    AI_STRUCTURED_OUTPUT: "false",
    AI_DEBUG_TIMING: "true",
    AI_THINKING_LEVEL: "low",
    AI_REVIEW_THINKING_LEVEL: "high",
    AI_MODEL_CALL_TIMEOUT_MS: "30000",
    AI_MAX_OUTPUT_TOKENS: "1024",
  });
  assert.equal(ai.structuredOutput, false);
  assert.equal(ai.debugTiming, true);
  assert.equal(ai.thinkingLevel, "low");
  assert.equal(ai.reviewThinkingLevel, "high");
  assert.equal(ai.modelCallTimeoutMs, 30000);
  assert.equal(ai.maxOutputTokens, 1024);

  assert.throws(() => loadWebConfig({ ZHIXU_WEB_TIMEOUT_MS: "0" }), /ZHIXU_WEB_TIMEOUT_MS/);
  assert.throws(() => loadWebConfig({ ZHIXU_WEB_ALLOWED_HOSTS: "example.com:443" }), /纯域名/);
  assert.throws(() => loadWebConfig({ ZHIXU_SEARCH_ORDER: "you,,google" }), /google/);
  assert.throws(() => loadAiRuntimeConfig({ AI_STRUCTURED_OUTPUT: "yes" }), /AI_STRUCTURED_OUTPUT/);
  assert.throws(() => loadAiRuntimeConfig({ AI_MAX_OUTPUT_TOKENS: "0" }), /AI_MAX_OUTPUT_TOKENS/);
});

test("数据库迁移：旧 user_version=0 库升级且保留已有用户数据", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "zhixu.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      "INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("legacy-user", "legacy@example.com", "Legacy", "hash", "salt", 1);
    assert.equal(schemaVersionOf(legacy), 0);
    legacy.close();

    const db = new ZhixuDatabase(file);
    try {
      assert.equal(LATEST_SCHEMA_VERSION > 0, true);
      assert.equal(schemaVersionOf(db.db), LATEST_SCHEMA_VERSION);
      assert.equal(db.userByEmail("legacy@example.com")?.name, "Legacy");
      const health = db.schemaHealth();
      assert.equal(health.ok, true);
      assert.equal(health.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.deepEqual(health.missingTables, []);
      assert.ok(
        db.db
          .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='user_credentials'")
          .get(),
      );
    } finally {
      db.close();
    }

    const reopened = new ZhixuDatabase(file);
    try {
      assert.equal(reopened.userByEmail("legacy@example.com")?.id, "legacy-user");
      assert.equal(reopened.schemaHealth().ok, true);
      assert.equal(schemaVersionOf(reopened.db), LATEST_SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  });
});

test("数据库迁移：失败整体回滚，user_version 与表都不前进", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(
      () =>
        migrateDatabase(db, [
          "CREATE TABLE demo (id INTEGER PRIMARY KEY);",
          "CREATE TABLE broken (id INTEGER PRIMARY KEY) THIS IS NOT SQL;",
        ]),
      /数据库迁移失败/,
    );
    assert.equal(schemaVersionOf(db), 0);
    assert.equal(
      db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='demo'").get(),
      undefined,
    );
  } finally {
    db.close();
  }
});

test("数据库迁移：程序不支持更高版本时拒绝打开，健康检查能发现缺表", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateDatabase(db);
    assert.equal(inspectDatabaseHealth(db).ok, true);
    db.exec("DROP TABLE user_credentials;");
    const broken = inspectDatabaseHealth(db);
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.missingTables, ["user_credentials"]);
  } finally {
    db.close();
  }

  withTempDir((dir) => {
    const file = path.join(dir, "future.db");
    const future = new DatabaseSync(file);
    future.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1};`);
    future.close();
    assert.throws(() => new ZhixuDatabase(file), /高于当前程序支持/);
  });
});

test("审计日志：生产配置标记让 npm start（无 NODE_ENV）也输出脱敏审计", () => {
  withTempDir((dir) => {
    const db = new ZhixuDatabase(path.join(dir, "audit.db"));
    try {
      const lines: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      };
      try {
        // auditRequest 只读取 requestId 与本次响应的配置标记。
        const req = {
          requestId: "trace-audit-1",
          res: { locals: { zhixuProduction: true } },
        } as unknown as Request;
        auditRequest(db, req, "auth.login", "ok", "email=alice@example.com");
      } finally {
        console.log = original;
      }
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^\[audit\] /);
      assert.match(lines[0], /"requestId":"trace-audit-1"/);
      assert.match(lines[0], /"event":"auth\.login"/);
      assert.doesNotMatch(lines[0], /alice@example\.com/);
      assert.match(lines[0], /\[email\]/);
    } finally {
      db.close();
    }
  });
});

test("直接入口：file URL 解码与真实路径比较不依赖字符串拼接", () => {
  const file = path.join(os.tmpdir(), "zhixu entry", "check-production-env.ts");
  const url = pathToFileURL(file).href;
  assert.match(url, /%20/);
  assert.equal(isDirectExecution(url, file), true);
  assert.equal(isDirectExecution(url, `${file}.other`), false);
  assert.equal(isDirectExecution(url, ""), false);
  // POSIX 下 fileURLToPath 会保留绝对路径；上面的用例在 Linux CI 同样覆盖入口分支。
  const posixUrl = "file:///opt/zhixu/scripts/eval-teaching.ts";
  if (process.platform !== "win32") {
    assert.equal(
      isDirectExecution(posixUrl, "/opt/zhixu/scripts/eval-teaching.ts"),
      true,
    );
  }
});

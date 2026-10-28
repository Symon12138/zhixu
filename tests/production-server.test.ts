import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AuthResult, AuthUser, CloudWorkspace, ServerConfig, StudyBackup } from "../src/types";
import { createApp } from "../server/index";
import { resolveConfig } from "../server/ai";
import { loadConfig, normalizeOrigin, type AppConfig } from "../server/config";
import { SESSION_COOKIE_NAME, ZhixuDatabase, utcDay } from "../server/db";
import {
  hashToken,
  normalizeRecoveryCode,
  verifyPassword,
} from "../server/auth";
import { MAX_WORKSPACE_BYTES } from "../server/workspace";

/* ── 测试夹具：临时 SQLite + 真实 Express 实例 ───────────────────────── */

const PASSWORD = "correct horse battery";

interface Harness {
  readonly db: ZhixuDatabase;
  readonly base: string;
  client(): Client;
  close(): Promise<void>;
}

class Client {
  private cookie?: string;
  constructor(private readonly base: string) {}

  async request(
    pathname: string,
    init: {
      method?: string;
      body?: unknown;
      rawBody?: string;
      origin?: string;
      contentType?: string;
      csrf?: boolean;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (unsafe) {
      if (init.csrf !== false) headers["X-Zhixu-Request"] = "1";
      headers["Content-Type"] = init.contentType ?? "application/json";
    } else if (init.contentType) {
      headers["Content-Type"] = init.contentType;
    }
    if (init.origin) headers.Origin = init.origin;
    if (this.cookie) headers.Cookie = this.cookie;

    const body =
      init.rawBody !== undefined
        ? init.rawBody
        : init.body !== undefined
          ? JSON.stringify(init.body)
          : unsafe
            ? "{}"
            : undefined;

    const response = await fetch(this.base + pathname, { method, headers, body });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      for (const part of setCookie.split(/,(?=[^;]+?=)/)) {
        const pair = part.split(";")[0].trim();
        if (!pair.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
        const value = pair.slice(SESSION_COOKIE_NAME.length + 1);
        this.cookie = value ? `${SESSION_COOKIE_NAME}=${value}` : undefined;
      }
    }
    return response;
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  base: string,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  const url = new URL(base);
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(options.body));
  }
  const request = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: options.path,
      method: options.method,
      headers,
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    },
  );
  request.on("error", reject);
  if (options.body !== undefined) request.write(options.body);
  request.end();
  return promise;
}

const BASE_CONFIG: Omit<AppConfig, "dataDir"> = {
  production: false,
  port: 3001,
  host: "127.0.0.1",
  authRequired: true,
  allowByok: false,
  cookieSecure: false,
  publicOrigin: null,
  trustProxy: false,
  quotas: { chatPerDay: 40, diagnosticPerDay: 10, reviewPerDay: 30 },
  maxConcurrentAi: 2,
  auditRetentionDays: 90,
  usageRetentionDays: 90,
  byokAllowedOrigins: [],
  allowInsecureLocal: false,
};

async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-production-"));
  const config: AppConfig = { ...BASE_CONFIG, ...overrides, dataDir: dir };
  const db = new ZhixuDatabase(path.join(dir, "zhixu.db"));
  const app = createApp({ config, db, serveStatic: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  return {
    db,
    base,
    client: () => new Client(base),
    close: async () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
      await promise;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** 工作区响应必须带 serverTime，并返回剥离后的业务字段供既有断言使用。 */
async function workspaceBody(response: Response): Promise<CloudWorkspace> {
  const body = await bodyOf<CloudWorkspace & { serverTime?: unknown }>(response);
  assert.equal(typeof body.serverTime, "number");
  assert.ok(Number.isFinite(body.serverTime));
  assert.ok(Math.abs((body.serverTime as number) - Date.now()) < 60_000);
  const { serverTime: _serverTime, ...workspace } = body;
  return workspace;
}

interface ErrorBody {
  error?: string;
  code?: string;
}

type RegisterBody = AuthResult & ErrorBody;

async function register(
  client: Client,
  overrides: { email?: string; name?: string; password?: string } = {},
): Promise<{ response: Response; body: RegisterBody }> {
  const response = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      email: overrides.email ?? "alice@example.com",
      name: overrides.name ?? "Alice",
      password: overrides.password ?? PASSWORD,
    },
  });
  return { response, body: (await response.json()) as RegisterBody };
}

function rows(db: ZhixuDatabase, sql: string, ...params: Array<string | number | null>) {
  return db.db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
}

function backupFixture(overrides: Partial<StudyBackup> = {}): StudyBackup {
  return {
    format: "zhixu-study-backup",
    version: 1,
    exportedAt: 1_700_000_000_000,
    sessions: [],
    notes: [],
    reviews: [],
    diagnostics: [],
    settingsWithoutSecrets: {
      provider: "gemini",
      model: "gemini-2.5-flash",
      baseUrl: "",
    },
    activity: [],
    ...overrides,
  };
}

async function withAiKeysCleared<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    return await fn();
  } finally {
    if (saved.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.GEMINI_API_KEY;
    if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
  }
}

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "start",
    topic: "二分查找",
    level: "初学",
    goal: "理解边界",
    messages: [{ role: "user", content: "开始学习二分查找" }],
    ...overrides,
  };
}

function cookieToken(setCookie: string): string {
  const pair = setCookie.split(";")[0];
  assert.ok(pair.startsWith(`${SESSION_COOKIE_NAME}=`));
  return pair.slice(SESSION_COOKIE_NAME.length + 1);
}

/* ── 注册 / 登录 / 会话 ─────────────────────────────────────────── */

test("注册：邮箱规范化、scrypt 加盐哈希、只存会话哈希、一次性恢复码与 Cookie 属性", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    const { response, body } = await register(client, {
      email: "  Alice@Example.COM ",
      name: "  Alice  ",
    });
    assert.equal(response.status, 200);
    assert.equal(body.user.email, "alice@example.com");
    assert.equal(body.user.name, "Alice");
    assert.equal(typeof body.user.createdAt, "number");
    assert.equal(body.revision, 0);
    assert.equal(body.data, null);
    const recoveryCode = body.recoveryCode;
    assert.ok(recoveryCode);
    assert.match(recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);

    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=2592000/);
    assert.doesNotMatch(setCookie, /;\s*Secure/);

    const token = cookieToken(setCookie);
    const user = harness.db.userByEmail("alice@example.com");
    assert.ok(user);
    assert.notEqual(user.passwordHash, PASSWORD);
    assert.match(user.passwordHash, /^scrypt\$16384\$8\$1\$/);
    assert.match(user.passwordSalt, /^[0-9a-f]{32}$/);
    assert.equal(await verifyPassword(PASSWORD, user), true);
    assert.equal(await verifyPassword("wrong password!", user), false);

    const sessions = rows(harness.db, "SELECT token_hash FROM sessions");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].token_hash, hashToken(token));
    assert.notEqual(sessions[0].token_hash, token);

    const recovery = rows(harness.db, "SELECT code_hash FROM recovery_codes");
    assert.equal(recovery.length, 1);
    assert.equal(
      recovery[0].code_hash,
      crypto
        .createHash("sha256")
        .update(normalizeRecoveryCode(recoveryCode), "utf8")
        .digest("hex"),
    );
    assert.notEqual(recovery[0].code_hash, body.recoveryCode);

    const me = await client.request("/api/auth/me");
    assert.equal(me.status, 200);
    const meBody = await bodyOf<AuthUser>(me);
    assert.equal(meBody.email, "alice@example.com");

    const other = harness.client();
    await register(other, { email: "bob@example.com", name: "Bob" });
    const bob = harness.db.userByEmail("bob@example.com");
    assert.ok(bob);
    assert.notEqual(bob.passwordSalt, user.passwordSalt);
    assert.notEqual(bob.passwordHash, user.passwordHash);

    // 审计只记录哈希/事件，不写邮箱、密码或恢复码。
    const audits = rows(harness.db, "SELECT event, detail FROM audit_log");
    assert.ok(audits.length > 0);
    const auditText = JSON.stringify(audits);
    assert.doesNotMatch(auditText, /alice@example\.com/);
    assert.doesNotMatch(auditText, /correct horse battery/);
    assert.equal(auditText.includes(recoveryCode), false);

    const anonymousMe = await harness.client().request("/api/auth/me");
    assert.equal(anonymousMe.status, 401);
  } finally {
    await harness.close();
  }
});

test("注册与登录：重复邮箱 409、密码长度限制、凭证错误统一 401", async () => {
  const harness = await startHarness();
  try {
    await register(harness.client());
    const duplicate = await register(harness.client(), { email: "ALICE@example.com" });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "email_taken");

    const tooShort = await register(harness.client(), {
      email: "short@example.com",
      password: "123456789",
    });
    assert.equal(tooShort.response.status, 400);
    assert.match(String(tooShort.body.error ?? ""), /至少需要 10 个字符/);

    const tooLong = await register(harness.client(), {
      email: "long@example.com",
      password: "p".repeat(257),
    });
    assert.equal(tooLong.response.status, 400);
    assert.match(String(tooLong.body.error ?? ""), /最多 256 个字符/);

    const wrong = await harness.client().request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: "not the password" },
    });
    const unknown = await harness.client().request("/api/auth/login", {
      method: "POST",
      body: { email: "nobody@example.com", password: "not the password" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    const wrongBody = await bodyOf<{ error: string }>(wrong);
    const unknownBody = await bodyOf<{ error: string }>(unknown);
    assert.equal(wrongBody.error, unknownBody.error);

    const loginClient = harness.client();
    const login = await loginClient.request("/api/auth/login", {
      method: "POST",
      body: { email: "  ALICE@EXAMPLE.COM ", password: PASSWORD },
    });
    assert.equal(login.status, 200);
    const loginBody = await bodyOf<AuthResult & { serverTime?: unknown }>(login);
    assert.equal(loginBody.user.email, "alice@example.com");
    assert.equal(typeof loginBody.serverTime, "number");
    assert.ok(Number.isFinite(loginBody.serverTime));
    assert.ok(
      Math.abs((loginBody.serverTime as number) - Date.now()) < 60_000,
      "登录响应必须携带服务端时间供客户端首次同步校准",
    );
    const me = await loginClient.request("/api/auth/me");
    assert.equal(me.status, 200);

    const auditText = JSON.stringify(rows(harness.db, "SELECT event, detail FROM audit_log"));
    assert.doesNotMatch(auditText, /alice@example\.com/);
    assert.doesNotMatch(auditText, /not the password/);
    assert.equal(auditText.includes("email_hash="), true);
  } finally {
    await harness.close();
  }
});

test("恢复码：一次性使用、轮换新码、撤销全部会话、旧密码失效", async () => {
  const harness = await startHarness();
  try {
    const first = harness.client();
    const registered = await register(first);
    const oldCode = registered.body.recoveryCode;
    assert.ok(oldCode);

    const second = harness.client();
    const secondLogin = await second.request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: PASSWORD },
    });
    assert.equal(secondLogin.status, 200);
    assert.equal(rows(harness.db, "SELECT token_hash FROM sessions").length, 2);

    const recoveryClient = harness.client();
    const recovery = await recoveryClient.request("/api/auth/recover", {
      method: "POST",
      body: {
        email: "alice@example.com",
        recoveryCode: oldCode,
        password: "brand new passphrase",
      },
    });
    assert.equal(recovery.status, 200);
    const recovered = await bodyOf<AuthResult>(recovery);
    const nextCode = recovered.recoveryCode;
    assert.ok(nextCode);
    assert.notEqual(nextCode, oldCode);
    assert.equal(recovered.user.email, "alice@example.com");

    assert.equal((await first.request("/api/auth/me")).status, 401);
    assert.equal((await second.request("/api/auth/me")).status, 401);
    assert.equal((await recoveryClient.request("/api/auth/me")).status, 200);
    assert.equal(rows(harness.db, "SELECT token_hash FROM sessions").length, 1);

    const oldPassword = await harness.client().request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: PASSWORD },
    });
    assert.equal(oldPassword.status, 401);
    const newPassword = await harness.client().request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: "brand new passphrase" },
    });
    assert.equal(newPassword.status, 200);

    const reuse = await harness.client().request("/api/auth/recover", {
      method: "POST",
      body: {
        email: "alice@example.com",
        recoveryCode: oldCode,
        password: "yet another passphrase",
      },
    });
    assert.equal(reuse.status, 401);

    const codes = rows(harness.db, "SELECT code_hash FROM recovery_codes");
    assert.equal(codes.length, 1);
    assert.equal(
      codes[0].code_hash,
      crypto
        .createHash("sha256")
        .update(normalizeRecoveryCode(nextCode), "utf8")
        .digest("hex"),
    );
  } finally {
    await harness.close();
  }
});

test("恢复码轮换：登录后凭当前密码生成新码，旧码立即失效", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    const registered = await register(client);
    const oldCode = registered.body.recoveryCode;
    assert.ok(oldCode);

    const wrong = await client.request("/api/auth/recovery-code", {
      method: "POST",
      body: { password: "wrong password" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(rows(harness.db, "SELECT * FROM recovery_codes").length, 1);

    const rotated = await client.request("/api/auth/recovery-code", {
      method: "POST",
      body: { password: PASSWORD },
    });
    assert.equal(rotated.status, 200);
    const newCode = (await bodyOf<{ recoveryCode: string }>(rotated)).recoveryCode;
    assert.match(newCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    assert.notEqual(newCode, oldCode);
    assert.equal(rows(harness.db, "SELECT * FROM recovery_codes").length, 1);

    const anonymous = await harness.client();
    const oldAttempt = await anonymous.request("/api/auth/recover", {
      method: "POST",
      body: {
        email: "alice@example.com",
        recoveryCode: oldCode,
        password: "AnotherGoodPass10!",
      },
    });
    assert.equal(oldAttempt.status, 401);
  } finally {
    await harness.close();
  }
});

test("退出登录与退出全部设备：会话删除且 Cookie 清除", async () => {
  const harness = await startHarness();
  try {
    const first = harness.client();
    await register(first);
    const second = harness.client();
    const login = await second.request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(rows(harness.db, "SELECT token_hash FROM sessions").length, 2);

    const logout = await first.request("/api/auth/logout", { method: "POST", body: {} });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await first.request("/api/auth/me")).status, 401);
    assert.equal(rows(harness.db, "SELECT token_hash FROM sessions").length, 1);

    const logoutAll = await second.request("/api/auth/logout-all", {
      method: "POST",
      body: {},
    });
    assert.equal(logoutAll.status, 200);
    assert.equal((await second.request("/api/auth/me")).status, 401);
    assert.equal(rows(harness.db, "SELECT token_hash FROM sessions").length, 0);
  } finally {
    await harness.close();
  }
});

test("登录限流：连续失败进入 SQLite 封禁，429 带 Retry-After 与 resetAt", async () => {
  const harness = await startHarness();
  try {
    await register(harness.client());
    const attacker = harness.client();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const failed = await attacker.request("/api/auth/login", {
        method: "POST",
        body: { email: "alice@example.com", password: `wrong-${attempt}-password` },
      });
      assert.equal(failed.status, 401);
    }
    assert.ok(rows(harness.db, "SELECT * FROM auth_rate_limit").length > 0);

    const blocked = await harness.client().request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: PASSWORD },
    });
    assert.equal(blocked.status, 429);
    const body = await bodyOf<{ error: string; code: string; resetAt: number }>(blocked);
    assert.equal(body.code, "rate_limited");
    assert.equal(typeof body.resetAt, "number");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  } finally {
    await harness.close();
  }
});

/* ── 工作区 ─────────────────────────────────────────────────────── */

test("工作区：按用户隔离、revision 冲突 409、结构校验、并发与大小上限", async () => {
  const harness = await startHarness();
  try {
    const alice = harness.client();
    const bob = harness.client();
    await register(alice);
    await register(bob, { email: "bob@example.com", name: "Bob" });

    const emptyAlice = await alice.request("/api/workspace");
    assert.equal(emptyAlice.status, 200);
    assert.deepEqual(await workspaceBody(emptyAlice), { revision: 0, data: null });

    const backupA = backupFixture();
    const firstPut = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupA },
    });
    assert.equal(firstPut.status, 200);
    assert.deepEqual(await workspaceBody(firstPut), { revision: 1, data: backupA });

    const bobEmpty = await bob.request("/api/workspace");
    assert.deepEqual(await workspaceBody(bobEmpty), { revision: 0, data: null });

    const backupB = backupFixture({ activity: ["2026-10-01"] });
    const bobPut = await bob.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupB },
    });
    assert.equal(bobPut.status, 200);

    const aliceData = await alice.request("/api/workspace");
    assert.deepEqual(await workspaceBody(aliceData), { revision: 1, data: backupA });

    const stale = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupFixture({ activity: ["2026-10-02"] }) },
    });
    assert.equal(stale.status, 409);
    const conflict = await bodyOf<{
      error: string;
      code: string;
      revision: number;
      data?: StudyBackup;
    }>(stale);
    assert.equal(conflict.code, "revision_conflict");
    assert.equal(conflict.revision, 1);
    assert.equal("data" in conflict, false, "409 不应携带完整 data");

    const fresh = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: 1, data: backupFixture({ activity: ["2026-10-02"] }) },
    });
    assert.equal(fresh.status, 200);
    assert.equal((await bodyOf<CloudWorkspace>(fresh)).revision, 2);

    const invalid = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2, data: { format: "other", version: 1 } },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await bodyOf<{ code: string }>(invalid)).code, "invalid_backup");

    const secret = await alice.request("/api/workspace", {
      method: "PUT",
      body: {
        revision: 2,
        data: { ...backupFixture(), settingsWithoutSecrets: { provider: "gemini", model: "m", baseUrl: "", apiKey: "sk-x" } },
      },
    });
    assert.equal(secret.status, 400);

    const missingData = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2 },
    });
    assert.equal(missingData.status, 400);

    const badRevision = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: "2", data: null },
    });
    assert.equal(badRevision.status, 400);

    const huge = backupFixture({
      notes: [
        {
          id: "n-huge",
          sessionId: "",
          title: "large",
          content: "x".repeat(MAX_WORKSPACE_BYTES + 1024),
          createdAt: 1,
        },
      ],
    });
    const tooLarge = await alice.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2, data: huge },
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await bodyOf<{ code: string }>(tooLarge)).code, "backup_too_large");

    // 并发保存同一 revision：只能有一个成功。
    const [left, right] = await Promise.all([
      alice.request("/api/workspace", {
        method: "PUT",
        body: { revision: 2, data: backupFixture({ activity: ["2026-10-03"] }) },
      }),
      alice.request("/api/workspace", {
        method: "PUT",
        body: { revision: 2, data: backupFixture({ activity: ["2026-10-04"] }) },
      }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);

    assert.equal(harness.db.transaction(() => harness.db.transaction(() => 7)), 7);

    const anonymous = await harness.client().request("/api/workspace");
    assert.equal(anonymous.status, 401);
  } finally {
    await harness.close();
  }
});

test("工作区 409：只返回 revision 等元信息，不携带完整 data", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    await register(client);
    const note = {
      id: "n-conflict",
      sessionId: "",
      title: "冲突笔记",
      content: "用于验证 409 不返回数据。",
      createdAt: 1,
    };
    const saved = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupFixture({ notes: [note] }) },
    });
    assert.equal(saved.status, 200);

    const stale = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupFixture() },
    });
    assert.equal(stale.status, 409);
    const staleBody = await bodyOf<Record<string, unknown>>(stale);
    assert.equal(staleBody.code, "revision_conflict");
    assert.equal(staleBody.revision, 1);
    assert.equal("data" in staleBody, false);
    assert.deepEqual(Object.keys(staleBody).sort(), ["code", "error", "revision"]);

    const removed = await client.request("/api/workspace/note-delete", {
      method: "POST",
      body: { noteId: note.id },
    });
    assert.equal(removed.status, 200);

    const resurrect = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2, data: backupFixture({ notes: [note] }) },
    });
    assert.equal(resurrect.status, 409);
    const resurrectBody = await bodyOf<Record<string, unknown>>(resurrect);
    assert.equal(resurrectBody.code, "note_tombstoned");
    assert.equal(resurrectBody.revision, 2);
    assert.equal("data" in resurrectBody, false);
    assert.deepEqual(Object.keys(resurrectBody).sort(), ["code", "error", "revision"]);
  } finally {
    await harness.close();
  }
});

/* ── 额度与 BYOK ───────────────────────────────────────────────── */

test("云笔记删除：显式落库并推进 revision，后续读取不会被并集复活", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    await register(client);
    const backup = backupFixture({
      notes: [
        {
          id: "n-delete",
          sessionId: "",
          title: "待删除笔记",
          content: "这段内容不应在删除后被并集恢复。",
          createdAt: 1,
        },
      ],
    });
    const noteId = "n-delete";
    const saved = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backup },
    });
    assert.equal(saved.status, 200);

    const removed = await client.request("/api/workspace/note-delete", {
      method: "POST",
      body: { noteId },
    });
    assert.equal(removed.status, 200);
    const removedBody = await bodyOf<CloudWorkspace>(removed);
    assert.equal(removedBody.revision, 2);
    assert.equal(removedBody.data?.notes.some((note) => note.id === noteId), false);
    assert.deepEqual(removedBody.data?.deletedNoteIds, [noteId]);

    const fetched = await client.request("/api/workspace");
    const fetchedBody = await bodyOf<CloudWorkspace>(fetched);
    assert.equal(fetchedBody.revision, 2);
    assert.equal(fetchedBody.data?.notes.some((note) => note.id === noteId), false);
    assert.deepEqual(fetchedBody.data?.deletedNoteIds, [noteId]);

    // 幂等：已删除的笔记再次删除不增加 revision。
    const again = await client.request("/api/workspace/note-delete", {
      method: "POST",
      body: { noteId },
    });
    assert.equal(again.status, 200);
    const againBody = await bodyOf<CloudWorkspace>(again);
    assert.equal(againBody.revision, 2);
    assert.deepEqual(againBody.data?.deletedNoteIds, [noteId]);
  } finally {
    await harness.close();
  }
});

test("云笔记删除：不存在的笔记也写墓碑并推进 revision，旧快照不能复活", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    await register(client);
    const noteId = "n-never-existed";
    const firstSave = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupFixture({ activity: ["2026-10-01"] }) },
    });
    assert.equal(firstSave.status, 200);

    // 笔记本就不存在：仍需写入墓碑并推进 revision，防止旧快照按同 ID 回写。
    const removed = await client.request("/api/workspace/note-delete", {
      method: "POST",
      body: { noteId },
    });
    assert.equal(removed.status, 200);
    const removedBody = await bodyOf<CloudWorkspace>(removed);
    assert.equal(removedBody.revision, 2);
    assert.deepEqual(removedBody.data?.deletedNoteIds, [noteId]);
    assert.deepEqual(removedBody.data?.notes, []);

    // 墓碑已存在：再次删除不制造新 revision。
    const again = await client.request("/api/workspace/note-delete", {
      method: "POST",
      body: { noteId },
    });
    assert.equal(again.status, 200);
    assert.equal((await bodyOf<CloudWorkspace>(again)).revision, 2);

    // 旧快照带着已删笔记、revision 仍写当前值：服务端拒绝复活。
    const oldSnapshot = backupFixture({
      notes: [
        {
          id: noteId,
          sessionId: "",
          title: "旧快照笔记",
          content: "这段内容不能复活。",
          createdAt: 1,
        },
      ],
      activity: ["2026-10-02"],
    });
    const resurrect = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2, data: oldSnapshot },
    });
    assert.equal(resurrect.status, 409);
    const resurrectBody = await bodyOf<{
      code: string;
      revision: number;
      data?: StudyBackup;
    }>(resurrect);
    assert.equal(resurrectBody.code, "note_tombstoned");
    assert.equal(resurrectBody.revision, 2);
    assert.equal("data" in resurrectBody, false, "409 不应携带完整 data");

    // 旧 revision 回写同样被拒绝，墓碑仍保留。
    const stale = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 1, data: oldSnapshot },
    });
    assert.equal(stale.status, 409);
    const staleBody = await bodyOf<{
      code: string;
      revision: number;
      data?: StudyBackup;
    }>(stale);
    assert.equal(staleBody.code, "revision_conflict");
    assert.equal(staleBody.revision, 2);
    assert.equal("data" in staleBody, false, "409 不应携带完整 data");

    const fetched = await bodyOf<CloudWorkspace>(
      await client.request("/api/workspace"),
    );
    assert.equal(fetched.revision, 2);
    assert.deepEqual(fetched.data?.deletedNoteIds, [noteId]);
    assert.equal(fetched.data?.notes.some((note) => note.id === noteId), false);

    // 旧客户端上传的快照漏带墓碑：服务端合并后仍保留，并允许正常保存其他数据。
    const legacySave = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2, data: backupFixture({ activity: ["2026-10-03"] }) },
    });
    assert.equal(legacySave.status, 200);
    const legacyBody = await bodyOf<CloudWorkspace>(legacySave);
    assert.equal(legacyBody.revision, 3);
    assert.deepEqual(legacyBody.data?.deletedNoteIds, [noteId]);
  } finally {
    await harness.close();
  }
});

test("工作区写入：每用户超过每分钟上限返回 429 + Retry-After", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    await register(client);
    for (let revision = 0; revision < 10; revision += 1) {
      const response = await client.request("/api/workspace", {
        method: "PUT",
        body: { revision, data: null },
      });
      assert.equal(response.status, 200, `第 ${revision + 1} 次保存应放行`);
    }
    const limited = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 10, data: null },
    });
    assert.equal(limited.status, 429);
    const body = await bodyOf<{ code: string; resetAt: number }>(limited);
    assert.equal(body.code, "rate_limited");
    assert.ok(body.resetAt > Date.now());
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    await harness.close();
  }
});

test("AI 路由：X-Zhixu-User 与会话账户不一致时 409 account_mismatch，且不扣额度", async () => {
  await withAiKeysCleared(async () => {
    const harness = await startHarness({ allowByok: false });
    try {
      const client = harness.client();
      const auth = await register(client);
      const requests: Array<[string, Record<string, unknown>]> = [
        ["/api/chat", chatBody()],
        [
          "/api/diagnostic",
          { topic: "二分查找", level: "初学", goal: "理解边界" },
        ],
        [
          "/api/review/explain",
          {
            topic: "二分查找",
            prompt: "如何避免死循环？",
            explanation: "边界更新必须收缩。",
            level: "初学",
          },
        ],
      ];
      for (const [path, body] of requests) {
        const response = await client.request(path, {
          method: "POST",
          body,
          headers: { "X-Zhixu-User": "another-account" },
        });
        assert.equal(response.status, 409, `${path} 必须拒绝账户不匹配`);
        const error = await bodyOf<{ code?: string }>(response);
        assert.equal(error.code, "account_mismatch");
      }
      assert.deepEqual(
        harness.db.usage(auth.body.user.id, utcDay()),
        { chat: 0, diagnostic: 0, review: 0 },
        "账户不匹配必须在扣减额度之前拒绝",
      );
    } finally {
      await harness.close();
    }
  });
});

test("额度：本地配置错误在扣减前拒绝，合法配置仍正常扣减", async () => {
  await withAiKeysCleared(async () => {
    const harness = await startHarness({
      allowByok: true,
      byokAllowedOrigins: ["https://example.invalid"],
      quotas: { chatPerDay: 2, diagnosticPerDay: 1, reviewPerDay: 1 },
    });
    try {
      const client = harness.client();
      const auth = await register(client);

      const badThinking = {
        provider: "openai" as const,
        apiKey: "sk-personal",
        model: "wb/cn:glm-5.1-flash",
        baseUrl: "https://example.invalid/v1",
        thinkingLevel: "high" as const,
      };
      const saved = await client.request("/api/credentials", {
        method: "PUT",
        body: { settings: badThinking },
      });
      assert.equal(saved.status, 200);

      const rejected = await client.request("/api/chat", {
        method: "POST",
        body: chatBody(),
      });
      assert.equal(rejected.status, 400);
      assert.equal(
        (await bodyOf<{ code: string }>(rejected)).code,
        "unsupported_thinking_level",
      );

      assert.throws(
        () => resolveConfig({ provider: "openai", apiKey: "sk-personal", model: "gpt-4o-mini", baseUrl: "ftp://example.invalid/v1" }),
        /HTTP/,
      );

      const good = {
        ...badThinking,
        thinkingLevel: "auto" as const,
      };
      const savedGood = await client.request("/api/credentials", {
        method: "PUT",
        body: { settings: good },
      });
      assert.equal(savedGood.status, 200);
      const allowed = await client.request("/api/chat", {
        method: "POST",
        body: chatBody(),
      });
      assert.equal(allowed.status, 502, "合法配置应通过前置校验并进入上游调用，不能再按配置错误拒绝");

      const usage = harness.db.usage(auth.body.user.id, utcDay());
      assert.equal(usage.chat, 1, "前两次本地配置错误不得消耗额度，合法配置只扣一次");
    } finally {
      await harness.close();
    }
  });
});

test("额度：调用前原子扣减、用户隔离、429 带 UTC resetAt 与 Retry-After", async () => {
  await withAiKeysCleared(async () => {
    const harness = await startHarness({
      allowByok: true,
      byokAllowedOrigins: ["https://example.invalid"],
      quotas: { chatPerDay: 2, diagnosticPerDay: 1, reviewPerDay: 1 },
    });
    try {
      const anonymous = await harness.client().request("/api/chat", {
        method: "POST",
        body: chatBody(),
      });
      assert.equal(anonymous.status, 401);

      const alice = harness.client();
      const bob = harness.client();
      const aliceAuth = await register(alice);
      await register(bob, { email: "bob@example.com", name: "Bob" });
      const personalSettings = {
        provider: "openai" as const,
        apiKey: "sk-quota-personal",
        model: "gpt-4o-mini",
        baseUrl: "https://example.invalid/v1",
      };
      for (const client of [alice, bob]) {
        const saved = await client.request("/api/credentials", {
          method: "PUT",
          body: { settings: personalSettings },
        });
        assert.equal(saved.status, 200);
      }

      for (let i = 0; i < 2; i += 1) {
        const response = await alice.request("/api/chat", { method: "POST", body: chatBody() });
        assert.notEqual(response.status, 429);
      }
      const exceeded = await alice.request("/api/chat", { method: "POST", body: chatBody() });
      assert.equal(exceeded.status, 429);
      const quota = await bodyOf<{ error: string; code: string; resetAt: number }>(exceeded);
      assert.equal(quota.code, "quota_exceeded");
      assert.ok(quota.resetAt > Date.now());
      const reset = new Date(quota.resetAt);
      assert.equal(reset.getUTCHours(), 0);
      assert.equal(reset.getUTCMinutes(), 0);
      assert.ok(Number(exceeded.headers.get("retry-after")) > 0);

      const bobChat = await bob.request("/api/chat", { method: "POST", body: chatBody() });
      assert.notEqual(bobChat.status, 429);

      const diagnostic = {
        topic: "二分查找",
        level: "初学",
        goal: "理解边界",
      };
      const firstDiagnostic = await alice.request("/api/diagnostic", {
        method: "POST",
        body: diagnostic,
      });
      assert.notEqual(firstDiagnostic.status, 429);
      const secondDiagnostic = await alice.request("/api/diagnostic", {
        method: "POST",
        body: diagnostic,
      });
      assert.equal(secondDiagnostic.status, 429);

      const review = {
        topic: "二分查找",
        prompt: "如何避免死循环？",
        explanation: "边界更新必须收缩。",
        level: "初学",
      };
      const firstReview = await alice.request("/api/review/explain", {
        method: "POST",
        body: review,
      });
      assert.notEqual(firstReview.status, 429);
      const secondReview = await alice.request("/api/review/explain", {
        method: "POST",
        body: review,
      });
      assert.equal(secondReview.status, 429);

      const usage = harness.db.usage(aliceAuth.body.user.id, utcDay());
      assert.equal(usage.chat, 2);
      assert.equal(usage.diagnostic, 1);
      assert.equal(usage.review, 1);
    } finally {
      await harness.close();
    }
  });
});

test("额度：并发请求只放行一次扣减", async () => {
  await withAiKeysCleared(async () => {
    const harness = await startHarness({
      allowByok: true,
      byokAllowedOrigins: ["https://example.invalid"],
      quotas: { chatPerDay: 1, diagnosticPerDay: 0, reviewPerDay: 0 },
    });
    try {
      const client = harness.client();
      await register(client);
      const saved = await client.request("/api/credentials", {
        method: "PUT",
        body: {
          settings: {
            provider: "openai",
            apiKey: "sk-concurrent-personal",
            model: "gpt-4o-mini",
            baseUrl: "https://example.invalid/v1",
          },
        },
      });
      assert.equal(saved.status, 200);
      const [first, second] = await Promise.all([
        client.request("/api/chat", { method: "POST", body: chatBody() }),
        client.request("/api/chat", { method: "POST", body: chatBody() }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [429, 502]);
    } finally {
      await harness.close();
    }
  });
});

test("BYOK：未登录请求携带模型或搜索密钥被 401 拒绝", async () => {
  const harness = await startHarness({ authRequired: false, allowByok: true });
  try {
    const client = harness.client();
    for (const settings of [
      { provider: "gemini" as const, apiKey: "sk-user", model: "gemini-2.5-flash", baseUrl: "" },
      { provider: "gemini" as const, model: "gemini-2.5-flash", baseUrl: "", searchApiKey: "tvly-user" },
      {
        provider: "gemini" as const,
        model: "gemini-2.5-flash",
        baseUrl: "",
        searchFallbacks: [{ provider: "brave" as const, apiKey: "brave-user" }],
      },
    ]) {
      const response = await client.request("/api/chat", {
        method: "POST",
        body: chatBody({ settings }),
      });
      assert.equal(response.status, 401);
      assert.equal((await bodyOf<{ code: string }>(response)).code, "auth_required");
    }
    const user = harness.db.userByEmail("alice@example.com");
    assert.equal(user, undefined);
  } finally {
    await harness.close();
  }
});

test("BYOK：默认拒绝请求内 apiKey，ZHIXU_ALLOW_BYOK 开启后才交给服务端解析", async () => {
  const denied = await startHarness({ allowByok: false });
  try {
    const client = denied.client();
    await register(client);
    const settings = { provider: "gemini", apiKey: "sk-user-supplied", model: "", baseUrl: "" };
    for (const [pathname, body] of [
      ["/api/chat", chatBody({ settings })],
      ["/api/diagnostic", { topic: "t", level: "l", goal: "g", settings }],
      [
        "/api/review/explain",
        { topic: "t", prompt: "p", explanation: "e", level: "l", settings },
      ],
    ] as const) {
      const response = await client.request(pathname, { method: "POST", body });
      assert.equal(response.status, 403, pathname);
      assert.equal((await bodyOf<{ code: string }>(response)).code, "byok_not_allowed");
    }
    const deniedUser = denied.db.userByEmail("alice@example.com");
    assert.ok(deniedUser);
    assert.equal(denied.db.usage(deniedUser.id, utcDay()).chat, 0);
  } finally {
    await denied.close();
  }

  await withAiKeysCleared(async () => {
    const unlisted = await startHarness({ allowByok: true });
    try {
      const client = unlisted.client();
      await register(client);
      const response = await client.request("/api/chat", {
        method: "POST",
        body: chatBody({
          settings: {
            provider: "openai",
            apiKey: "sk-user-supplied",
            model: "gpt-4o-mini",
            baseUrl: "https://internal.example.invalid/v1",
          },
        }),
      });
      assert.equal(response.status, 403);
      assert.equal(
        (await bodyOf<{ code: string }>(response)).code,
        "byok_endpoint_not_allowed",
      );
      const user = unlisted.db.userByEmail("alice@example.com");
      assert.ok(user);
      assert.equal(unlisted.db.usage(user.id, utcDay()).chat, 0);
    } finally {
      await unlisted.close();
    }

    const allowed = await startHarness({
      allowByok: true,
      byokAllowedOrigins: ["https://example.invalid"],
      quotas: { chatPerDay: 0, diagnosticPerDay: 0, reviewPerDay: 0 },
    });
    try {
      const client = allowed.client();
      await register(client);
      const requestSettings = {
        provider: "gemini" as const,
        apiKey: "sk-user-supplied",
        model: "gemini-2.5-flash",
        baseUrl: "https://example.invalid",
      };
      const missing = await client.request("/api/chat", {
        method: "POST",
        body: chatBody({ settings: requestSettings }),
      });
      assert.equal(missing.status, 409);
      assert.equal(
        (await bodyOf<{ code: string }>(missing)).code,
        "personal_credentials_required",
      );

      const saved = await client.request("/api/credentials", {
        method: "PUT",
        body: { settings: requestSettings },
      });
      assert.equal(saved.status, 200);
      const missingSearch = await client.request("/api/chat", {
        method: "POST",
        body: chatBody({ settings: requestSettings, webSearch: true }),
      });
      assert.equal(missingSearch.status, 409);
      assert.equal(
        (await bodyOf<{ code: string }>(missingSearch)).code,
        "personal_search_required",
      );

      const withSearch = {
        ...requestSettings,
        searchProvider: "tavily" as const,
        searchApiKey: "tvly-personal",
      };
      const savedSearch = await client.request("/api/credentials", {
        method: "PUT",
        body: { settings: withSearch },
      });
      assert.equal(savedSearch.status, 200);
      const response = await client.request("/api/chat", {
        method: "POST",
        body: chatBody({ settings: withSearch, webSearch: true }),
      });
      // 有服务端个人配置后没有被 BYOK 策略拦截，而是走到额度（0）→ 429。
      assert.equal(response.status, 429);
      assert.equal((await bodyOf<{ code: string }>(response)).code, "quota_exceeded");
    } finally {
      await allowed.close();
    }
  });
});

/* ── 边界安全 ───────────────────────────────────────────────────── */

test("边界安全：CSRF 标记、Origin、Host、内容类型、安全头与请求 ID", async () => {
  const harness = await startHarness();
  try {
    const noCsrf = await harness.client().request("/api/auth/register", {
      method: "POST",
      csrf: false,
      body: { email: "csrf@example.com", name: "C", password: PASSWORD },
    });
    assert.equal(noCsrf.status, 403);

    const evilOrigin = await harness.client().request("/api/auth/register", {
      method: "POST",
      origin: "https://evil.example",
      body: { email: "evil@example.com", name: "E", password: PASSWORD },
    });
    assert.equal(evilOrigin.status, 403);

    const allowedOrigin = await harness.client().request("/api/auth/register", {
      method: "POST",
      origin: harness.base,
      body: { email: "allowed@example.com", name: "A", password: PASSWORD },
    });
    assert.equal(allowedOrigin.status, 200);

    // 浏览器同源写请求可只带 Origin（自定义头仍由客户端发送，二者至少其一）。
    const originOnly = await rawRequest(harness.base, {
      method: "POST",
      path: "/api/auth/register",
      headers: {
        "Content-Type": "application/json",
        Origin: harness.base,
      },
      body: JSON.stringify({ email: "origin@example.com", name: "O", password: PASSWORD }),
    });
    assert.equal(originOnly.status, 200);

    const rawBase = rawRequest(harness.base, {
      method: "POST",
      path: "/api/auth/register",
      headers: {
        "Content-Type": "application/json",
        "X-Zhixu-Request": "1",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ email: "cross@example.com", name: "X", password: PASSWORD }),
    });
    assert.equal((await rawBase).status, 403);

    const plainText = await harness.client().request("/api/auth/register", {
      method: "POST",
      contentType: "text/plain",
      body: { email: "plain@example.com", name: "P", password: PASSWORD },
    });
    assert.equal(plainText.status, 415);

    const badHost = await rawRequest(harness.base, {
      method: "GET",
      path: "/api/health",
      headers: { Host: "evil.example" },
    });
    assert.equal(badHost.status, 403);

    const health = await rawRequest(harness.base, { method: "GET", path: "/api/health" });
    assert.equal(health.status, 200);
    assert.equal(health.headers["x-content-type-options"], "nosniff");
    assert.equal(health.headers["x-frame-options"], "DENY");
    assert.equal(health.headers["referrer-policy"], "no-referrer");
    assert.match(String(health.headers["content-security-policy"]), /default-src 'self'/);
    assert.equal(health.headers["cache-control"], "no-store");
    assert.match(String(health.headers["x-request-id"]), /^[0-9a-f-]{36}$/);

    const echoed = await rawRequest(harness.base, {
      method: "GET",
      path: "/api/health",
      headers: { "X-Request-Id": "trace-12345678" },
    });
    assert.equal(echoed.headers["x-request-id"], "trace-12345678");

    const config = await harness.client().request("/api/config");
    assert.equal(config.status, 200);
    const serverConfig = await bodyOf<ServerConfig>(config);
    assert.equal(serverConfig.authRequired, true);
    assert.equal(serverConfig.allowByok, false);
    assert.deepEqual(serverConfig.quotas, {
      chatPerDay: 40,
      diagnosticPerDay: 10,
      reviewPerDay: 30,
    });
    assert.equal(typeof serverConfig.configured, "boolean");

    const ready = await harness.client().request("/api/ready");
    assert.equal(ready.status, 200);
    assert.equal((await bodyOf<{ ok: boolean; db: boolean }>(ready)).db, true);
  } finally {
    await harness.close();
  }
});

test("生产模式：公网 Origin 白名单、Secure Cookie 与 HSTS", async () => {
  const harness = await startHarness({
    production: true,
    publicOrigin: "https://study.example.com",
    cookieSecure: true,
  });
  try {
    const rejected = await rawRequest(harness.base, {
      method: "POST",
      path: "/api/auth/register",
      headers: {
        "Content-Type": "application/json",
        "X-Zhixu-Request": "1",
        Origin: harness.base,
      },
      body: JSON.stringify({ email: "prod@example.com", name: "P", password: PASSWORD }),
    });
    assert.equal(rejected.status, 403);

    const accepted = await rawRequest(harness.base, {
      method: "POST",
      path: "/api/auth/register",
      headers: {
        "Content-Type": "application/json",
        "X-Zhixu-Request": "1",
        Origin: "https://study.example.com",
      },
      body: JSON.stringify({ email: "prod@example.com", name: "P", password: PASSWORD }),
    });
    assert.equal(accepted.status, 200);
    const setCookie = String(accepted.headers["set-cookie"]);
    assert.match(setCookie, /;\s*Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(String(accepted.headers["strict-transport-security"]), /max-age=31536000/);
  } finally {
    await harness.close();
  }
});

/* ── 删除账户与配置加载 ─────────────────────────────────────────── */

test("删除账户：密码校验、级联清理会话/恢复码/工作区/用量并清 Cookie", async () => {
  const harness = await startHarness();
  try {
    const client = harness.client();
    const other = harness.client();
    const registered = await register(client);
    await other.request("/api/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: PASSWORD },
    });
    const userId = registered.body.user.id;
    await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: backupFixture() },
    });
    harness.db.consumeUsage(userId, utcDay(), "chat", 5);
    assert.equal(rows(harness.db, "SELECT * FROM daily_usage").length, 1);

    const wrong = await client.request("/api/account", {
      method: "DELETE",
      body: { password: "wrong password" },
    });
    assert.equal(wrong.status, 401);
    assert.equal((await client.request("/api/auth/me")).status, 200);

    const deleted = await client.request("/api/account", {
      method: "DELETE",
      body: { password: PASSWORD },
    });
    assert.equal(deleted.status, 200);
    assert.match(deleted.headers.get("set-cookie") ?? "", /Max-Age=0/);

    assert.equal((await other.request("/api/auth/me")).status, 401);
    assert.equal(harness.db.userByEmail("alice@example.com"), undefined);
    for (const table of ["sessions", "recovery_codes", "workspaces", "daily_usage"]) {
      assert.equal(rows(harness.db, `SELECT * FROM ${table}`).length, 0, table);
    }
  } finally {
    await harness.close();
  }
});

test("deleteUser：清理账户级与邮箱级限流行，保留无关来源 IP 记录", async () => {
  const harness = await startHarness();
  try {
    const registered = await register(harness.client());
    const userId = registered.body.user.id;
    const email = registered.body.user.email;
    // 与 auth.ts 的 subject 构造保持一致：`${scope}:${kind}:${sha256(value)}`。
    const subjects = [
      `account:user:${hashToken(userId)}`,
      `recovery-rotate:user:${hashToken(userId)}`,
      `login:email:${hashToken(email)}`,
      `recover:email:${hashToken(email)}`,
    ];
    for (const subject of subjects) {
      harness.db.setRateLimit(subject, Date.now(), 3, 0);
    }
    harness.db.setRateLimit("login:ip:203.0.113.9", Date.now(), 3, 0);

    harness.db.deleteUser(userId);

    assert.equal(harness.db.userById(userId), undefined);
    for (const subject of subjects) {
      assert.equal(harness.db.getRateLimit(subject), undefined, subject);
    }
    assert.ok(
      harness.db.getRateLimit("login:ip:203.0.113.9"),
      "无关来源 IP 的限流记录不能被误删",
    );
  } finally {
    await harness.close();
  }
});

test("配置：生产必须配置公网来源，URL 规范化并拒绝路径/凭证", () => {
  const keys = [
    "ZHIXU_PUBLIC_ORIGIN",
    "ZHIXU_HOST",
    "ZHIXU_PORT",
    "ZHIXU_DATA_DIR",
    "ZHIXU_AUTH_REQUIRED",
    "ZHIXU_ALLOW_BYOK",
    "ZHIXU_COOKIE_SECURE",
    "ZHIXU_TRUST_PROXY",
    "ZHIXU_QUOTA_CHAT",
    "ZHIXU_QUOTA_DIAGNOSTIC",
    "ZHIXU_QUOTA_REVIEW",
    "ZHIXU_MAX_CONCURRENT_AI",
    "ZHIXU_AUDIT_RETENTION_DAYS",
    "ZHIXU_USAGE_RETENTION_DAYS",
    "ZHIXU_BYOK_BASEURLS",
    "ZHIXU_ALLOW_INSECURE_LOCAL",
  ];
  const saved = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const key of keys) delete process.env[key];
    assert.throws(() => loadConfig(true), /ZHIXU_PUBLIC_ORIGIN/);

    process.env.ZHIXU_PUBLIC_ORIGIN = "https://study.example.com/";
    const config = loadConfig(true);
    assert.equal(config.publicOrigin, "https://study.example.com");
    assert.equal(config.authRequired, true);
    assert.equal(config.allowByok, false);
    assert.equal(config.cookieSecure, true);
    assert.equal(config.trustProxy, false);
    assert.deepEqual(config.quotas, {
      chatPerDay: 40,
      diagnosticPerDay: 10,
      reviewPerDay: 30,
    });
    assert.equal(config.maxConcurrentAi, 2);
    assert.equal(config.auditRetentionDays, 90);
    assert.deepEqual(config.byokAllowedOrigins, []);

    process.env.ZHIXU_PUBLIC_ORIGIN = "http://127.0.0.1:3001";
    assert.throws(() => loadConfig(true), /要求 ZHIXU_PUBLIC_ORIGIN 使用 https/);
    process.env.ZHIXU_ALLOW_INSECURE_LOCAL = "true";
    process.env.ZHIXU_COOKIE_SECURE = "false";
    const localTest = loadConfig(true);
    assert.equal(localTest.allowInsecureLocal, true);
    assert.equal(localTest.cookieSecure, false);
    process.env.ZHIXU_PUBLIC_ORIGIN = "https://study.example.com";
    delete process.env.ZHIXU_ALLOW_INSECURE_LOCAL;
    assert.throws(() => loadConfig(true), /禁止 ZHIXU_COOKIE_SECURE=false/);
    process.env.ZHIXU_COOKIE_SECURE = "true";
    process.env.ZHIXU_BYOK_BASEURLS = "https://api.example.com, https://relay.example.com";
    assert.deepEqual(loadConfig(true).byokAllowedOrigins, [
      "https://api.example.com",
      "https://relay.example.com",
    ]);

    // 本地模式保持原有浏览器自带密钥能力；公共模式才默认关闭。
    delete process.env.ZHIXU_COOKIE_SECURE;
    delete process.env.ZHIXU_BYOK_BASEURLS;
    const dev = loadConfig(false);
    assert.equal(dev.authRequired, false);
    assert.equal(dev.allowByok, true);
    assert.equal(dev.cookieSecure, false);

    assert.throws(() => normalizeOrigin("https://user:pass@example.com"), /用户名或密码/);
    assert.throws(() => normalizeOrigin("https://example.com/app"), /不能包含路径/);
    assert.throws(() => normalizeOrigin("ftp://example.com"), /http/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("credentials：个人配置按用户加密保存、读取与删除，不同账户互不可见", async () => {
  const harness = await startHarness({ allowByok: true });
  try {
    const alice = harness.client();
    await register(alice, { email: "credential-alice@example.com", name: "Alice" });
    const empty = await alice.request("/api/credentials");
    assert.equal(empty.status, 200);
    assert.equal((await bodyOf<{ settings: unknown }>(empty)).settings, null);

    const settings = {
      provider: "gemini" as const,
      apiKey: "AIza-credential-secret",
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      searchProvider: "tavily" as const,
      searchApiKey: "tvly-credential-secret",
      modelFallbacks: [{
        provider: "gemini" as const,
        model: "gemini-2.5-pro",
        baseUrl: "",
        apiKey: "AIza-fallback-secret",
      }],
      searchFallbacks: [{ provider: "brave" as const, apiKey: "brave-secret" }],
    };
    const saved = await alice.request("/api/credentials", {
      method: "PUT",
      body: { settings },
    });
    assert.equal(saved.status, 200);

    const loaded = await alice.request("/api/credentials");
    assert.equal(loaded.status, 200);
    const loadedBody = await bodyOf<{ settings: typeof settings }>(loaded);
    assert.equal(loadedBody.settings.apiKey, settings.apiKey);
    assert.equal(loadedBody.settings.searchApiKey, settings.searchApiKey);
    assert.equal(loadedBody.settings.modelFallbacks[0].apiKey, "AIza-fallback-secret");
    assert.equal(loadedBody.settings.searchFallbacks[0].apiKey, "brave-secret");

    const storedRows = rows(harness.db, "SELECT payload FROM user_credentials");
    assert.equal(storedRows.length, 1);
    const payload = String(storedRows[0].payload);
    assert.equal(payload.includes("credential-secret"), false);
    assert.equal(payload.includes("AIza"), false);

    const bob = harness.client();
    await register(bob, { email: "credential-bob@example.com", name: "Bob" });
    const bobLoaded = await bob.request("/api/credentials");
    assert.equal(bobLoaded.status, 200);
    assert.equal((await bodyOf<{ settings: unknown }>(bobLoaded)).settings, null);

    const deleted = await alice.request("/api/credentials", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const afterDelete = await alice.request("/api/credentials");
    assert.equal((await bodyOf<{ settings: unknown }>(afterDelete)).settings, null);
  } finally {
    await harness.close();
  }
});

test("credentials：关闭 BYOK 时拒绝个人配置接口", async () => {
  const harness = await startHarness({ allowByok: false });
  try {
    const client = harness.client();
    await register(client, { email: "credential-disabled@example.com" });
    const response = await client.request("/api/credentials");
    assert.equal(response.status, 403);
    const body = await bodyOf<{ code: string }>(response);
    assert.equal(body.code, "byok_not_allowed");
  } finally {
    await harness.close();
  }
});

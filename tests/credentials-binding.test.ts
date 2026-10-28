import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AuthResult, ProviderSettings } from "../src/types";
import { createApp } from "../server/index";
import type { AppConfig } from "../server/config";
import { SESSION_COOKIE_NAME, ZhixuDatabase } from "../server/db";
import type { Fetcher } from "../src/lib/cloudSync";
import {
  CredentialsError,
  clearCredentialSettings,
  deleteCredentials,
  getCredentials,
  hasCredentialSecrets,
  markCredentialSettingsDeleted,
  saveCredentials,
} from "../src/lib/credentials";

/* ── 夹具：临时 SQLite + 真实 Express 实例（不监听外网） ──────────────── */

const PASSWORD = "correct horse battery";

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

interface Harness {
  readonly db: ZhixuDatabase;
  client(): Client;
  close(): Promise<void>;
}

interface RequestInitLike {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

class Client {
  private cookie?: string;
  constructor(private readonly base: string) {}

  async request(pathname: string, init: RequestInitLike = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (unsafe) {
      headers["X-Zhixu-Request"] = "1";
      headers["Content-Type"] = "application/json";
    }
    if (this.cookie) headers.Cookie = this.cookie;

    const body = init.body !== undefined ? JSON.stringify(init.body) : unsafe ? "{}" : undefined;
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

async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-credentials-binding-"));
  const config: AppConfig = { ...BASE_CONFIG, ...overrides, dataDir: dir };
  const db = new ZhixuDatabase(path.join(dir, "zhixu.db"));
  const app = createApp({ config, db, serveStatic: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  return {
    db,
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

interface ErrorBody {
  error?: string;
  code?: string;
}

async function register(client: Client, email: string): Promise<AuthResult> {
  const response = await client.request("/api/auth/register", {
    method: "POST",
    body: { email, name: email.split("@")[0], password: PASSWORD },
  });
  assert.equal(response.status, 200, `注册 ${email} 应成功`);
  return bodyOf<AuthResult>(response);
}

async function login(client: Client, email: string): Promise<AuthResult> {
  const response = await client.request("/api/auth/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  assert.equal(response.status, 200, `登录 ${email} 应成功`);
  return bodyOf<AuthResult>(response);
}

const SETTINGS_A: ProviderSettings = {
  provider: "gemini",
  apiKey: "AIza-account-a-secret",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
  searchProvider: "tavily",
  searchApiKey: "tvly-account-a-secret",
};

const SETTINGS_B: ProviderSettings = {
  provider: "openai",
  apiKey: "sk-account-b-secret",
  model: "gpt-4.1-mini",
  baseUrl: "https://api.openai.com/v1",
  searchProvider: "brave",
  searchApiKey: "brave-account-b-secret",
};

async function putSettings(
  client: Client,
  settings: ProviderSettings,
  expectedUserId?: string,
): Promise<void> {
  const response = await client.request("/api/credentials", {
    method: "PUT",
    body: { settings },
    headers: expectedUserId ? { "X-Zhixu-User": expectedUserId } : {},
  });
  assert.equal(response.status, 200);
}

async function loadedSettings(client: Client): Promise<ProviderSettings | null> {
  const response = await client.request("/api/credentials");
  assert.equal(response.status, 200);
  return (await bodyOf<{ settings: ProviderSettings | null }>(response)).settings;
}

async function expectAccountMismatch(response: Response): Promise<void> {
  assert.equal(response.status, 409);
  const body = await bodyOf<ErrorBody>(response);
  assert.equal(body.code, "account_mismatch");
  assert.equal("settings" in body, false, "账户不匹配时不得返回任何凭据");
}

/* ── 服务端：旧标签页跨账户读写/删除 ─────────────────────────────────── */

test("credentials：A 保存后 B 登录，旧 A 标签页带 expectedUserId 的读写删一律 409 且不触碰 B", async () => {
  const harness = await startHarness({ allowByok: true });
  try {
    // 同一浏览器：A 登录并保存个人配置。
    const browser = harness.client();
    const alice = await register(browser, "alice@example.com");
    await putSettings(browser, SETTINGS_A, alice.user.id);

    // B 在另一台设备/浏览器注册，然后在同一浏览器登录（Cookie 换成 B）。
    const bobBrowser = harness.client();
    const bob = await register(bobBrowser, "bob@example.com");
    await login(browser, bob.user.email);
    await putSettings(bobBrowser, SETTINGS_B, bob.user.id);

    // 旧 A 标签页仍然发送 X-Zhixu-User: A：读取、覆盖、删除都必须被拒绝。
    const staleGet = await browser.request("/api/credentials", {
      headers: { "X-Zhixu-User": alice.user.id },
    });
    await expectAccountMismatch(staleGet);

    const stalePut = await browser.request("/api/credentials", {
      method: "PUT",
      headers: { "X-Zhixu-User": alice.user.id },
      body: { settings: { ...SETTINGS_A, apiKey: "stale-a-overwrite", model: "stale-model" } },
    });
    await expectAccountMismatch(stalePut);

    const staleDelete = await browser.request("/api/credentials", {
      method: "DELETE",
      headers: { "X-Zhixu-User": alice.user.id },
    });
    await expectAccountMismatch(staleDelete);

    // 任意伪造头同样被拒绝。
    const forged = await browser.request("/api/credentials", {
      headers: { "X-Zhixu-User": "not-a-real-user" },
    });
    await expectAccountMismatch(forged);

    // B 的凭据既没有被旧 A 覆盖，也没有被旧 A 删除。
    assert.equal((await loadedSettings(browser))?.apiKey, SETTINGS_B.apiKey);
    assert.equal((await loadedSettings(browser))?.model, SETTINGS_B.model);
    assert.equal((await loadedSettings(bobBrowser))?.searchApiKey, SETTINGS_B.searchApiKey);

    // A 自己的凭据仍保持原样；不带头时按 Cookie 用户工作（此处 Cookie 是 A）。
    const aliceAgain = harness.client();
    await login(aliceAgain, alice.user.email);
    assert.deepEqual(await loadedSettings(aliceAgain), SETTINGS_A);

    const rows = harness.db.db
      .prepare("SELECT user_id FROM user_credentials ORDER BY user_id")
      .all() as unknown as Array<{ user_id: string }>;
    assert.deepEqual(rows.map((row) => row.user_id).sort(), [alice.user.id, bob.user.id].sort());
  } finally {
    await harness.close();
  }
});

/* ── 服务端：不带头保持兼容 ──────────────────────────────────────────── */

test("credentials：不带 X-Zhixu-User 的请求仍按 Cookie 用户读写与删除", async () => {
  const harness = await startHarness({ allowByok: true });
  try {
    const browser = harness.client();
    const alice = await register(browser, "alice@example.com");

    assert.equal(await loadedSettings(browser), null);

    // 不带头的 PUT/GET 兼容，按 Cookie 账户生效。
    await putSettings(browser, SETTINGS_A);
    assert.deepEqual(await loadedSettings(browser), SETTINGS_A);

    // 带当前账户 ID 的请求也正常。
    const matching = await browser.request("/api/credentials", {
      headers: { "X-Zhixu-User": alice.user.id },
    });
    assert.equal(matching.status, 200);
    assert.equal((await bodyOf<{ settings: ProviderSettings }>(matching)).settings.apiKey, SETTINGS_A.apiKey);

    const matchingDelete = await browser.request("/api/credentials", {
      method: "DELETE",
      headers: { "X-Zhixu-User": alice.user.id },
    });
    assert.equal(matchingDelete.status, 200);
    assert.equal(await loadedSettings(browser), null);

    // 不带头删除仍按 Cookie 账户工作。
    await putSettings(browser, SETTINGS_A);
    const deleted = await browser.request("/api/credentials", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(await loadedSettings(browser), null);
  } finally {
    await harness.close();
  }
});

/* ── 客户端：可选 expectedUserId 与请求头 ────────────────────────────── */

interface RecordedCall {
  path: string;
  init: RequestInit | undefined;
}

function recordingFetcher(respond: () => Response): { fetcher: Fetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push({ path: input, init });
    return respond();
  };
  return { fetcher, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("credentials 客户端：GET/PUT/DELETE 仅在提供 expectedUserId 时发送 X-Zhixu-User", async () => {
  const loaded = recordingFetcher(() => jsonResponse({ settings: SETTINGS_A, updatedAt: 1 }));
  await getCredentials(loaded.fetcher, "user-a");
  assert.equal(loaded.calls.length, 1);
  assert.equal(loaded.calls[0].path, "/api/credentials");
  assert.equal(loaded.calls[0].init?.method, undefined);
  assert.equal(new Headers(loaded.calls[0].init?.headers).get("X-Zhixu-User"), "user-a");

  const compatible = recordingFetcher(() => jsonResponse({ settings: null, updatedAt: 0 }));
  assert.equal(await getCredentials(compatible.fetcher), null);
  assert.equal(new Headers(compatible.calls[0].init?.headers).get("X-Zhixu-User"), null);

  const saved = recordingFetcher(() => jsonResponse({ ok: true, updatedAt: 2 }));
  await saveCredentials(saved.fetcher, SETTINGS_A, "user-a");
  const saveInit = saved.calls[0].init;
  assert.equal(saveInit?.method, "PUT");
  assert.equal(new Headers(saveInit?.headers).get("X-Zhixu-User"), "user-a");
  assert.equal(new Headers(saveInit?.headers).get("X-Zhixu-Request"), "1");
  assert.deepEqual(JSON.parse(String(saveInit?.body)), { settings: SETTINGS_A });

  const removal = recordingFetcher(() => jsonResponse({ ok: true }));
  await deleteCredentials(removal.fetcher, "user-a");
  const deleteInit = removal.calls[0].init;
  assert.equal(deleteInit?.method, "DELETE");
  assert.equal(new Headers(deleteInit?.headers).get("X-Zhixu-User"), "user-a");
  assert.equal(new Headers(deleteInit?.headers).get("X-Zhixu-Request"), "1");

  const withoutHeader = recordingFetcher(() => jsonResponse({ ok: true }));
  await deleteCredentials(withoutHeader.fetcher);
  assert.equal(new Headers(withoutHeader.calls[0].init?.headers).get("X-Zhixu-User"), null);
});

test("删除个人配置后清空全部密钥字段，并跳过后续空配置保存", async () => {
  const fullSettings: ProviderSettings = {
    ...SETTINGS_A,
    modelFallbacks: [
      {
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-fallback-secret",
      },
    ],
    searchFallbacks: [{ provider: "brave", apiKey: "brave-fallback-secret" }],
  };
  assert.equal(hasCredentialSecrets(fullSettings), true);
  assert.equal(hasCredentialSecrets({ ...fullSettings, apiKey: "", searchApiKey: "", modelFallbacks: [], searchFallbacks: [] }), false);

  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ ok: true }));
  await deleteCredentials(fetcher, "user-a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal(new Headers(calls[0].init?.headers).get("X-Zhixu-User"), "user-a");

  const cleared = clearCredentialSettings(fullSettings);
  assert.deepEqual(cleared, {
    ...fullSettings,
    apiKey: "",
    searchApiKey: "",
    modelFallbacks: [],
    searchFallbacks: [],
  });

  // App 的 onSave 会把清空后的对象继续交给 saveCredentials：必须识别删除标记并跳过，
  // 不能重新 PUT 一个空配置，否则“已保存”状态和删除按钮会立刻复现。
  markCredentialSettingsDeleted(cleared);
  await saveCredentials(fetcher, cleared, "user-a");
  assert.equal(calls.length, 1, "删除后的空保存不应再发请求");
});

test("保存完全空白的个人配置按删除处理，不创建空凭据行", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ ok: true }));
  await saveCredentials(
    fetcher,
    { ...SETTINGS_A, apiKey: "", searchApiKey: "", modelFallbacks: [], searchFallbacks: [] },
    "user-a",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal(new Headers(calls[0].init?.headers).get("X-Zhixu-User"), "user-a");
});

test("credentials 客户端：409 account_mismatch 以 CredentialsError 暴露给调用方", async () => {
  const fetcher: Fetcher = async () =>
    jsonResponse({ error: "登录账户已在本浏览器的其他标签页变化，请刷新后重试。", code: "account_mismatch" }, 409);
  await assert.rejects(
    () => getCredentials(fetcher, "user-a"),
    (error: unknown) => {
      assert.ok(error instanceof CredentialsError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "account_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => deleteCredentials(fetcher, "user-a"),
    (error: unknown) => error instanceof CredentialsError && error.code === "account_mismatch",
  );
});

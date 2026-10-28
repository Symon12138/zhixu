import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { BookMetadata } from "../src/bookTypes";
import type { Note, StudyBackup, StudySession } from "../src/types";
import { MAX_DELETED_NOTE_IDS } from "../src/lib/backup";
import { createApp } from "../server/index";
import type { AppConfig } from "../server/config";
import { SESSION_COOKIE_NAME, ZhixuDatabase } from "../server/db";
import { MAX_BOOK_ORIGINAL_BYTES } from "../server/library";
import {
  fetchWebSource,
  validateWebUrl,
  WebFetchError,
  type WebAddress,
  type WebFetchOptions,
} from "../server/web";

/* ── 真实 Express + 临时 SQLite 夹具（只监听回环地址） ───────────────── */

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

interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
}

class Client {
  private cookie?: string;
  constructor(private readonly base: string) {}

  async request(pathname: string, init: RequestOptions = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (unsafe) {
      headers["X-Zhixu-Request"] = "1";
      headers["Content-Type"] = init.contentType ?? "application/json";
    }
    if (this.cookie) headers.Cookie = this.cookie;

    const body: BodyInit | undefined =
      init.rawBody !== undefined
        ? (init.rawBody as BodyInit)
        : init.body !== undefined
          ? JSON.stringify(init.body)
          : unsafe
            ? "{}"
            : undefined;

    const response = await fetch(this.base + pathname, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
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

async function startHarness(
  overrides: Partial<Omit<AppConfig, "dataDir">> = {},
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-adversarial-"));
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

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  overrides: Partial<Omit<AppConfig, "dataDir">> = {},
): Promise<void> {
  const harness = await startHarness(overrides);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

/* ── 响应断言 ────────────────────────────────────────────────────────── */

const INTERNAL_MARKERS = [
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "node_modules",
  "SQLITE_",
  " at ",
];

async function jsonObject<T extends object>(
  response: Response,
  label: string,
): Promise<T> {
  const value: unknown = await response.json();
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label}必须是 JSON 对象`,
  );
  // 运行时已确认是普通对象；具体字段由调用方按接口契约断言。
  return value as T;
}

interface ErrorPayload {
  error: string;
  code?: string;
  revision?: number;
}

async function expect4xx(response: Response, label: string): Promise<ErrorPayload> {
  const status = response.status;
  const text = await response.text();
  assert.ok(
    status >= 400 && status < 500,
    `${label}：期望 4xx，实际 ${status}：${text.slice(0, 300)}`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`${label}：错误响应不是 JSON：${text.slice(0, 300)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    assert.fail(`${label}：错误响应必须是 JSON 对象`);
  }
  const value = parsed as Record<string, unknown>;
  const rawError = value.error;
  const message = typeof rawError === "string" ? rawError : "";
  assert.ok(message.length > 0, `${label}：错误响应缺少 error 文本`);
  const code = typeof value.code === "string" ? value.code : undefined;
  const revision =
    typeof value.revision === "number" ? value.revision : undefined;
  const serialized = JSON.stringify(value);
  for (const marker of INTERNAL_MARKERS) {
    assert.equal(
      serialized.includes(marker),
      false,
      `${label}：错误响应泄露内部细节「${marker}」`,
    );
  }
  return {
    error: message,
    ...(code === undefined ? {} : { code }),
    ...(revision === undefined ? {} : { revision }),
  };
}

/* ── 注册与数据夹具 ──────────────────────────────────────────────────── */

async function register(client: Client, label: string): Promise<string> {
  const response = await client.request("/api/auth/register", {
    method: "POST",
    body: { email: `${label}@example.com`, name: label, password: PASSWORD },
  });
  const body = await jsonObject<{ user?: { id?: unknown }; error?: unknown }>(
    response,
    "注册响应",
  );
  assert.equal(
    response.status,
    200,
    typeof body.error === "string" ? body.error : undefined,
  );
  const id = body.user?.id;
  if (typeof id !== "string" || id.length === 0) {
    assert.fail("注册必须返回用户 id");
  }
  return id;
}

const BACKUP_SETTINGS: StudyBackup["settingsWithoutSecrets"] = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
};

function sessionDoc(id: string): StudySession {
  return {
    id,
    title: "会话",
    topic: "主题",
    level: "从零开始",
    goal: "目标",
    messages: [],
    stageIndex: 0,
    completedStages: [],
    stageAnswers: {},
    plan: [],
    quiz: [],
    flashcards: [],
    quizAnswers: {},
    quizSubmitted: false,
    reviewedCards: [],
    references: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function noteDoc(id: string): Note {
  return {
    id,
    sessionId: "",
    title: "笔记",
    content: "内容",
    createdAt: 1,
  };
}

function validBackup(overrides: Partial<StudyBackup> = {}): StudyBackup {
  return {
    format: "zhixu-study-backup",
    version: 1,
    exportedAt: 1_700_000_000_000,
    sessions: [],
    notes: [],
    reviews: [],
    diagnostics: [],
    settingsWithoutSecrets: BACKUP_SETTINGS,
    activity: [],
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function bookMeta(
  id: string,
  bytes: Uint8Array,
  overrides: Partial<BookMetadata> = {},
): BookMetadata {
  return {
    id,
    title: "测试书",
    author: "测试作者",
    format: "txt",
    fileName: "测试书.txt",
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    importedAt: 1_700_000_000_000,
    chapters: [{ id: "c1", title: "第一章", blockIds: ["b1"] }],
    blocks: [{ id: "b1", chapterId: "c1", text: "第一段", locator: "第一章 · 第1段" }],
    warnings: [],
    ...overrides,
  };
}

/* ── 工作区：revision / data 对抗 ────────────────────────────────────── */

test("工作区 PUT：非法 revision 全部 4xx，且不推进 revision、不写入脏数据", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-workspace-rev");

    const invalidRevisions: unknown[] = [-1, 1.5, "1", 1e20, null, true, []];
    for (const revision of invalidRevisions) {
      const response = await client.request("/api/workspace", {
        method: "PUT",
        body: { revision, data: validBackup() },
      });
      const body = await expect4xx(response, `revision=${JSON.stringify(revision)}`);
      assert.equal(body.code, undefined, "revision 校验错误不应带错误码");
    }

    const missingData = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0 },
    });
    await expect4xx(missingData, "缺少 data");

    const hugeButValid = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: Number.MAX_SAFE_INTEGER, data: validBackup() },
    });
    const hugeBody = await expect4xx(hugeButValid, "极大 revision");
    assert.equal(hugeBody.code, "revision_conflict");
    assert.equal(hugeBody.revision, 0, "冲突响应必须返回服务端当前 revision");

    const workspace = await client.request("/api/workspace");
    const body = await jsonObject<{ revision?: unknown; data?: unknown }>(
      workspace,
      "工作区响应",
    );
    assert.equal(body.revision, 0, "攻击请求不得推进 revision");
    assert.equal(body.data, null, "攻击请求不得写入云端数据");
  });
});

test("工作区 PUT：恶意 data 结构、重复会话与超限墓碑全部拒绝，原数据保持不变", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-workspace-data");

    const attacks: Array<[string, unknown]> = [
      ["data 为数组", []],
      ["data 格式错误", { format: "x" }],
      [
        "墓碑超限",
        validBackup({
          deletedNoteIds: Array.from(
            { length: MAX_DELETED_NOTE_IDS + 1 },
            (_, index) => `note-${index}`,
          ),
        }),
      ],
      [
        "重复会话 ID",
        validBackup({
          sessions: [sessionDoc("duplicate"), sessionDoc("duplicate")],
        }),
      ],
    ];
    for (const [label, data] of attacks) {
      const response = await client.request("/api/workspace", {
        method: "PUT",
        body: { revision: 0, data },
      });
      await expect4xx(response, label);
    }

    // JSON.stringify 无法序列化的深层对象：等价于“循环引用”触发的序列化失败路径。
    const deepRaw =
      '{"revision":0,"data":{"a":' +
      "[".repeat(5_000) +
      "]".repeat(5_000) +
      "}}";
    const deep = await client.request("/api/workspace", {
      method: "PUT",
      rawBody: deepRaw,
    });
    await expect4xx(deep, "无法序列化的深层 data");

    const workspace = await client.request("/api/workspace");
    const body = await jsonObject<{ revision?: unknown; data?: unknown }>(
      workspace,
      "工作区响应",
    );
    assert.equal(body.revision, 0);
    assert.equal(body.data, null);
  });
});

test("工作区 PUT：旧 revision 冲突不覆盖已保存数据", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-workspace-conflict");

    const first = await client.request("/api/workspace", {
      method: "PUT",
      body: {
        revision: 0,
        data: validBackup({ notes: [noteDoc("note-kept")] }),
      },
    });
    const firstBody = await jsonObject<{ revision?: unknown; data?: unknown }>(
      first,
      "首次保存",
    );
    assert.equal(firstBody.revision, 1);
    assert.ok(firstBody.data !== null);

    const stale = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: validBackup() },
    });
    const conflict = await expect4xx(stale, "旧 revision 覆盖");
    assert.equal(conflict.code, "revision_conflict");
    assert.equal(conflict.revision, 1);

    const current = await client.request("/api/workspace");
    const currentBody = await jsonObject<{ revision?: unknown; data?: unknown }>(
      current,
      "当前工作区",
    );
    assert.equal(currentBody.revision, 1);
    assert.equal(
      JSON.stringify(currentBody.data),
      JSON.stringify(firstBody.data),
      "冲突请求不得改动已保存数据",
    );
  });
});

test("工作区墓碑：旧快照回写已删除笔记被拒绝，删除决定保持", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-workspace-tombstone");

    const withNote = validBackup({ notes: [noteDoc("note-gone")] });
    const saved = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 0, data: withNote },
    });
    assert.equal(saved.status, 200);

    const deleted = await client.request("/api/workspace", {
      method: "PUT",
      body: {
        revision: 1,
        data: validBackup({
          notes: [],
          deletedNoteIds: ["note-gone"],
        }),
      },
    });
    assert.equal(deleted.status, 200);

    const resurrect = await client.request("/api/workspace", {
      method: "PUT",
      body: { revision: 2, data: withNote },
    });
    const conflict = await expect4xx(resurrect, "复活已删除笔记");
    assert.equal(conflict.code, "note_tombstoned");
    assert.equal(conflict.revision, 2);

    const current = await client.request("/api/workspace");
    const body = await jsonObject<{
      revision?: unknown;
      data?: { notes?: unknown; deletedNoteIds?: unknown };
    }>(current, "当前工作区");
    assert.equal(body.revision, 2);
    assert.deepEqual(body.data?.notes, [], "旧快照不得复活已删除笔记");
    assert.deepEqual(body.data?.deletedNoteIds, ["note-gone"]);
  });
});

/* ── 账户绑定：X-Zhixu-User 越权读写 ─────────────────────────────────── */

test("X-Zhixu-User 为他人/不存在/空字符串时拒绝读写，且不泄露账户数据", async () => {
  await withHarness(
    async (harness) => {
      const a = harness.client();
      const b = harness.client();
      const userA = await register(a, "adv-binding-a");
      const userB = await register(b, "adv-binding-b");
      assert.notEqual(userA, userB);

      const secret = "sk-binding-secret";
      const savedCredentials = await a.request("/api/credentials", {
        method: "PUT",
        body: {
          settings: {
            provider: "gemini",
            apiKey: secret,
            model: "gemini-2.5-flash",
            baseUrl: "https://generativelanguage.googleapis.com",
          },
        },
      });
      assert.equal(savedCredentials.status, 200);

      await a.request("/api/workspace", {
        method: "PUT",
        body: {
          revision: 0,
          data: validBackup({
            sessions: [
              {
                ...sessionDoc("session-only-a"),
                title: "只属于账户 A 的标题",
              },
            ],
          }),
        },
      });

      const foreignHeaders = [userB, "does-not-exist", ""];
      for (const header of foreignHeaders) {
        const credentials = await a.request("/api/credentials", {
          headers: { "X-Zhixu-User": header },
        });
        const credentialsError = await expect4xx(
          credentials,
          `GET credentials header=${JSON.stringify(header)}`,
        );
        assert.equal(credentialsError.code, "account_mismatch");
        assert.equal(credentialsError.error.includes(secret), false);

        const deniedSave = await a.request("/api/credentials", {
          method: "PUT",
          headers: { "X-Zhixu-User": header },
          body: {
            settings: {
              provider: "gemini",
              apiKey: "sk-overwritten-by-attacker",
              model: "gemini-2.5-flash",
              baseUrl: "https://generativelanguage.googleapis.com",
            },
          },
        });
        const saveError = await expect4xx(
          deniedSave,
          `PUT credentials header=${JSON.stringify(header)}`,
        );
        assert.equal(saveError.code, "account_mismatch");

        const workspace = await a.request("/api/workspace", {
          headers: { "X-Zhixu-User": header },
        });
        const workspaceError = await expect4xx(
          workspace,
          `GET workspace header=${JSON.stringify(header)}`,
        );
        assert.equal(workspaceError.code, "account_mismatch");
        assert.equal(workspaceError.error.includes("只属于账户 A 的标题"), false);
      }

      const ownCredentials = await a.request("/api/credentials");
      const credentialsBody = await jsonObject<{
        settings?: { apiKey?: unknown } | null;
      }>(ownCredentials, "自己的凭据");
      assert.equal(credentialsBody.settings?.apiKey, secret, "越权写入不得覆盖原凭据");

      const bCredentials = await b.request("/api/credentials");
      const bCredentialsBody = await jsonObject<{
        settings?: unknown;
      }>(bCredentials, "账户 B 的凭据");
      assert.equal(bCredentialsBody.settings, null, "账户 B 不能看到账户 A 的凭据");

      const ownWorkspace = await a.request("/api/workspace");
      const ownWorkspaceBody = await jsonObject<{
        data?: { sessions?: Array<{ title?: unknown }> } | null;
      }>(ownWorkspace, "自己的工作区");
      assert.equal(
        ownWorkspaceBody.data?.sessions?.[0]?.title,
        "只属于账户 A 的标题",
      );

      const bWorkspace = await b.request("/api/workspace");
      const bWorkspaceBody = await jsonObject<{
        revision?: unknown;
        data?: unknown;
      }>(bWorkspace, "账户 B 的工作区");
      assert.equal(bWorkspaceBody.revision, 0);
      assert.equal(bWorkspaceBody.data, null, "账户 B 不能看到账户 A 的工作区");
    },
    { allowByok: true },
  );
});

/* ── 书架：元数据、两阶段上传、跨账户隔离 ────────────────────────────── */

function putMeta(
  client: Client,
  meta: BookMetadata,
  headers: Record<string, string> = {},
): Promise<Response> {
  return client.request(`/api/library/books/${meta.id}/meta`, {
    method: "PUT",
    body: meta,
    headers,
  });
}

function putOriginal(
  client: Client,
  id: string,
  bytes: Uint8Array,
): Promise<Response> {
  return client.request(`/api/library/books/${id}/original`, {
    method: "PUT",
    rawBody: bytes,
    contentType: "application/octet-stream",
  });
}

interface ShelfBook {
  id?: unknown;
  byteLength?: unknown;
  title?: unknown;
}

async function shelfOf(client: Client): Promise<{ books: ShelfBook[]; deleted: unknown[] }> {
  const response = await client.request("/api/library/books");
  const body = await jsonObject<{ books?: unknown; deleted?: unknown }>(
    response,
    "书架响应",
  );
  assert.ok(Array.isArray(body.books), "books 必须是数组");
  assert.ok(Array.isArray(body.deleted), "deleted 必须是数组");
  return { books: body.books as ShelfBook[], deleted: body.deleted };
}

test("书架元数据：id 不一致、非法 sha256、非法 byteLength 全部 4xx", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-library-meta");
    const bytes = Buffer.from("hello book", "utf8");
    const id = "book-probe";
    const base = bookMeta(id, bytes);

    const attacks: Array<[string, BookMetadata, string]> = [
      ["body id 与路径不一致", { ...base, id: "other-book" }, id],
      ["sha256 非十六进制", { ...base, sha256: "z".repeat(64) }, id],
      ["sha256 大写", { ...base, sha256: "A".repeat(64) }, id],
      ["sha256 长度不足", { ...base, sha256: "abc" }, id],
      ["byteLength 为负", { ...base, byteLength: -1 }, id],
      ["byteLength 非整数", { ...base, byteLength: 1.5 }, id],
      ["byteLength 超出安全整数", { ...base, byteLength: 2 ** 53 }, id],
      ["路径 id 大写", base, "BOOK-1"],
      ["路径 id 含点", base, "book.1"],
    ];

    for (const [label, meta, pathId] of attacks) {
      const response = await client.request(`/api/library/books/${pathId}/meta`, {
        method: "PUT",
        body: meta,
      });
      await expect4xx(response, label);
    }

    const shelf = await shelfOf(client);
    assert.deepEqual(shelf.books, [], "恶意元数据不得出现在书架");
    assert.deepEqual(shelf.deleted, [], "恶意元数据不得写入删除记录");
  });
});

test("书架元数据：声明原文件超过 30 MiB 时必须拒绝（永远无法完成第二阶段上传）", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-library-oversize");
    const bytes = Buffer.from("tiny file", "utf8");
    const meta = bookMeta("book-oversize", bytes, {
      byteLength: MAX_BOOK_ORIGINAL_BYTES + 1,
    });
    const response = await putMeta(client, meta);
    assert.ok(
      response.status >= 400 && response.status < 500,
      `声明 byteLength=${meta.byteLength}（上限 ${MAX_BOOK_ORIGINAL_BYTES}）的元数据被接受（HTTP ${response.status}）：` +
        "该记录永远无法与真实原文件匹配，却占用书架配额并让客户端误以为同步成功。",
    );
  });
});

test("书架两阶段上传：sha256/长度不一致被拒绝，跨账户不能读取或删除", async () => {
  await withHarness(async (harness) => {
    const a = harness.client();
    const b = harness.client();
    await register(a, "adv-library-a");
    await register(b, "adv-library-b");

    const bytes = Buffer.from("第一段\n\n第二段\n", "utf8");
    const meta = bookMeta("book-iso", bytes);
    assert.equal((await putMeta(a, meta)).status, 200);

    const wrongBytes = Buffer.from("完全不同内容", "utf8");
    const mismatch = await putOriginal(a, meta.id, wrongBytes);
    const mismatchError = await expect4xx(mismatch, "原文件与元数据不一致");
    assert.equal(mismatchError.code, "sha_mismatch");
    assert.deepEqual((await shelfOf(a)).books, [], "校验失败不得产生 ready 书");

    const uploaded = await putOriginal(a, meta.id, bytes);
    assert.equal(uploaded.status, 200);
    const uploadBody = await jsonObject<{
      sha256?: unknown;
      byteLength?: unknown;
    }>(uploaded, "原文件上传响应");
    assert.equal(uploadBody.sha256, sha256(bytes));
    assert.equal(uploadBody.byteLength, bytes.byteLength);

    const shelf = await shelfOf(a);
    assert.equal(shelf.books.length, 1);
    assert.equal(shelf.books[0].id, meta.id);
    assert.equal(shelf.books[0].byteLength, bytes.byteLength);

    const metaResponse = await a.request(`/api/library/books/${meta.id}/meta`);
    const metaBody = await jsonObject<{ meta?: BookMetadata }>(
      metaResponse,
      "书目元数据",
    );
    assert.equal(metaBody.meta?.title, meta.title);

    const download = await a.request(`/api/library/books/${meta.id}/original`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("x-book-sha256"), sha256(bytes));
    const downloaded = new Uint8Array(await download.arrayBuffer());
    assert.deepEqual([...downloaded], [...bytes], "下载必须与原文件字节一致");

    assert.deepEqual((await shelfOf(b)).books, [], "账户 B 看不到账户 A 的书");
    await expect4xx(
      await b.request(`/api/library/books/${meta.id}/meta`),
      "跨账户读取元数据",
    );
    await expect4xx(
      await b.request(`/api/library/books/${meta.id}/original`),
      "跨账户下载原文件",
    );
    const deleteByB = await b.request(`/api/library/books/${meta.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteByB.status, 200, "删除不存在的书保持幂等");
    assert.equal((await shelfOf(a)).books.length, 1, "账户 B 不得删除账户 A 的书");
    const stillThere = await a.request(`/api/library/books/${meta.id}/original`);
    assert.equal(stillThere.status, 200, "账户 A 的原文件仍可下载");
  });
});

test("书架删除墓碑：旧设备不能静默复活已删书，显式重新导入才可恢复", async () => {
  await withHarness(async (harness) => {
    const client = harness.client();
    await register(client, "adv-library-tomb");
    const bytes = Buffer.from("可删除的书", "utf8");
    const meta = bookMeta("book-tomb", bytes);

    assert.equal((await putMeta(client, meta)).status, 200);
    assert.equal((await putOriginal(client, meta.id, bytes)).status, 200);
    assert.equal((await shelfOf(client)).books.length, 1);

    const deleted = await client.request(`/api/library/books/${meta.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await shelfOf(client);
    assert.deepEqual(afterDelete.books, []);
    assert.deepEqual(afterDelete.deleted, [meta.id]);

    const resurrect = await putMeta(client, meta);
    const resurrectError = await expect4xx(resurrect, "旧元数据复活已删书");
    assert.equal(resurrectError.code, "book_deleted");
    assert.deepEqual((await shelfOf(client)).books, []);

    const reimport = await putMeta(client, meta, { "X-Zhixu-Reimport": "1" });
    assert.equal(reimport.status, 200, "显式重新导入必须可以清除墓碑");
    assert.deepEqual((await shelfOf(client)).deleted, []);
    assert.equal((await putOriginal(client, meta.id, bytes)).status, 200);
    assert.equal((await shelfOf(client)).books.length, 1);
  });
});

/* ── 网页抓取：SSRF / 跳转 / 内容类型 ───────────────────────────────── */

const PUBLIC_ADDRESS: WebAddress = { address: "93.184.216.34", family: 4 };

const publicLookup: NonNullable<WebFetchOptions["lookup"]> = async () => [
  PUBLIC_ADDRESS,
];

function expectWebError(
  run: () => unknown,
  status: number,
  code: string,
  label = "网页抓取",
): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WebFetchError &&
      error.status === status &&
      error.code === code &&
      error.message.length > 0,
    `${label}：期望 WebFetchError ${status}/${code}`,
  );
}

test("SSRF：用户名密码、非 443 端口、回环/IPv6/内网域名全部在联网前拒绝", () => {
  const blocked: Array<[string, string, number, string]> = [
    ["URL 带用户名密码", "https://user:pass@example.com/doc", 400, "credentials_not_allowed"],
    ["URL 用用户信息伪装主机", "https://example.com@127.0.0.1/doc", 400, "credentials_not_allowed"],
    ["非 443 端口", "https://example.com:9999/doc", 403, "port_not_allowed"],
    ["IPv6 回环", "https://[::1]/doc", 403, "private_host"],
    ["IPv4 映射回环", "https://[::ffff:127.0.0.1]/doc", 403, "private_host"],
    ["IPv4 回环", "https://127.0.0.1/doc", 403, "private_host"],
    ["十进制 IP", "https://2130706433/doc", 403, "private_host"],
    ["十六进制 IP", "https://0x7f000001/doc", 403, "private_host"],
    ["localhost", "https://localhost/doc", 403, "private_host"],
    ["mDNS .local", "https://printer.local/doc", 403, "private_host"],
    ["云元数据 .internal", "https://metadata.internal/doc", 403, "private_host"],
    ["明文 HTTP", "http://example.com/doc", 400, "https_required"],
    ["file 协议", "file:///etc/passwd", 400, "https_required"],
  ];
  for (const [label, url, status, code] of blocked) {
    expectWebError(() => validateWebUrl(url, []), status, code, label);
  }

  assert.equal(
    validateWebUrl("https://example.com/doc", []).hostname,
    "example.com",
    "普通公网 HTTPS 必须仍可用",
  );
  assert.equal(validateWebUrl("https://example.com:443/doc", []).port, "");
  assert.equal(
    validateWebUrl("https://docs.example.com/doc", ["example.com"]).hostname,
    "docs.example.com",
  );
  expectWebError(
    () => validateWebUrl("https://evil.example.net/doc", ["example.com"]),
    403,
    "host_not_allowed",
  );
});

test("SSRF：DNS 解析到内网或混合公网/内网时不会发起连接", async () => {
  const lookups: Array<() => Promise<WebAddress[]>> = [
    async () => [{ address: "10.0.0.5", family: 4 }],
    async () => [PUBLIC_ADDRESS, { address: "192.168.1.10", family: 4 }],
    async () => [{ address: "::1", family: 6 }],
  ];
  for (const lookup of lookups) {
    let transports = 0;
    await assert.rejects(
      fetchWebSource("https://rebind.example/doc", undefined, {
        allowedHosts: [],
        lookup,
        transport: async () => {
          transports += 1;
          return new Response("不应连接", { status: 200 });
        },
      }),
      (error: unknown) =>
        error instanceof WebFetchError &&
        error.status === 403 &&
        error.code === "private_host",
    );
    assert.equal(transports, 0, "解析到内网时传输层一次都不能调用");
  }
});

test("跳转：到内网/非 443/带凭据的跳转目标被逐跳校验拒绝", async () => {
  const targets: Array<[string, number, string]> = [
    ["https://127.0.0.1/secret", 403, "private_host"],
    ["https://example.com:9999/secret", 403, "port_not_allowed"],
    ["https://user:pass@example.com/secret", 400, "credentials_not_allowed"],
    ["http://example.com/secret", 400, "https_required"],
  ];
  for (const [location, status, code] of targets) {
    let calls = 0;
    await assert.rejects(
      fetchWebSource("https://example.com/start", undefined, {
        allowedHosts: [],
        lookup: publicLookup,
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, {
            status: 302,
            headers: { location },
          });
        },
      }),
      (error: unknown) =>
        error instanceof WebFetchError &&
        error.status === status &&
        error.code === code,
      location,
    );
    assert.equal(calls, 1, "恶意跳转目标不能触发第二次网络请求");
  }
});

test("跳转：循环跳转在固定上限内终止，不会无限放大请求", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWebSource("https://example.com/start", undefined, {
      allowedHosts: [],
      lookup: publicLookup,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "/next" },
        });
      },
    }),
    (error: unknown) =>
      error instanceof WebFetchError &&
      error.status === 502 &&
      error.code === "too_many_redirects",
  );
  assert.ok(calls > 0 && calls <= 4, `跳转请求次数必须受限，实际 ${calls}`);
});

test("内容类型：非文本类型拒绝；二进制伪装 text/html 不崩溃且不越过正文上限", async () => {
  await assert.rejects(
    fetchWebSource("https://example.com/blob", undefined, {
      allowedHosts: [],
      lookup: publicLookup,
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    }),
    (error: unknown) =>
      error instanceof WebFetchError &&
      error.status === 415 &&
      error.code === "unsupported_content_type",
  );

  const binary = new Uint8Array([
    0, 1, 2, 3, 255, 254, 60, 115, 99, 114, 105, 112, 116, 62, 7, 8,
  ]);
  const options: WebFetchOptions = {
    allowedHosts: [],
    lookup: publicLookup,
    maxTextChars: 64,
    fetchImpl: async () =>
      new Response(binary, {
        status: 200,
        headers: { "content-type": "text/html; charset=bogus" },
      }),
  };
  let text: string | null = null;
  try {
    const evidence = await fetchWebSource("https://example.com/bin", undefined, options);
    text = evidence.text;
    assert.ok(evidence.finalUrl.startsWith("https://example.com/"));
    assert.equal(evidence.publisher, "example.com");
    assert.equal(typeof evidence.title, "string");
  } catch (error) {
    assert.ok(
      error instanceof WebFetchError && error.status >= 400 && error.status < 500,
      `二进制正文只能被 4xx 拒绝或安全地截断，实际抛出 ${String(error)}`,
    );
  }
  if (text !== null) {
    assert.ok(text.length <= 64, "正文必须受 maxTextChars 限制");
    assert.equal(text.includes("<script>"), false, "原始标签不能原样进入来源正文");
  }
});

test("正文超限：声明或实际字节超过 maxBytes 时返回 413，且不提交残缺证据", async () => {
  await assert.rejects(
    fetchWebSource("https://example.com/huge", undefined, {
      allowedHosts: [],
      lookup: publicLookup,
      maxBytes: 64,
      fetchImpl: async () =>
        new Response("x".repeat(200), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    }),
    (error: unknown) =>
      error instanceof WebFetchError &&
      error.status === 413 &&
      error.code === "page_too_large",
  );

  await assert.rejects(
    fetchWebSource("https://example.com/lying-length", undefined, {
      allowedHosts: [],
      lookup: publicLookup,
      maxBytes: 64,
      fetchImpl: async () =>
        new Response("short", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": "1000",
          },
        }),
    }),
    (error: unknown) =>
      error instanceof WebFetchError &&
      error.status === 413 &&
      error.code === "page_too_large",
  );
});

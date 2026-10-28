import assert from "node:assert/strict";
import test from "node:test";
import type { DiagnosticProfile, Note, ReviewItem, StudyBackup, StudySession } from "../src/types";
import {
  calibratedNow,
  calibrateClock,
  CloudSyncError,
  deleteCloudNote,
  getClockOffset,
  getWorkspace,
  login,
  logout,
  me,
  mergeLocalWithCloud,
  register,
  resetClockCalibration,
  syncWorkspace,
  type Fetcher,
} from "../src/lib/cloudSync";
import { parseBackup } from "../src/lib/backup";

/* ── 夹具：必须能通过 parseBackup 的全部校验 ──────────────────── */

const SETTINGS = {
  provider: "gemini" as const,
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
};

const LOCAL_SETTINGS = { ...SETTINGS, model: "local-model" };
const CLOUD_SETTINGS = { ...SETTINGS, model: "cloud-model" };

function sessionFixture(id: string, updatedAt: number, extraMessage?: string): StudySession {
  const messages: StudySession["messages"] = [
    { id: `${id}-m1`, role: "user", content: "什么是单位净值？", timestamp: 1 },
    {
      id: `${id}-m2`,
      role: "assistant",
      content: "单位净值是每份产品当前的价值。",
      timestamp: 2,
    },
  ];
  if (extraMessage) {
    messages.push({
      id: `${id}-m3`,
      role: "user",
      content: extraMessage,
      timestamp: 3,
    });
  }
  return {
    id,
    title: `会话 ${id}`,
    topic: "银行理财",
    level: "从零开始",
    goal: "理解净值机制",
    messages,
    stageIndex: 0,
    completedStages: [],
    stageAnswers: {},
    plan: ["先讲概念"],
    quiz: [],
    flashcards: [],
    quizAnswers: {},
    quizSubmitted: false,
    reviewedCards: [],
    references: [],
    createdAt: 1,
    updatedAt,
  };
}

function noteFixture(id: string, sessionId = "s-local"): Note {
  return {
    id,
    sessionId,
    title: "净值笔记",
    content: `${id} 的内容：单位净值每份当前价值。`,
    createdAt: 50,
  };
}

function reviewFixture(id: string, sessionId = "s-local"): ReviewItem {
  return {
    id,
    sessionId,
    topic: "银行理财",
    questionId: "s-local-q1",
    prompt: "分红从哪里支付？",
    kind: "quiz",
    reason: "测验答错",
    hint: "想清楚钱的来源。",
    learnerQuote: "分红是额外发的钱",
    correctExplanation: "分红从产品资产中转出。",
    createdAt: 100,
    dueAt: 200,
    intervalDays: 1,
    streak: 0,
    attempts: 1,
    lastOutcome: "again",
    source: "quiz",
  };
}

function diagnosticFixture(id: string): DiagnosticProfile {
  return {
    id,
    topic: "银行理财",
    level: "从零开始",
    questions: [
      {
        id: `${id}-q1`,
        question: "累计净值是否扣除分红？",
        options: ["不扣除", "扣除"],
        correctIndex: 0,
        explanation: "累计净值把历史分红加回。",
        hint: "对比单位净值。",
      },
    ],
    answers: { [`${id}-q1`]: 1 },
    submitted: true,
    evaluatedAt: 300,
    recommendedStepIndex: 0,
    evidenceSummary: ["对分红机制判断错误"],
    weakConcepts: ["累计净值"],
    skippedConcepts: [],
  };
}

interface LocalData {
  sessions: StudySession[];
  notes: Note[];
  reviews: ReviewItem[];
  diagnostics: DiagnosticProfile[];
  activity: string[];
  deletedNoteIds?: string[];
  settingsUpdatedAt?: number;
}

/** 备份要求诊断记录挂在所属会话上。 */
function withDiagnostic(session: StudySession, profile: DiagnosticProfile): StudySession {
  return { ...session, diagnostic: profile };
}

function localData(overrides: Partial<LocalData> = {}): LocalData {
  return {
    sessions: [sessionFixture("s-local", 100)],
    notes: [noteFixture("n-local")],
    reviews: [],
    diagnostics: [],
    activity: ["2026-10-24"],
    ...overrides,
  };
}

function cloudBackup(overrides: Partial<StudyBackup> = {}): StudyBackup {
  return {
    format: "zhixu-study-backup",
    version: 1,
    exportedAt: 500,
    sessions: [sessionFixture("s-cloud", 200)],
    notes: [noteFixture("n-cloud", "s-cloud")],
    reviews: [],
    diagnostics: [],
    settingsWithoutSecrets: SETTINGS,
    activity: ["2026-10-25"],
    ...overrides,
  };
}

/* ── 合并：双方数据都不丢 ─────────────────────────────────────── */

test("合并：本地与云端双方独有的会话和笔记都保留", () => {
  const outcome = mergeLocalWithCloud(
    localData({
      sessions: [sessionFixture("s-local", 100)],
      notes: [noteFixture("n-local")],
    }),
    SETTINGS,
    cloudBackup(),
  );
  const ids = outcome.backup.sessions.map((s) => s.id);
  assert.ok(ids.includes("s-local"), "本地会话不能丢");
  assert.ok(ids.includes("s-cloud"), "云端会话不能丢");
  const noteIds = outcome.backup.notes.map((n) => n.id);
  assert.ok(noteIds.includes("n-local"), "本地笔记不能丢");
  assert.ok(noteIds.includes("n-cloud"), "云端笔记不能丢");
  assert.ok(outcome.fromCloud.sessions >= 1);
  assert.ok(outcome.toCloud.sessions >= 1);
  // 合并结果必须仍能通过完整备份校验（会被原样上传）。
  assert.deepEqual(parseBackup(JSON.stringify(outcome.backup)), outcome.backup);
});

test("合并：同一会话双方消息增量双向保留", () => {
  // 本地 s1 多了一条消息；云端 s1 是旧快照 → 合并后本地消息仍在。
  const outcome = mergeLocalWithCloud(
    localData({ sessions: [sessionFixture("s1", 300, "这是我后来的追问")] }),
    SETTINGS,
    cloudBackup({ sessions: [sessionFixture("s1", 100)] }),
  );
  const merged = outcome.backup.sessions.find((s) => s.id === "s1");
  assert.ok(merged);
  assert.ok(
    merged.messages.some((m) => m.content === "这是我后来的追问"),
    "本地新增消息不能被云端旧快照覆盖",
  );
  assert.ok(merged.messages.length >= 2);
});

test("合并：复习项与诊断从双方并集保留，活动日期合并", () => {
  const localDiagnostic = diagnosticFixture("d-local");
  const cloudDiagnostic = diagnosticFixture("d-cloud");
  const outcome = mergeLocalWithCloud(
    localData({
      sessions: [withDiagnostic(sessionFixture("s-local", 100), localDiagnostic)],
      reviews: [reviewFixture("r-local", "s-local")],
      diagnostics: [localDiagnostic],
      activity: ["2026-10-01"],
    }),
    SETTINGS,
    cloudBackup({
      sessions: [withDiagnostic(sessionFixture("s-cloud", 200), cloudDiagnostic)],
      reviews: [reviewFixture("r-cloud", "s-cloud")],
      diagnostics: [cloudDiagnostic],
      activity: ["2026-10-02"],
    }),
  );
  const reviewIds = outcome.backup.reviews.map((r) => r.id);
  assert.ok(reviewIds.includes("r-local") && reviewIds.includes("r-cloud"));
  const diagIds = outcome.backup.diagnostics.map((d) => d.id);
  assert.ok(diagIds.includes("d-local") && diagIds.includes("d-cloud"));
  assert.ok(outcome.backup.activity.includes("2026-10-01"));
  assert.ok(outcome.backup.activity.includes("2026-10-02"));
  // 合并结果会被原样上传，必须仍能通过完整备份校验。
  assert.deepEqual(parseBackup(JSON.stringify(outcome.backup)), outcome.backup);
});

test("合并：云端为空时整个本地数据作为迁移内容上传", () => {
  const outcome = mergeLocalWithCloud(localData(), SETTINGS, null);
  assert.equal(outcome.backup.sessions.length, 1);
  assert.equal(outcome.backup.sessions[0].id, "s-local");
  assert.equal(outcome.fromCloud.sessions, 0);
  assert.equal(outcome.toCloud.sessions, 1);
  assert.ok(outcome.toCloud.notes >= 1);
  // 迁移结果必须能通过 parseBackup（服务端会校验同一格式）。
  assert.deepEqual(parseBackup(JSON.stringify(outcome.backup)), outcome.backup);
});

test("合并：备份绝不包含 apiKey", () => {
  const outcome = mergeLocalWithCloud(localData(), SETTINGS, cloudBackup());
  assert.equal("apiKey" in outcome.backup, false);
  assert.ok(!JSON.stringify(outcome.backup).toLowerCase().includes('"apikey"'));
});

test("墓碑并集：本地删除的云端笔记与云端删除的本地笔记都不会复活", () => {
  const outcome = mergeLocalWithCloud(
    localData({
      notes: [noteFixture("n-local"), noteFixture("n-cloud", "s-cloud")],
      deletedNoteIds: ["n-cloud"],
    }),
    SETTINGS,
    cloudBackup({
      notes: [noteFixture("n-cloud", "s-cloud"), noteFixture("n-local")],
      deletedNoteIds: ["n-local"],
    }),
  );
  assert.deepEqual(outcome.backup.notes, [], "双方墓碑过滤各自及对方的已删笔记");
  assert.deepEqual(outcome.backup.deletedNoteIds, ["n-cloud", "n-local"]);
  assert.equal(outcome.fromCloud.notes, 0, "被墓碑拦下的笔记不计入云端导入");
  assert.deepEqual(parseBackup(JSON.stringify(outcome.backup)), outcome.backup);
});

test("墓碑：云端旧快照不能复活本地刚删除的笔记，上传结果保留墓碑", () => {
  const outcome = mergeLocalWithCloud(
    localData({ notes: [], deletedNoteIds: ["was-deleted"] }),
    SETTINGS,
    cloudBackup({ notes: [noteFixture("was-deleted")], deletedNoteIds: [] }),
  );
  assert.equal(outcome.backup.notes.length, 0);
  assert.deepEqual(outcome.backup.deletedNoteIds, ["was-deleted"]);
});

test("设置版本：云端更新时覆盖本地，较旧/无版本不覆盖并上传本地时间戳", () => {
  const cloudNewer = mergeLocalWithCloud(
    localData({ settingsUpdatedAt: 100 }),
    LOCAL_SETTINGS,
    cloudBackup({ settingsWithoutSecrets: CLOUD_SETTINGS, settingsUpdatedAt: 300 }),
  );
  assert.deepEqual(cloudNewer.backup.settingsWithoutSecrets, CLOUD_SETTINGS);
  assert.equal(cloudNewer.backup.settingsUpdatedAt, 300);

  const localNewer = mergeLocalWithCloud(
    localData({ settingsUpdatedAt: 500 }),
    LOCAL_SETTINGS,
    cloudBackup({ settingsWithoutSecrets: CLOUD_SETTINGS, settingsUpdatedAt: 100 }),
  );
  assert.deepEqual(localNewer.backup.settingsWithoutSecrets, LOCAL_SETTINGS);
  assert.equal(localNewer.backup.settingsUpdatedAt, 500);

  // 云端是无版本的旧备份（按 0 处理）：不能覆盖本地较新的设置。
  const legacyCloud = mergeLocalWithCloud(
    localData({ settingsUpdatedAt: 500 }),
    LOCAL_SETTINGS,
    cloudBackup({ settingsWithoutSecrets: CLOUD_SETTINGS }),
  );
  assert.deepEqual(legacyCloud.backup.settingsWithoutSecrets, LOCAL_SETTINGS);
  assert.equal(legacyCloud.backup.settingsUpdatedAt, 500);

  // 本地无版本、云端带版本：采用云端设置与时间戳，便于跨设备恢复。
  const localLegacy = mergeLocalWithCloud(
    localData(),
    LOCAL_SETTINGS,
    cloudBackup({ settingsWithoutSecrets: CLOUD_SETTINGS, settingsUpdatedAt: 50 }),
  );
  assert.deepEqual(localLegacy.backup.settingsWithoutSecrets, CLOUD_SETTINGS);
  assert.equal(localLegacy.backup.settingsUpdatedAt, 50);

  for (const outcome of [cloudNewer, localNewer, legacyCloud, localLegacy]) {
    assert.deepEqual(parseBackup(JSON.stringify(outcome.backup)), outcome.backup);
  }
});

test("syncWorkspace：上传本地较新的设置版本与墓碑", async () => {
  const cloud = cloudBackup({
    settingsWithoutSecrets: CLOUD_SETTINGS,
    settingsUpdatedAt: 100,
  });
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 5, data: cloud }),
  ]);
  const result = await syncWorkspace(fetcher, {
    local: localData({ deletedNoteIds: ["n-removed"], settingsUpdatedAt: 900 }),
    settingsWithoutSecrets: LOCAL_SETTINGS,
    workspace: { revision: 4, data: cloud },
  });
  const uploaded = JSON.parse(calls[0].init?.body as string) as {
    revision: number;
    data: StudyBackup;
  };
  assert.equal(uploaded.data.settingsUpdatedAt, 900);
  assert.deepEqual(uploaded.data.settingsWithoutSecrets, LOCAL_SETTINGS);
  assert.deepEqual(uploaded.data.deletedNoteIds, ["n-removed"]);
  assert.deepEqual(parseBackup(JSON.stringify(uploaded.data)), uploaded.data);
  assert.equal(result.workspace.revision, 5);
});

test("syncWorkspace：云端设置更新时上传云端版本，不用本地旧值覆盖", async () => {
  const cloud = cloudBackup({
    settingsWithoutSecrets: CLOUD_SETTINGS,
    settingsUpdatedAt: 800,
  });
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 6, data: cloud }),
  ]);
  await syncWorkspace(fetcher, {
    local: localData({ settingsUpdatedAt: 100 }),
    settingsWithoutSecrets: LOCAL_SETTINGS,
    workspace: { revision: 5, data: cloud },
  });
  const uploaded = JSON.parse(calls[0].init?.body as string) as {
    data: StudyBackup;
  };
  assert.equal(uploaded.data.settingsUpdatedAt, 800);
  assert.deepEqual(uploaded.data.settingsWithoutSecrets, CLOUD_SETTINGS);
});

/* ── syncWorkspace：revision 冲突重试 ────────────────────────── */

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 记录调用序列的 fetcher 构造器：按脚本逐个返回响应。 */
function scriptedFetcher(responses: Array<(init?: RequestInit) => Response>): {
  fetcher: Fetcher;
  calls: Array<{ path: string; init?: RequestInit }>;
} {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: (path, init) => {
      calls.push({ path, init });
      const next = responses.shift();
      if (!next) throw new Error("脚本响应耗尽");
      return Promise.resolve(next(init));
    },
  };
}

const EMPTY_WORKSPACE = { revision: 1, data: null };

test("409 冲突：重取云端合并后重试一次即成功", async () => {
  const conflictingCloud = cloudBackup();
  const { fetcher, calls } = scriptedFetcher([
    // 第一次 PUT：过期 revision → 409 只带 revision 等元信息，不携带 data。
    () =>
      jsonResponse(409, {
        error: "数据已被其他设备更新",
        code: "revision_conflict",
        revision: 7,
      }),
    // 客户端应重取 GET /api/workspace。
    () => jsonResponse(200, { revision: 7, data: conflictingCloud }),
    // 第二次 PUT：成功。
    () => jsonResponse(200, { revision: 8, data: conflictingCloud }),
  ]);
  const result = await syncWorkspace(fetcher, {
    local: localData(),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 1, data: null },
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/workspace", "/api/workspace", "/api/workspace"],
  );
  assert.equal(calls[0].init?.method, "PUT");
  // GET /api/workspace 不带 method 字段（fetch 默认 GET）。
  assert.equal(calls[1].init?.method, undefined);
  assert.equal(calls[2].init?.method, "PUT");
  assert.equal(result.workspace.revision, 8);
  assert.equal(result.refreshed, true);
  // 重试前重新合并：上传的备份同时包含双方会话。
  const uploaded = JSON.parse(calls[2].init?.body as string) as { data: StudyBackup };
  const ids = uploaded.data.sessions.map((s) => s.id);
  assert.ok(ids.includes("s-local") && ids.includes("s-cloud"));
});

test("409 冲突：重试仍失败时不覆盖云端并抛错", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () =>
      jsonResponse(409, {
        error: "数据已被其他设备更新",
        code: "revision_conflict",
        revision: 7,
      }),
    () => jsonResponse(200, { revision: 7, data: null }),
    () =>
      jsonResponse(409, {
        error: "数据又被更新了",
        code: "revision_conflict",
        revision: 9,
      }),
  ]);
  await assert.rejects(
    syncWorkspace(fetcher, {
      local: localData(),
      settingsWithoutSecrets: SETTINGS,
      workspace: { revision: 1, data: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "revision_conflict");
      return true;
    },
  );
  // 恰好两次 PUT、一次重取；第二次冲突后不再第三次尝试。
  assert.deepEqual(
    calls.map((c) => c.init?.method ?? "GET"),
    ["PUT", "GET", "PUT"],
  );
});

test("401 处理：会话过期时原样抛出 CloudSyncError 且不重试写", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(401, { error: "登录已过期" }),
  ]);
  await assert.rejects(
    syncWorkspace(fetcher, {
      local: localData(),
      settingsWithoutSecrets: SETTINGS,
      workspace: EMPTY_WORKSPACE,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.status, 401);
      return true;
    },
  );
  assert.deepEqual(
    calls.map((c) => c.init?.method),
    ["PUT"],
  );
});

test("429 限流：携带服务端 message 与 Retry-After", async () => {
  const { fetcher } = scriptedFetcher([
    () =>
      jsonResponse(
        429,
        { error: "今天的对话次数已用完", code: "quota_exceeded", resetAt: Date.now() + 3600_000 },
        { "Retry-After": "3600" },
      ),
  ]);
  await assert.rejects(
    syncWorkspace(fetcher, {
      local: localData(),
      settingsWithoutSecrets: SETTINGS,
      workspace: EMPTY_WORKSPACE,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "quota_exceeded");
      assert.equal(error.message, "今天的对话次数已用完");
      assert.equal(error.retryAfter, 3600);
      return true;
    },
  );
});

test("云端与本地内容等价时不发 PUT，revision 不因登录或重渲染增长", async () => {
  const session = sessionFixture("s-same", 100);
  const note = noteFixture("n-same");
  const cloud: StudyBackup = {
    ...cloudBackup({ sessions: [session], notes: [note], reviews: [], diagnostics: [], activity: ["2026-10-24"] }),
    exportedAt: 1234,
  };
  const local = {
    sessions: [session],
    notes: [note],
    reviews: [],
    diagnostics: [],
    activity: ["2026-10-24"],
  };
  const merged = mergeLocalWithCloud(local, cloud.settingsWithoutSecrets, cloud);
  // mergeBackup 会把省略的可选 reviews 规范成空数组；语义仍是同一会话。
  assert.equal(merged.backup.sessions.length, 1);
  assert.equal(merged.backup.sessions[0].id, "s-same");
  assert.deepEqual(merged.backup.sessions[0].messages, session.messages);
  let called = false;
  const fetcher: Fetcher = () => {
    called = true;
    throw new Error("内容等价时不应发请求");
  };
  const result = await syncWorkspace(fetcher, {
    local,
    settingsWithoutSecrets: cloud.settingsWithoutSecrets,
    workspace: { revision: 9, data: cloud },
    now: () => 9_999,
  });
  assert.equal(called, false);
  assert.equal(result.workspace.revision, 9);
  assert.equal(result.refreshed, false);
  // 无变化同步必须回传云端原备份：exportedAt 不得重算成 now()。
  // App 用 JSON.stringify 比较 outcome.backup 与 workspace.data，
  // 一旦这里是新时间戳，稳定状态每 2.5 秒都会判定“云端有更新”并再次应用。
  assert.deepEqual(result.outcome.backup, cloud);
  assert.equal(result.outcome.backup.exportedAt, 1234);
  assert.equal(
    JSON.stringify(result.outcome.backup),
    JSON.stringify(result.workspace.data),
  );
  // 统计仍沿用合并结果（双方一致，因此没有新增条目）。
  assert.deepEqual(result.outcome.fromCloud, {
    sessions: 0,
    notes: 0,
    reviews: 0,
    diagnostics: 0,
  });
  assert.deepEqual(result.outcome.toCloud, { sessions: 0, notes: 0 });
});

test("同步稳定后重复调用：回传云端备份，不再写库也不会触发 App 重复应用", async () => {
  const cloud = cloudBackup({ exportedAt: 500 });
  let puts = 0;
  const fetcher: Fetcher = (_path, init) => {
    if (init?.method === "PUT") puts += 1;
    const body = JSON.parse(init?.body as string) as {
      revision: number;
      data: StudyBackup;
    };
    return Promise.resolve(
      jsonResponse(200, { revision: body.revision + 1, data: body.data }),
    );
  };
  const input = {
    local: localData(),
    settingsWithoutSecrets: SETTINGS,
    expectedUserId: "u-1",
  };

  // 第一次：云端缺本地数据，必须上传合并结果。
  const first = await syncWorkspace(fetcher, {
    ...input,
    workspace: { revision: 3, data: cloud },
    now: () => 4_321,
  });
  assert.equal(puts, 1);
  assert.equal(first.outcome.backup.exportedAt, 4_321);
  assert.ok(first.workspace.data);
  assert.deepEqual(first.workspace.data, first.outcome.backup);

  // 第二次（下一次 2.5s 轮询）：本地与云端已一致，不得再制造 revision。
  const second = await syncWorkspace(fetcher, {
    ...input,
    workspace: first.workspace,
    now: () => 9_999,
  });
  assert.equal(puts, 1, "稳定状态不得继续上传");
  assert.equal(second.refreshed, false);
  assert.equal(second.workspace.revision, first.workspace.revision);
  assert.equal(second.outcome.backup.exportedAt, 4_321);
  assert.deepEqual(second.outcome.backup, first.workspace.data);
  assert.equal(
    JSON.stringify(second.outcome.backup),
    JSON.stringify(second.workspace.data),
    "App 按 JSON 比对，两者相等才不会反复 applyCloudData",
  );
});

test("真实内容变化：仍上传并返回带新 exportedAt 的合并结果", async () => {
  const cloud = cloudBackup({ exportedAt: 500 });
  const { fetcher, calls } = scriptedFetcher([
    (init) => {
      const body = JSON.parse(init?.body as string) as {
        revision: number;
        data: StudyBackup;
      };
      return jsonResponse(200, { revision: body.revision + 1, data: body.data });
    },
  ]);
  const result = await syncWorkspace(fetcher, {
    local: localData(),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 2, data: cloud },
    now: () => 7_000,
  });

  assert.equal(calls.length, 1);
  const uploaded = JSON.parse(calls[0].init?.body as string) as {
    revision: number;
    data: StudyBackup;
  };
  assert.equal(uploaded.revision, 2);
  assert.equal(uploaded.data.exportedAt, 7_000);
  const sessionIds = uploaded.data.sessions.map((session) => session.id);
  assert.ok(sessionIds.includes("s-local") && sessionIds.includes("s-cloud"));
  const noteIds = uploaded.data.notes.map((note) => note.id);
  assert.ok(noteIds.includes("n-local") && noteIds.includes("n-cloud"));
  // 有真实变化时返回合并结果（不是云端原备份），App 需要据此应用云端条目。
  assert.deepEqual(result.outcome.backup, uploaded.data);
  assert.notEqual(JSON.stringify(result.outcome.backup), JSON.stringify(cloud));
  assert.equal(result.outcome.fromCloud.sessions, 1);
  assert.equal(result.outcome.fromCloud.notes, 1);
  assert.equal(result.outcome.toCloud.sessions, 1);
  assert.equal(result.outcome.toCloud.notes, 1);
  assert.equal(result.workspace.revision, 3);
  assert.equal(result.refreshed, false);
});

test("请求头：写请求带 X-Zhixu-Request 与 JSON 内容类型", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 2, data: null }),
  ]);
  await syncWorkspace(fetcher, {
    local: localData(),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 1, data: null },
  });
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("X-Zhixu-Request"), "1");
  assert.equal(headers.get("Content-Type"), "application/json");
});

/* ── 认证响应与深度校验 ──────────────────────────────────────── */

function authResultBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: {
      id: "u-1",
      email: "learner@example.com",
      name: "学习者",
      createdAt: 10,
    },
    revision: 3,
    data: null,
    ...overrides,
  };
}

test("注册：映射 AuthResult、一次性恢复码，并携带 Cookie 与 CSRF 头", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () =>
      jsonResponse(
        200,
        authResultBody({ recoveryCode: "ZX-1234-5678", revision: 0 }),
      ),
  ]);
  const result = await register(fetcher, {
    email: "learner@example.com",
    name: "学习者",
    password: "1234567890",
  });
  assert.equal(result.user.id, "u-1");
  assert.equal(result.user.name, "学习者");
  assert.equal(result.revision, 0);
  assert.equal(result.data, null);
  assert.equal(result.recoveryCode, "ZX-1234-5678");
  const init = calls[0].init;
  assert.equal(calls[0].path, "/api/auth/register");
  assert.equal(init?.method, "POST");
  assert.equal(init?.credentials, "same-origin");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("X-Zhixu-Request"), "1");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(init?.body as string), {
    email: "learner@example.com",
    name: "学习者",
    password: "1234567890",
  });
});

test("注册：响应缺少 user 时拒绝，不把坏数据当作登录态", async () => {
  const { fetcher } = scriptedFetcher([
    () => jsonResponse(200, { revision: 0, data: null }),
  ]);
  await assert.rejects(
    register(fetcher, {
      email: "learner@example.com",
      name: "学习者",
      password: "1234567890",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.code, "invalid_auth_response");
      return true;
    },
  );
});

test("登录：云端 data 必须通过 parseBackup 深度校验", async () => {
  const broken = {
    format: "zhixu-study-backup",
    version: 1,
    exportedAt: 1,
    sessions: [{ id: "broken" }],
    notes: [],
    reviews: [],
    diagnostics: [],
    settingsWithoutSecrets: SETTINGS,
    activity: [],
  };
  const { fetcher } = scriptedFetcher([
    () => jsonResponse(200, authResultBody({ data: broken })),
  ]);
  await assert.rejects(
    login(fetcher, { email: "learner@example.com", password: "1234567890" }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.code, "invalid_cloud_data");
      assert.match(error.message, /云端学习数据未通过校验/);
      return true;
    },
  );
});

test("GET workspace：拒绝夹带密钥的云端备份，且请求同源不带 CSRF 头", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () =>
      jsonResponse(200, {
        revision: 4,
        data: { ...cloudBackup(), injected: { apiKey: "sk-live" } },
      }),
  ]);
  await assert.rejects(
    getWorkspace(fetcher),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.code, "invalid_cloud_data");
      return true;
    },
  );
  assert.equal(calls[0].path, "/api/workspace");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0].init?.headers).get("X-Zhixu-Request"), null);
});

test("me：接受平铺 AuthUser 并补全空昵称；坏数据拒绝", async () => {
  const flat = scriptedFetcher([
    () =>
      jsonResponse(200, {
        id: "u-1",
        email: "learner@example.com",
        name: "",
        createdAt: 5,
      }),
  ]);
  const user = await me(flat.fetcher);
  assert.equal(user.id, "u-1");
  assert.equal(user.name, "learner");

  const wrapped = scriptedFetcher([
    () =>
      jsonResponse(200, {
        user: {
          id: "u-2",
          email: "second@example.com",
          name: "二号",
          createdAt: 6,
        },
      }),
  ]);
  assert.equal((await me(wrapped.fetcher)).id, "u-2");

  const broken = scriptedFetcher([() => jsonResponse(200, { id: "u-3" })]);
  await assert.rejects(me(broken.fetcher), (error: unknown) => {
    assert.ok(error instanceof CloudSyncError);
    assert.equal(error.code, "invalid_auth_response");
    return true;
  });
});

test("logout：204 空响应不算解析失败，且写请求带 CSRF 头", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () => new Response(null, { status: 204 }),
  ]);
  await logout(fetcher);
  assert.equal(calls[0].path, "/api/auth/logout");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("X-Zhixu-Request"), "1");
});

test("失败路径：网络错误映射为 status 0，非 JSON 500 使用中文兜底", async () => {
  const offline = scriptedFetcher([
    () => {
      throw new Error("offline");
    },
  ]);
  await assert.rejects(getWorkspace(offline.fetcher), (error: unknown) => {
    assert.ok(error instanceof CloudSyncError);
    assert.equal(error.status, 0);
    assert.match(error.message, /网络连接失败/);
    return true;
  });

  const serverError = scriptedFetcher([
    () => new Response("upstream unavailable", { status: 500 }),
  ]);
  await assert.rejects(getWorkspace(serverError.fetcher), (error: unknown) => {
    assert.ok(error instanceof CloudSyncError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "云端学习数据读取失败，请稍后重试。");
    return true;
  });
});

/* ── 空云端与上传内容 ────────────────────────────────────────── */

test("空云端：revision 从 0 起上传本地全部数据，且不含任何密钥", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 1, data: null }),
  ]);
  const result = await syncWorkspace(fetcher, {
    local: localData(),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 0, data: null },
  });
  const uploaded = JSON.parse(calls[0].init?.body as string) as {
    revision: number;
    data: StudyBackup;
  };
  assert.equal(uploaded.revision, 0);
  assert.deepEqual(parseBackup(JSON.stringify(uploaded.data)), uploaded.data);
  assert.deepEqual(
    uploaded.data.sessions.map((session) => session.id),
    ["s-local"],
  );
  assert.ok(uploaded.data.notes.some((note) => note.id === "n-local"));
  assert.equal("apiKey" in uploaded.data, false);
  assert.equal(result.workspace.revision, 1);
  assert.equal(result.refreshed, false);
});

test("云端已有数据：上传前合并双方，revision 使用已知值", async () => {
  const cloud = cloudBackup();
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 4, data: cloud }),
  ]);
  const result = await syncWorkspace(fetcher, {
    local: localData(),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 3, data: cloud },
  });
  const uploaded = JSON.parse(calls[0].init?.body as string) as {
    revision: number;
    data: StudyBackup;
  };
  assert.equal(uploaded.revision, 3);
  const ids = uploaded.data.sessions.map((session) => session.id);
  assert.ok(ids.includes("s-local") && ids.includes("s-cloud"));
  assert.equal(result.outcome.fromCloud.sessions, 1);
  assert.equal(result.outcome.toCloud.sessions, 1);
});

test("无密钥：即使调用方误传 apiKey 也不会进入备份", () => {
  const outcome = mergeLocalWithCloud(
    localData(),
    {
      ...SETTINGS,
      apiKey: "sk-should-not-leak",
    } as unknown as StudyBackup["settingsWithoutSecrets"],
    null,
  );
  assert.equal(JSON.stringify(outcome.backup).includes("sk-should-not-leak"), false);
  assert.equal("apiKey" in outcome.backup, false);
});

test("云端初始工作区格式错误：本地校验失败即停止，不发任何请求", async () => {
  const { fetcher, calls } = scriptedFetcher([]);
  await assert.rejects(
    syncWorkspace(fetcher, {
      local: localData(),
      settingsWithoutSecrets: SETTINGS,
      workspace: {
        revision: 2,
        data: { format: "zhixu-study-backup", version: 1 } as unknown as StudyBackup,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.code, "invalid_cloud_data");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("409 后重取失败：401 原样抛出，不做第二次写入", async () => {
  const { fetcher, calls } = scriptedFetcher([
    () =>
      jsonResponse(409, {
        error: "数据已被其他设备更新",
        code: "revision_conflict",
        revision: 9,
      }),
    () => jsonResponse(401, { error: "登录已过期" }),
  ]);
  await assert.rejects(
    syncWorkspace(fetcher, {
      local: localData(),
      settingsWithoutSecrets: SETTINGS,
      workspace: { revision: 1, data: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudSyncError);
      assert.equal(error.status, 401);
      assert.equal(error.message, "登录已过期");
      return true;
    },
  );
  assert.deepEqual(
    calls.map((call) => call.init?.method ?? "GET"),
    ["PUT", "GET"],
  );
});

/* ── 跨设备同 ID 版本与删除墓碑 ───────────────────────────────── */

test("跨设备同 ID 笔记：A 更新后 B 的旧副本不会覆盖，反向时较新云端覆盖 B", () => {
  const newer = {
    ...noteFixture("n1", ""),
    content: "A 设备更新后的内容",
    updatedAt: 200,
  };
  const older = {
    ...noteFixture("n1", ""),
    content: "B 设备旧副本",
    updatedAt: 100,
  };

  const aKeepsNewest = mergeLocalWithCloud(
    localData({ notes: [newer] }),
    SETTINGS,
    cloudBackup({ notes: [older] }),
  );
  assert.equal(
    aKeepsNewest.backup.notes.find((note) => note.id === "n1")?.content,
    "A 设备更新后的内容",
  );

  const bReceivesNewest = mergeLocalWithCloud(
    localData({ notes: [older] }),
    SETTINGS,
    cloudBackup({ notes: [newer] }),
  );
  assert.equal(
    bReceivesNewest.backup.notes.find((note) => note.id === "n1")?.content,
    "A 设备更新后的内容",
    "B 的旧副本应被云端较新内容覆盖，随后上传给其他设备",
  );

  // 旧快照没有 updatedAt：不能覆盖任意一端的当前笔记。
  const legacyCloud = { ...noteFixture("n1", ""), content: "无版本的旧云端" };
  const legacyProtected = mergeLocalWithCloud(
    localData({ notes: [{ ...noteFixture("n1", ""), content: "本地当前" }] }),
    SETTINGS,
    cloudBackup({ notes: [legacyCloud] }),
  );
  assert.equal(
    legacyProtected.backup.notes.find((note) => note.id === "n1")?.content,
    "本地当前",
  );
});

test("syncWorkspace：本地较新笔记覆盖云端旧副本并上传版本时间", async () => {
  const cloud = cloudBackup({
    notes: [{ ...noteFixture("n1", ""), content: "云端旧副本", updatedAt: 100 }],
  });
  const localNewer = {
    ...noteFixture("n1", ""),
    content: "本地新内容",
    updatedAt: 300,
  };
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 5, data: cloud }),
  ]);
  await syncWorkspace(fetcher, {
    local: localData({ notes: [localNewer] }),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 4, data: cloud },
  });
  const uploaded = JSON.parse(calls[0].init?.body as string) as {
    revision: number;
    data: StudyBackup;
  };
  assert.equal(uploaded.revision, 4);
  const uploadedNote = uploaded.data.notes.find((note) => note.id === "n1");
  assert.equal(uploadedNote?.content, "本地新内容");
  assert.equal(uploadedNote?.updatedAt, 300);
  assert.deepEqual(parseBackup(JSON.stringify(uploaded.data)), uploaded.data);
});

test("跨设备复习与诊断：旧副本不能覆盖较新的评分/评价", () => {
  const localReview = {
    ...reviewFixture("r1", "s-local"),
    attempts: 3,
    dueAt: 900,
    lastOutcome: "known" as const,
  };
  const cloudReview = {
    ...reviewFixture("r1", "s-cloud"),
    attempts: 1,
    dueAt: 200,
    lastOutcome: "again" as const,
  };
  const localDiagnostic = {
    ...diagnosticFixture("d1"),
    evaluatedAt: 800,
    evidenceSummary: ["本地新评价"],
  };
  const cloudDiagnostic = {
    ...diagnosticFixture("d1"),
    evaluatedAt: 300,
    evidenceSummary: ["云端旧评价"],
  };

  const localWins = mergeLocalWithCloud(
    localData({
      sessions: [withDiagnostic(sessionFixture("s-local", 100), localDiagnostic)],
      reviews: [localReview],
      diagnostics: [localDiagnostic],
    }),
    SETTINGS,
    cloudBackup({
      sessions: [withDiagnostic(sessionFixture("s-cloud", 200), cloudDiagnostic)],
      reviews: [cloudReview],
      diagnostics: [cloudDiagnostic],
    }),
  );
  assert.equal(localWins.backup.reviews[0].attempts, 3);
  assert.deepEqual(localWins.backup.diagnostics[0].evidenceSummary, ["本地新评价"]);

  const cloudWins = mergeLocalWithCloud(
    localData({
      sessions: [withDiagnostic(sessionFixture("s-local", 100), cloudDiagnostic)],
      reviews: [cloudReview],
      diagnostics: [cloudDiagnostic],
    }),
    SETTINGS,
    cloudBackup({
      sessions: [withDiagnostic(sessionFixture("s-cloud", 200), localDiagnostic)],
      reviews: [localReview],
      diagnostics: [localDiagnostic],
    }),
  );
  assert.equal(cloudWins.backup.reviews[0].attempts, 3);
  assert.deepEqual(cloudWins.backup.diagnostics[0].evidenceSummary, ["本地新评价"]);
});

test("墓碑：旧快照首次上传被 409 拒绝，重取云端后不会回写已删笔记", async () => {
  const deletedId = "n-deleted";
  const oldCloud = cloudBackup({ notes: [noteFixture(deletedId, "s-cloud")] });
  const tombstonedCloud = cloudBackup({
    notes: [],
    deletedNoteIds: [deletedId],
  });
  const { fetcher, calls } = scriptedFetcher([
    () =>
      jsonResponse(409, {
        error: "云端已删除的笔记不能由旧快照重新写入，请刷新后重试。",
        code: "note_tombstoned",
        revision: 2,
      }),
    () => jsonResponse(200, { revision: 2, data: tombstonedCloud }),
    () => jsonResponse(200, { revision: 3, data: tombstonedCloud }),
  ]);

  const result = await syncWorkspace(fetcher, {
    local: localData({ notes: [noteFixture(deletedId, "s-local")] }),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 1, data: oldCloud },
  });

  const firstUpload = JSON.parse(calls[0].init?.body as string) as {
    data: StudyBackup;
  };
  assert.ok(
    firstUpload.data.notes.some((note) => note.id === deletedId),
    "首次上传仍带着旧快照中的已删笔记（服务端应拒绝）",
  );

  const retryUpload = JSON.parse(calls[2].init?.body as string) as {
    revision: number;
    data: StudyBackup;
  };
  assert.equal(retryUpload.revision, 2);
  assert.equal(
    retryUpload.data.notes.some((note) => note.id === deletedId),
    false,
    "重取云端墓碑后不得再上传已删笔记",
  );
  assert.deepEqual(retryUpload.data.deletedNoteIds, [deletedId]);
  assert.deepEqual(parseBackup(JSON.stringify(retryUpload.data)), retryUpload.data);
  assert.equal(result.workspace.revision, 3);
  assert.equal(result.refreshed, true);
});

test("墓碑：云端为空时迁移备份也不会包含已删笔记", () => {
  const deletedId = "n-deleted";
  const outcome = mergeLocalWithCloud(
    localData({
      notes: [noteFixture(deletedId, "")],
      deletedNoteIds: [deletedId],
    }),
    SETTINGS,
    null,
  );
  assert.deepEqual(outcome.backup.notes, []);
  assert.deepEqual(outcome.backup.deletedNoteIds, [deletedId]);
  assert.equal(outcome.toCloud.notes, 0);
  assert.deepEqual(parseBackup(JSON.stringify(outcome.backup)), outcome.backup);
});

test("deleteCloudNote：POST note-delete 并接受服务端返回的墓碑工作区", async () => {
  const tombstoned = cloudBackup({ notes: [], deletedNoteIds: ["n1"] });
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 3, data: tombstoned }),
  ]);
  const workspace = await deleteCloudNote(fetcher, "n1", "u-1");
  assert.equal(workspace.revision, 3);
  assert.deepEqual(workspace.data?.deletedNoteIds, ["n1"]);
  assert.equal(calls[0].path, "/api/workspace/note-delete");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { noteId: "n1" });
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("X-Zhixu-User"), "u-1");
  assert.equal(headers.get("X-Zhixu-Request"), "1");
});

/* ── 服务端时钟校准 ──────────────────────────────────────────── */

test("GET workspace：serverTime 校准本机时钟，偏移按来源保存并可更新", async () => {
  const originalNow = Date.now;
  const localNow = 1_800_000_000_000;
  Date.now = () => localNow;
  try {
    const serverTime = localNow + 3_600_000;
    const { fetcher } = scriptedFetcher([
      () => jsonResponse(200, { revision: 2, data: null, serverTime }),
    ]);
    const workspace = await getWorkspace(fetcher);
    assert.equal(workspace.serverTime, serverTime);
    assert.equal(getClockOffset(), 3_600_000);
    assert.equal(calibratedNow(), serverTime);

    // 每次响应都可以刷新偏移。
    calibrateClock(serverTime + 5_000);
    assert.equal(getClockOffset(), 3_605_000);

    // 偏移按来源隔离：同源更新不会影响其他来源。
    calibrateClock(serverTime - 2_000, "https://other.example");
    assert.equal(getClockOffset("https://other.example"), 3_598_000);
    assert.equal(getClockOffset(), 3_605_000);
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("时钟校准：本地快 1 小时时，旧会话不能用未来 updatedAt 压过云端真实更新", async () => {
  const originalNow = Date.now;
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  // 模拟设备时钟快 1 小时：Date.now() 返回真实时间 + 1h。
  Date.now = () => trueNow + hour;
  try {
    // 本地两小时前编辑：设备快 1 小时，所以记录的 updatedAt 是 trueNow - 1h。
    const localSession: StudySession = {
      ...sessionFixture("s-clock", trueNow - hour),
      title: "本地旧内容",
    };
    const cloudSession: StudySession = {
      ...sessionFixture("s-clock", trueNow - 60_000, "云端真实新消息"),
      title: "云端新内容",
    };
    const cloud = cloudBackup({ sessions: [cloudSession] });
    const { fetcher, calls } = scriptedFetcher([
      // getWorkspace 收到服务端真实时间，客户端据此得到 offset = -1h。
      () => jsonResponse(200, { revision: 4, data: cloud, serverTime: trueNow }),
      // PUT 成功响应。
      () => jsonResponse(200, { revision: 5, data: cloud, serverTime: trueNow }),
    ]);
    const workspace = await getWorkspace(fetcher);
    const result = await syncWorkspace(fetcher, {
      local: localData({ sessions: [localSession] }),
      settingsWithoutSecrets: SETTINGS,
      workspace,
      now: () => trueNow + hour,
    });

    const merged = result.outcome.backup.sessions.find((session) => session.id === "s-clock");
    assert.equal(merged?.title, "云端新内容");
    assert.equal(merged?.messages.length, 3, "双方消息增量都应保留");
    assert.equal(merged?.updatedAt, trueNow - 60_000);

    const uploaded = JSON.parse(calls[1].init?.body as string) as {
      data: StudyBackup;
    };
    const uploadedSession = uploaded.data.sessions.find((session) => session.id === "s-clock");
    assert.equal(uploadedSession?.title, "云端新内容", "上传也不能把本地未来时间戳当真");
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("mergeLocalWithCloud：显式 clockOffset 会把本地时间换算到服务端基准", () => {
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  const localSession: StudySession = {
    ...sessionFixture("s-clock", trueNow - hour),
    title: "本地旧内容",
  };
  const cloudSession: StudySession = {
    ...sessionFixture("s-clock", trueNow - 60_000, "云端新消息"),
    title: "云端新内容",
  };
  const outcome = mergeLocalWithCloud(
    localData({ sessions: [localSession] }),
    SETTINGS,
    cloudBackup({ sessions: [cloudSession] }),
    { clockOffset: -hour },
  );
  const merged = outcome.backup.sessions.find((session) => session.id === "s-clock");
  assert.equal(merged?.title, "云端新内容");
  assert.equal(merged?.updatedAt, trueNow - 60_000);
});

test("登录响应 serverTime：首次同步前完成校准，本地旧快照不压过云端真实更新", async () => {
  const originalNow = Date.now;
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  // 设备时钟快 1 小时：Date.now() 比服务端真实时间快 1h。
  Date.now = () => trueNow + hour;
  try {
    resetClockCalibration();
    const cloudSession: StudySession = {
      ...sessionFixture("s-first", trueNow - 60_000, "云端真实新消息"),
      title: "云端真实新内容",
    };
    const cloud = cloudBackup({ sessions: [cloudSession] });
    const { fetcher, calls } = scriptedFetcher([
      // 登录响应本身带回 serverTime，客户端应在首次同步前完成校准。
      () =>
        jsonResponse(
          200,
          authResultBody({ revision: 2, data: cloud, serverTime: trueNow }),
        ),
      // 合并结果包含本地独有消息，因此首次同步会 PUT。
      () => jsonResponse(200, { revision: 3, data: cloud, serverTime: trueNow }),
    ]);
    const authed = await login(fetcher, {
      email: "learner@example.com",
      password: "1234567890",
    });
    assert.equal(authed.serverTime, trueNow);
    assert.equal(getClockOffset(), -hour, "登录响应必须完成时钟校准");
    assert.equal(calibratedNow(), trueNow);

    const fastClockSession = sessionFixture("s-first", trueNow + 30 * 60_000);
    const localSession: StudySession = {
      ...fastClockSession,
      title: "本地半小时前的旧内容",
      messages: [
        ...fastClockSession.messages,
        {
          id: "s-first-local-extra",
          role: "user",
          content: "本地旧追问",
          timestamp: 1,
        },
      ],
    };
    const result = await syncWorkspace(fetcher, {
      local: localData({ sessions: [localSession], notes: [] }),
      settingsWithoutSecrets: SETTINGS,
      workspace: { revision: authed.revision, data: authed.data },
    });

    const merged = result.outcome.backup.sessions.find(
      (session) => session.id === "s-first",
    );
    assert.equal(merged?.title, "云端真实新内容");
    assert.equal(merged?.updatedAt, trueNow - 60_000);
    assert.ok(
      merged?.messages.some((message) => message.content === "云端真实新消息"),
      "云端真实更新必须保留",
    );
    assert.equal(calls[1]?.path, "/api/workspace", "首次同步应完成一次上传");
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("syncWorkspace：localClockCalibrated 不会对已校准的本地时间重复换算", async () => {
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  const localSession: StudySession = {
    ...sessionFixture("s-calibrated", trueNow, "本机刚写的新消息"),
    title: "本机刚写的新内容",
  };
  const cloudSession: StudySession = {
    ...sessionFixture("s-calibrated", trueNow - 60_000, "云端一分钟前的旧消息"),
    title: "云端一分钟前的旧内容",
  };
  const cloud = cloudBackup({ sessions: [cloudSession] });
  const { fetcher, calls } = scriptedFetcher([
    () => jsonResponse(200, { revision: 8, data: cloud, serverTime: trueNow }),
  ]);

  const result = await syncWorkspace(fetcher, {
    local: localData({ sessions: [localSession], notes: [] }),
    settingsWithoutSecrets: SETTINGS,
    workspace: { revision: 7, data: cloud },
    clockOffset: -hour,
    localClockCalibrated: true,
  });

  const merged = result.outcome.backup.sessions.find(
    (session) => session.id === "s-calibrated",
  );
  assert.equal(merged?.title, "本机刚写的新内容");
  assert.equal(merged?.updatedAt, trueNow);
  assert.equal(calls[0]?.path, "/api/workspace");
});

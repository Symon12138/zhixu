import assert from "node:assert/strict";
import test from "node:test";
import type {
  CloudWorkspace,
  Note,
  ReviewItem,
  StudyBackup,
  StudySession,
} from "../src/types";
import {
  CLOCK_OFFSET_STORAGE_PREFIX,
  calibrateClock,
  calibratedNow,
  getClockOffset,
  mergeLocalWithCloud,
  resetClockCalibration,
  syncWorkspace,
  type Fetcher,
  type LocalWorkspaceData,
} from "../src/lib/cloudSync";
import { parseBackup } from "../src/lib/backup";

/* ── 夹具 ────────────────────────────────────────────────────────────── */

const SETTINGS: StudyBackup["settingsWithoutSecrets"] = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
};

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

function noteFixture(id: string): Note {
  return {
    id,
    sessionId: "s-local",
    title: "净值笔记",
    content: `${id} 的内容：单位净值每份当前价值。`,
    createdAt: 50,
  };
}

function reviewFixture(
  id: string,
  attempts: number,
  sessionId = "s-local",
): ReviewItem {
  return {
    id,
    sessionId,
    topic: "银行理财",
    questionId: "s-local-q1",
    prompt: "分红从哪里支付？",
    kind: "quiz",
    reason: "测验答错",
    hint: "想清楚钱的来源。",
    correctExplanation: "分红从产品资产中转出。",
    createdAt: 100,
    dueAt: 200,
    intervalDays: 1,
    streak: 0,
    attempts,
    lastOutcome: "again",
    source: "quiz",
  };
}

function localData(overrides: Partial<LocalWorkspaceData> = {}): LocalWorkspaceData {
  return {
    sessions: [sessionFixture("s-local", 100)],
    notes: [noteFixture("n-local")],
    reviews: [reviewFixture("r-local", 1)],
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
    notes: [noteFixture("n-cloud")],
    reviews: [reviewFixture("r-cloud", 1, "s-cloud")],
    diagnostics: [],
    settingsWithoutSecrets: SETTINGS,
    activity: ["2026-10-25"],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface RecordedCall {
  path: string;
  init?: RequestInit;
}

function scriptedFetcher(responses: Array<() => Response>): {
  fetcher: Fetcher;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetcher: Fetcher = async (input, init) => {
    calls.push({ path: input, ...(init === undefined ? {} : { init }) });
    const make = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return make();
  };
  return { fetcher, calls };
}

/* ── localStorage 替身：验证持久化校准值被篡改时的行为 ───────────────── */

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

async function withMemoryStorage(
  run: (storage: MemoryStorage) => void | Promise<void>,
): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    await run(storage);
  } finally {
    resetClockCalibration();
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

/* ── 校准失败：回退本地时钟，不阻断同步 ──────────────────────────────── */

test("serverTime 缺失/字符串/NaN/非数字一律不校准，calibratedNow 回退本地时钟", () => {
  const origin = "https://clock.example";
  const originalNow = Date.now;
  const trueNow = 1_800_000_000_000;
  Date.now = () => trueNow;
  try {
    const invalid: unknown[] = [
      undefined,
      null,
      "1800000000000",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      {},
      [],
      true,
    ];
    for (const value of invalid) {
      resetClockCalibration(origin);
      assert.equal(calibrateClock(value, origin), null);
      assert.equal(getClockOffset(origin), 0);
      assert.equal(calibratedNow(origin), trueNow);
    }

    assert.equal(calibrateClock(trueNow - 60_000, origin), -60_000);
    assert.equal(getClockOffset(origin), -60_000);
    assert.equal(calibratedNow(origin), trueNow - 60_000);
  } finally {
    Date.now = originalNow;
    resetClockCalibration(origin);
  }
});

test("持久化 offset 为坏 JSON/非数字/越界类型时回退 0，不抛错", async () => {
  await withMemoryStorage((storage) => {
    const origin = "https://corrupt.example";
    const key = `${CLOCK_OFFSET_STORAGE_PREFIX}${origin}`;
    const corrupted = [
      "{not-json",
      "null",
      JSON.stringify([1, 2]),
      JSON.stringify({ serverTime: 1 }),
      JSON.stringify({ offset: "3600000" }),
      JSON.stringify({ offset: null }),
      JSON.stringify({ offset: true }),
      JSON.stringify({ offset: { value: 1 } }),
    ];
    for (const raw of corrupted) {
      resetClockCalibration(origin);
      storage.setItem(key, raw);
      assert.equal(getClockOffset(origin), 0, `损坏值必须回退 0：${raw}`);
    }
  });
});

test("localStorage 写入抛错时仍保留内存校准，不阻断校准", () => {
  const originalNow = Date.now;
  const trueNow = 1_800_000_000_000;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
  Date.now = () => trueNow;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: throwing,
  });
  try {
    resetClockCalibration();
    assert.equal(calibrateClock(trueNow + 5_000), 5_000);
    assert.equal(getClockOffset(), 5_000);
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

/* ── 时钟偏移对合并胜负的影响 ────────────────────────────────────────── */

test("设备时钟快 1 年：校准后旧快照不能压过云端真实更新", () => {
  const trueNow = 1_800_000_000_000;
  const year = 365 * 24 * 3_600_000;
  const originalNow = Date.now;
  Date.now = () => trueNow + year;
  try {
    resetClockCalibration();
    assert.equal(calibrateClock(trueNow), -year);

    const localSession = {
      ...sessionFixture("s-shared", trueNow + year - 120_000),
      title: "本机两分钟前的旧内容",
    };
    const cloudSession = {
      ...sessionFixture("s-shared", trueNow - 30_000, "云端新消息"),
      title: "云端三十秒前的新内容",
    };
    const outcome = mergeLocalWithCloud(
      localData({ sessions: [localSession], notes: [], reviews: [] }),
      SETTINGS,
      cloudBackup({ sessions: [cloudSession], notes: [], reviews: [] }),
    );
    const merged = outcome.backup.sessions[0];
    assert.equal(merged.title, "云端三十秒前的新内容");
    assert.equal(merged.messages.length, 3, "双方消息增量都必须保留");
    assert.equal(merged.updatedAt, trueNow - 30_000);
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("设备时钟慢 1 年：校准后真正更新的本机内容仍能取胜", () => {
  const trueNow = 1_800_000_000_000;
  const year = 365 * 24 * 3_600_000;
  const originalNow = Date.now;
  Date.now = () => trueNow - year;
  try {
    resetClockCalibration();
    assert.equal(calibrateClock(trueNow), year);

    const localSession = {
      ...sessionFixture("s-shared", trueNow - year - 60_000),
      title: "本机一分钟前的真实新内容",
    };
    const cloudSession = {
      ...sessionFixture("s-shared", trueNow - 120_000, "云端旧消息"),
      title: "云端两分钟前的旧内容",
    };
    const outcome = mergeLocalWithCloud(
      localData({ sessions: [localSession], notes: [], reviews: [] }),
      SETTINGS,
      cloudBackup({ sessions: [cloudSession], notes: [], reviews: [] }),
    );
    const merged = outcome.backup.sessions[0];
    assert.equal(merged.title, "本机一分钟前的真实新内容");
    assert.equal(merged.updatedAt, trueNow - 60_000);
    assert.equal(merged.messages.length, 3);
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("负 offset 与相等时间戳：按服务端基准决定胜负，双方消息不丢", () => {
  const trueNow = 1_800_000_000_000;
  const originalNow = Date.now;
  Date.now = () => trueNow;
  try {
    resetClockCalibration();
    assert.equal(calibrateClock(trueNow - 3_600_000), -3_600_000);
    const negativeOffset = mergeLocalWithCloud(
      localData({
        sessions: [
          {
            ...sessionFixture("s-shared", trueNow - 900_000),
            title: "换算后 75 分钟前的本机内容",
          },
        ],
        notes: [],
        reviews: [],
      }),
      SETTINGS,
      cloudBackup({
        sessions: [
          {
            ...sessionFixture("s-shared", trueNow - 1_800_000, "云端新消息"),
            title: "云端 30 分钟前的内容",
          },
        ],
        notes: [],
        reviews: [],
      }),
    );
    const afterShift = negativeOffset.backup.sessions[0];
    assert.equal(afterShift.title, "云端 30 分钟前的内容");
    assert.equal(afterShift.messages.length, 3);

    resetClockCalibration();
    assert.equal(calibrateClock(trueNow), 0);
    const equal = mergeLocalWithCloud(
      localData({
        sessions: [{ ...sessionFixture("s-equal", trueNow), title: "本机同刻内容" }],
        notes: [],
        reviews: [],
      }),
      SETTINGS,
      cloudBackup({
        sessions: [
          {
            ...sessionFixture("s-equal", trueNow, "云端同刻消息"),
            title: "云端同刻内容",
          },
        ],
        notes: [],
        reviews: [],
      }),
    );
    const equalSession = equal.backup.sessions[0];
    assert.equal(equalSession.title, "云端同刻内容", "时间戳相等时 incoming 获胜");
    assert.equal(equalSession.updatedAt, trueNow);
    assert.equal(equalSession.messages.length, 3);
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("对抗：被篡改为极大值的持久化 offset 不得让陈旧本机快照压过云端真实更新", async () => {
  await withMemoryStorage((storage) => {
    const origin = "default";
    const key = `${CLOCK_OFFSET_STORAGE_PREFIX}${origin}`;
    resetClockCalibration(origin);
    storage.setItem(
      key,
      JSON.stringify({ offset: 1e300, serverTime: 0, at: 0 }),
    );
    const offset = getClockOffset();
    const trueNow = 1_800_000_000_000;
    const outcome = mergeLocalWithCloud(
      localData({
        sessions: [
          { ...sessionFixture("s-shared", trueNow - 3_600_000), title: "本机一小时前的旧内容" },
        ],
        notes: [],
        reviews: [],
      }),
      SETTINGS,
      cloudBackup({
        sessions: [
          {
            ...sessionFixture("s-shared", trueNow, "云端最新消息"),
            title: "云端最新内容",
          },
        ],
        notes: [],
        reviews: [],
      }),
    );
    const merged = outcome.backup.sessions[0];

    const problems: string[] = [];
    if (!Number.isSafeInteger(offset)) {
      problems.push(`持久化 offset=${offset} 不是安全整数，仍被用于换算本地时间`);
    }
    if (merged.title !== "云端最新内容") {
      problems.push(`陈旧本机标题覆盖了云端最新标题：实际为「${merged.title}」`);
    }
    if (!Number.isSafeInteger(merged.updatedAt)) {
      problems.push(`合并后的 updatedAt=${merged.updatedAt} 不是安全整数，会污染云端时间戳`);
    }
    assert.deepEqual(problems, []);
  });
});

/* ── 恶意/异常 serverTime 不阻断同步 ─────────────────────────────────── */

test("恶意/异常 serverTime 不阻断同步、不丢双方记录、上传仍是合法备份", async () => {
  const trueNow = 1_800_000_000_000;
  const originalNow = Date.now;
  Date.now = () => trueNow;
  try {
    const cases: Array<[string, unknown]> = [
      ["缺失", undefined],
      ["字符串", "1800000000000"],
      ["负数", -1],
      ["0", 0],
      ["未来一年", trueNow + 365 * 24 * 3_600_000],
      ["极大未来", trueNow + 1e15],
    ];

    for (const [label, serverTime] of cases) {
      resetClockCalibration();
      const local = localData({
        sessions: [sessionFixture("s-local", trueNow - 60_000)],
        notes: [],
      });
      const cloud = cloudBackup({
        sessions: [sessionFixture("s-cloud", trueNow - 30_000, "云端独有消息")],
        notes: [],
      });
      const workspace: CloudWorkspace = { revision: 3, data: cloud };
      if (serverTime !== undefined) Object.assign(workspace, { serverTime });

      const { fetcher, calls } = scriptedFetcher([
        () =>
          jsonResponse(
            200,
            {
              revision: 4,
              data: cloud,
              ...(serverTime === undefined ? {} : { serverTime }),
            },
          ),
      ]);
      const result = await syncWorkspace(fetcher, {
        local,
        settingsWithoutSecrets: SETTINGS,
        workspace,
      });

      const ids = result.outcome.backup.sessions.map((session) => session.id).sort();
      assert.deepEqual(ids, ["s-cloud", "s-local"], `${label}：双方会话都不能丢`);
      const cloudSession = result.outcome.backup.sessions.find(
        (session) => session.id === "s-cloud",
      );
      assert.equal(cloudSession?.messages.length, 3, `${label}：云端消息增量不能丢`);
      for (const session of result.outcome.backup.sessions) {
        assert.ok(
          Number.isFinite(session.updatedAt),
          `${label}：合并结果不能出现非有限 updatedAt`,
        );
      }

      const put = calls.find(
        (call) => call.path === "/api/workspace" && call.init?.method === "PUT",
      );
      if (!put) assert.fail(`${label}：异常 serverTime 不能阻断上传`);
      const rawBody = put.init?.body;
      if (typeof rawBody !== "string") {
        assert.fail(`${label}：上传体必须是 JSON 字符串`);
      }
      const uploaded = JSON.parse(rawBody) as {
        revision: number;
        data: StudyBackup;
      };
      assert.equal(uploaded.revision, 3);
      // 服务端会用同一套 parseBackup 校验：非有限/越界时间戳会让整次上传失败。
      const parsed = parseBackup(JSON.stringify(uploaded.data));
      assert.deepEqual(
        parsed.sessions.map((session) => session.id).sort(),
        ["s-cloud", "s-local"],
      );
    }
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

test("校准失败（字符串/缺失）时回退本地时钟，本地首次上传仍然成功", async () => {
  const trueNow = 1_800_000_000_000;
  const originalNow = Date.now;
  Date.now = () => trueNow;
  try {
    resetClockCalibration();
    const workspace: CloudWorkspace = { revision: 0, data: null };
    Object.assign(workspace, { serverTime: "not-a-number" });
    const { fetcher, calls } = scriptedFetcher([
      () =>
        jsonResponse(200, {
          revision: 1,
          data: null,
          serverTime: "still-not-a-number",
        }),
    ]);
    const local = localData({
      sessions: [sessionFixture("s-offline", trueNow)],
      notes: [],
      reviews: [],
    });
    const result = await syncWorkspace(fetcher, {
      local,
      settingsWithoutSecrets: SETTINGS,
      workspace,
    });
    assert.equal(getClockOffset(), 0, "非法 serverTime 不得改变校准状态");
    assert.equal(result.workspace.revision, 1);
    assert.equal(result.outcome.backup.sessions[0].id, "s-offline");
    assert.equal(calls[0].path, "/api/workspace");
    assert.equal(calls[0].init?.method, "PUT");
  } finally {
    Date.now = originalNow;
    resetClockCalibration();
  }
});

/* ── 数据完整性与密钥不泄露 ──────────────────────────────────────────── */

test("云端墓碑优先：旧本地快照不能复活已删除笔记，上传体仍带墓碑", () => {
  const outcome = mergeLocalWithCloud(
    localData({ notes: [noteFixture("n-deleted")], deletedNoteIds: [] }),
    SETTINGS,
    cloudBackup({ notes: [], deletedNoteIds: ["n-deleted"] }),
  );
  assert.equal(outcome.backup.notes.length, 0, "已删除笔记不能从本机旧快照复活");
  assert.deepEqual(outcome.backup.deletedNoteIds, ["n-deleted"]);
  const uploaded = parseBackup(JSON.stringify(outcome.backup));
  assert.equal(uploaded.notes.length, 0);
  assert.deepEqual(uploaded.deletedNoteIds, ["n-deleted"]);
});

test("合并结果与上传体绝不携带内存中的 apiKey/searchApiKey", () => {
  const taintedSettings = {
    ...SETTINGS,
    apiKey: "sk-should-never-leak",
    searchApiKey: "search-should-never-leak",
  } as unknown as StudyBackup["settingsWithoutSecrets"];
  const outcome = mergeLocalWithCloud(localData(), taintedSettings, cloudBackup());
  const serialized = JSON.stringify(outcome.backup);
  assert.equal(serialized.includes("sk-should-never-leak"), false);
  assert.equal(serialized.includes("search-should-never-leak"), false);
  assert.equal("apiKey" in outcome.backup.settingsWithoutSecrets, false);
  assert.equal("searchApiKey" in outcome.backup.settingsWithoutSecrets, false);
});

test("合并与上传不改变会话 ID、消息 ID 和复习项 ID 的唯一性", () => {
  const localShared = sessionFixture("s-shared", 100);
  localShared.messages.push({
    id: "local-extra",
    role: "user",
    content: "本地增量",
    timestamp: 3,
  });
  const cloudShared = sessionFixture("s-shared", 200);
  cloudShared.messages.push({
    id: "cloud-extra",
    role: "assistant",
    content: "云端增量",
    timestamp: 4,
  });

  const outcome = mergeLocalWithCloud(
    localData({
      sessions: [localShared, sessionFixture("s-local-only", 90)],
      notes: [],
      reviews: [reviewFixture("r-shared", 1, "s-shared")],
    }),
    SETTINGS,
    cloudBackup({
      sessions: [cloudShared, sessionFixture("s-cloud-only", 80)],
      notes: [],
      reviews: [reviewFixture("r-shared", 3, "s-shared")],
    }),
  );
  const sessionIds = outcome.backup.sessions.map((session) => session.id);
  assert.equal(new Set(sessionIds).size, sessionIds.length);
  assert.deepEqual([...sessionIds].sort(), ["s-cloud-only", "s-local-only", "s-shared"]);
  const shared = outcome.backup.sessions.find((session) => session.id === "s-shared");
  assert.equal(shared?.messages.length, 4, "同一会话的双方消息增量都保留");
  assert.ok(shared?.messages.some((message) => message.id === "local-extra"));
  assert.ok(shared?.messages.some((message) => message.id === "cloud-extra"));
  const messageIds = shared?.messages.map((message) => message.id) ?? [];
  assert.equal(new Set(messageIds).size, messageIds.length);
  const reviewIds = outcome.backup.reviews.map((item) => item.id);
  assert.equal(new Set(reviewIds).size, reviewIds.length);
  const sharedReview = outcome.backup.reviews.find((item) => item.id === "r-shared");
  assert.equal(sharedReview?.attempts, 3, "较新复习进度获胜");
});

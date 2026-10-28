import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { mergeCloudBackupIntoLocal } from "../src/App";
import type { LocalWorkspaceData } from "../src/lib/cloudSync";
import { createBackup } from "../src/lib/backup";
import type { ProviderSettings, StudyBackup, StudySession } from "../src/types";

/*
 * App.tsx 直接 import 了 CSS，Node 测试无法直接加载；与 app-credential-read
 * 相同的 esbuild 方案，只取 applyCloudData 使用的纯合并函数做时钟回归。
 */
let app: { mergeCloudBackupIntoLocal: typeof mergeCloudBackupIntoLocal };

test.before(async () => {
  const outfile = join(process.cwd(), `.app-cloud-merge-${process.pid}.mjs`);
  try {
    await build({
      entryPoints: ["src/App.tsx"],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      external: ["react", "react-dom", "react-dom/*", "lucide-react"],
      loader: {
        ".css": "empty",
        ".woff": "empty",
        ".woff2": "empty",
        ".ttf": "empty",
      },
      logLevel: "silent",
    });
    app = (await import(
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    )) as unknown as typeof app;
  } finally {
    await rm(outfile, { force: true });
  }
});

const SETTINGS: ProviderSettings = {
  provider: "gemini",
  apiKey: "",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
};

function sessionFixture(
  id: string,
  updatedAt: number,
  extraMessage?: string,
): StudySession {
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

function localData(sessions: StudySession[]): LocalWorkspaceData {
  return {
    sessions,
    notes: [],
    reviews: [],
    diagnostics: [],
    activity: [],
    deletedNoteIds: [],
    settingsUpdatedAt: 0,
  };
}

function cloudBackup(sessions: StudySession[]): StudyBackup {
  return createBackup({
    sessions,
    notes: [],
    reviews: [],
    diagnostics: [],
    settingsWithoutSecrets: {
      provider: SETTINGS.provider,
      model: SETTINGS.model,
      baseUrl: SETTINGS.baseUrl,
    },
    activity: [],
    exportedAt: 1,
  });
}

test("applyCloudData 合并：设备时钟快 1 小时时本地旧快照不压过云端真实更新", () => {
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  // 设备时钟快 1h：半小时前记录的 updatedAt 实际是 trueNow + 30min。
  const localSession = sessionFixture(
    "s-shared",
    trueNow + 30 * 60_000,
    "本地旧消息",
  );
  const cloudSession = sessionFixture(
    "s-shared",
    trueNow - 60_000,
    "云端真实新消息",
  );

  const merged = app.mergeCloudBackupIntoLocal(
    localData([{ ...localSession, title: "本地半小时前的旧内容" }]),
    SETTINGS,
    cloudBackup([{ ...cloudSession, title: "云端一分钟前的真实更新" }]),
    {
      // 旧版本本地数据以设备时钟为基准，当前服务端偏移为 -1h。
      localClockOffset: 0,
      serverClockOffset: -hour,
    },
  );

  const session = merged.sessions.find((item) => item.id === "s-shared");
  assert.equal(session?.title, "云端一分钟前的真实更新");
  assert.equal(session?.updatedAt, trueNow - 60_000);
  assert.equal(
    session?.messages.some((message) => message.content === "云端真实新消息"),
    true,
    "云端真实更新不能被本地未来时间戳压过",
  );
  assert.equal(session?.messages.length, 3, "双方消息增量仍应保留");
});

test("本地写入已用 calibratedNow 时 applyCloudData 不会二次换算掉真实新内容", () => {
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  // 本机 5 秒前刚写入：本地状态已是服务端基准。
  const localSession = {
    ...sessionFixture("s-shared", trueNow - 5_000, "本机刚写的新消息"),
    title: "本机刚写的新内容",
  };
  const cloudSession = {
    ...sessionFixture("s-shared", trueNow - 60_000, "云端一分钟前的旧消息"),
    title: "云端一分钟前的旧内容",
  };

  const merged = app.mergeCloudBackupIntoLocal(
    localData([localSession]),
    SETTINGS,
    cloudBackup([cloudSession]),
    {
      localClockOffset: -hour,
      serverClockOffset: -hour,
    },
  );

  const session = merged.sessions.find((item) => item.id === "s-shared");
  assert.equal(session?.title, "本机刚写的新内容");
  assert.equal(session?.updatedAt, trueNow - 5_000);
  assert.equal(session?.messages.length, 3, "双方消息增量仍应保留");
});

test("App 的本地时间写入与 applyCloudData 都走统一校准基准", async () => {
  const source = await readFile(
    new URL("../src/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /function localNow\(\): number \{\s*const now = calibratedNow\(\);/);
  assert.match(source, /Math\.max\(localNow\(\), s\.updatedAt \+ 1\)/);
  assert.match(source, /const merged = mergeCloudBackupIntoLocal\(/);
  assert.match(source, /rememberSettingsUpdatedAt\(localNow\(\)\)/);
  assert.match(source, /const rated = rateReviewItem\(item, rating, now\)/);
});

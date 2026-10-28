import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Note, StudySession } from "../src/types";
import { readStoredValue } from "../src/lib/persistentStorage";
import { isNote, isSession, mergeNotes, useStudyStorage } from "../src/lib/storage";
import { withTabRequestLock } from "../src/lib/requestLock";

const sessionsKey = "zhixu.v1.sessions";

test("损坏或旧格式记录只读回退，不销毁原始内容", () => {
  for (const raw of ["{broken-json", JSON.stringify([{ id: "legacy", title: "旧记录" }])]) {
    const writes: string[] = [];
    const storage = {
      getItem: (key: string) => key === sessionsKey ? raw : null,
      setItem: (_key: string, value: string) => writes.push(value),
    };
    const initial = readStoredValue(storage, "sessions", [], (value): value is never[] => Array.isArray(value) && value.length === 0 && value.every(item => item && typeof item === "object" && "messages" in item));
    assert.deepEqual(initial.value, []);
    assert.equal(initial.preserveRaw, true);
    assert.equal(storage.getItem(sessionsKey), raw);
    assert.deepEqual(writes, [], "初始化不得用空数组覆盖原记录");
  }
});

test("缺失记录和合法记录可以正常初始化，不误标损坏", () => {
  const empty = readStoredValue({ getItem: () => null }, "sessions", [], (value): value is never[] => true);
  assert.deepEqual(empty, { value: [], preserveRaw: false });
  const valid = [{ id: "one", messages: [] }];
  const good = readStoredValue({ getItem: () => JSON.stringify(valid) }, "sessions", [], (value): value is typeof valid => Array.isArray(value));
  assert.deepEqual(good, { value: valid, preserveRaw: false });
});

test("localStorage.getItem 抛异常时视为无记录并返回 fallback，不崩溃", () => {
  const throwing = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const initial = readStoredValue(
    throwing,
    "sessions",
    [] as StudySession[],
    (value): value is StudySession[] => Array.isArray(value) && value.every(isSession),
  );
  assert.deepEqual(initial, { value: [], preserveRaw: false });
});

test("多次渲染只读取一次 localStorage", () => {
  const reads: string[] = [];
  const storage = {
    getItem(key: string) {
      reads.push(key);
      return null;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    let renders = 0;
    function Probe() {
      renders += 1;
      const { sessions, notes, activity } = useStudyStorage();
      const [pass, setPass] = useState(0);
      if (pass === 0) setPass(1);
      return createElement("span", null, `${sessions.length}/${notes.length}/${activity.length}`);
    }
    assert.equal(renderToStaticMarkup(createElement(Probe)), "<span>0/0/0</span>");
    assert.equal(renders, 2, "测试必须触发一次真实的重渲染");
    assert.deepEqual(reads, [
      "zhixu.v1.sessions",
      "zhixu.v1.notes",
      "zhixu.v1.activity",
    ]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("跨标签页锁覆盖整个请求生命周期，并在完成后释放", async () => {
  const held = new Map<string, boolean>();
  const locks = {
    request: async (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
      if (options.ifAvailable && held.get(name)) return callback(null);
      held.set(name, true);
      const lock: Lock = { name, mode: "exclusive" };
      try { return await callback(lock); }
      finally { held.set(name, false); }
    },
  } as LockManager;
  const gate = Promise.withResolvers<void>();
  let firstFinished = false;
  const first = withTabRequestLock(locks, "zhixu.chat.one", async () => {
    await gate.promise;
    firstFinished = true;
    return "done";
  });
  await assert.rejects(
    withTabRequestLock(locks, "zhixu.chat.one", async () => "must-not-run"),
    /另一个标签页/,
  );
  assert.equal(firstFinished, false);
  const other = await withTabRequestLock(locks, "zhixu.chat.other", async () => "independent");
  assert.equal(other, "independent");
  gate.resolve();
  assert.equal(await first, "done");
  assert.equal(await withTabRequestLock(locks, "zhixu.chat.one", async () => "next"), "next");
  assert.equal(await withTabRequestLock(undefined, "zhixu.chat.one", async () => "unsupported"), "unsupported");
  await assert.rejects(
    withTabRequestLock(locks, "zhixu.chat.one", async () => { throw new Error("expected failure"); }),
    /expected failure/,
  );
  assert.equal(await withTabRequestLock(locks, "zhixu.chat.one", async () => "recovered"), "recovered");
});

const validSession: StudySession = {
  id: "s1",
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

test("存储会话必须有有效的 createdAt 与 updatedAt", () => {
  assert.equal(isSession(validSession), true);
  for (const [label, value] of [
    ["缺少 createdAt", { ...validSession, createdAt: undefined }],
    ["createdAt 非数字", { ...validSession, createdAt: "1" }],
    ["createdAt 为 NaN", { ...validSession, createdAt: Number.NaN }],
    ["缺少 updatedAt", { ...validSession, updatedAt: undefined }],
    ["updatedAt 为 Infinity", { ...validSession, updatedAt: Number.POSITIVE_INFINITY }],
  ] as const) {
    assert.equal(isSession(value), false, label);
  }
});

test("存储笔记校验与 Note 契约一致，独立笔记允许空 sessionId", () => {
  const standalone: Note = {
    id: "n1",
    sessionId: "",
    title: "",
    content: "",
    createdAt: 1,
  };
  assert.equal(isNote(standalone), true);
  for (const [label, value] of [
    ["缺少 sessionId", { ...standalone, sessionId: undefined }],
    ["sessionId 非字符串", { ...standalone, sessionId: 1 }],
    ["缺少 createdAt", { ...standalone, createdAt: undefined }],
    ["createdAt 非数字", { ...standalone, createdAt: "1" }],
    ["缺少标题", { ...standalone, title: undefined }],
    ["缺少内容", { ...standalone, content: undefined }],
    ["缺少 ID", { ...standalone, id: "" }],
  ] as const) {
    assert.equal(isNote(value), false, label);
  }
});

test("笔记跨标签页按 ID 合并：双方独有记录都保留，同 ID 以最新传入为准", () => {
  const local: Note[] = [
    { id: "n1", sessionId: "s1", title: "本地", content: "本地内容", createdAt: 2 },
    { id: "n2", sessionId: "", title: "独立", content: "书架笔记", createdAt: 3 },
  ];
  const incoming: Note[] = [
    { id: "n1", sessionId: "s1", title: "本地", content: "刚保存的内容", createdAt: 2 },
    { id: "n3", sessionId: "s2", title: "其它标签", content: "新增", createdAt: 4 },
  ];
  const snapshot = JSON.stringify(local);
  const merged = mergeNotes(local, incoming);
  assert.deepEqual(
    merged.map((note) => note.id),
    ["n1", "n2", "n3"],
  );
  assert.equal(merged[0].content, "刚保存的内容", "同 ID 采用最新传入记录，不写回旧内容");
  assert.equal(merged[1].sessionId, "", "独立笔记的空 sessionId 保留");
  assert.equal(merged[2].content, "新增");
  assert.equal(JSON.stringify(local), snapshot, "合并不得改动输入数组");
});

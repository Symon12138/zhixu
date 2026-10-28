import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatMessage,
  DiagnosticProfile,
  Flashcard,
  LearningState,
  QuizQuestion,
  ReviewItem,
  StudySession,
} from "../src/types";
import {
  SESSION_MERGE_STRATEGIES,
  mergeSessions,
  type MergedSessionField,
  type SessionMergeStrategy,
} from "../src/lib/sessionMerge";
import { readStoredValue } from "../src/lib/persistentStorage";
import { isSession } from "../src/lib/storage";

/* ── 夹具 ────────────────────────────────────────────────────────────── */

const KNOWN_STRATEGIES: Record<SessionMergeStrategy, true> = {
  lww: true,
  "lww-nonempty": true,
  union: true,
  "union-by-id": true,
  "record-merge": true,
  "lww-optional": true,
  min: true,
};

/**
 * 反射清单：satisfies Record<keyof StudySession, true> 让 TypeScript 在
 * StudySession 新增字段而这里漏登记时直接编译失败；运行时再和策略表比对。
 */
const ALL_SESSION_KEYS = {
  id: true,
  title: true,
  topic: true,
  courseId: true,
  level: true,
  goal: true,
  messages: true,
  stageIndex: true,
  completedStages: true,
  stageAnswers: true,
  plan: true,
  quiz: true,
  flashcards: true,
  quizAnswers: true,
  quizSubmitted: true,
  reviewedCards: true,
  reviews: true,
  diagnostic: true,
  transferTrack: true,
  references: true,
  learningState: true,
  bookContext: true,
  createdAt: true,
  updatedAt: true,
} satisfies Record<keyof StudySession, true>;

function quiz(id: string, question = id): QuizQuestion {
  return {
    id,
    question,
    options: ["A", "B"],
    correctIndex: 0,
    explanation: "解释",
    hint: "提示",
  };
}

function review(id: string, attempts = 1): ReviewItem {
  return {
    id,
    sessionId: "s1",
    topic: "主题",
    questionId: "q1",
    prompt: "问题",
    kind: "quiz",
    reason: "原因",
    hint: "提示",
    correctExplanation: "正确解释",
    createdAt: 1,
    dueAt: 2,
    intervalDays: 1,
    streak: 0,
    attempts,
    lastOutcome: "again",
    source: "quiz",
  };
}

function diagnosticFixture(): DiagnosticProfile {
  return {
    id: "d1",
    topic: "主题",
    level: "从零开始",
    questions: [quiz("dq1")],
    answers: { dq1: 0 },
    submitted: true,
    evaluatedAt: 5,
    recommendedStepIndex: 0,
    evidenceSummary: ["证据"],
    weakConcepts: [],
    skippedConcepts: [],
  };
}

function learningState(): LearningState {
  return {
    version: 1,
    revision: 1,
    goal: "目标",
    steps: [],
    currentStepId: "step-1",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: null,
    lastMove: null,
  };
}

function makeSession(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "s1",
    title: "本地标题",
    topic: "主题",
    courseId: "course-1",
    level: "从零开始",
    goal: "目标",
    messages: [
      { id: "m1", role: "user", content: "第一条", timestamp: 10 },
      { id: "m2", role: "assistant", content: "第二条", timestamp: 20 },
    ],
    stageIndex: 0,
    completedStages: ["stage-1"],
    stageAnswers: { "stage-1": 0 },
    plan: ["步骤一"],
    quiz: [quiz("q1")],
    flashcards: [{ id: "c1", front: "正面", back: "背面" }],
    quizAnswers: { q1: 0 },
    quizSubmitted: false,
    reviewedCards: ["c1"],
    references: [{ name: "来源", text: "引文" }],
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

function mergedOne(current: StudySession, incoming: StudySession): StudySession {
  const result = mergeSessions([current], [incoming]);
  assert.equal(result.length, 1, "同一 ID 合并后必须仍只有一个会话");
  return result[0];
}

/* ── 策略表完备性 ────────────────────────────────────────────────────── */

test("策略表覆盖 StudySession 全部字段，id/updatedAt 不参与字段策略", () => {
  const tableKeys = Object.keys(SESSION_MERGE_STRATEGIES);
  const expected = Object.keys(ALL_SESSION_KEYS).filter(
    (key) => key !== "id" && key !== "updatedAt",
  );

  assert.deepEqual(
    [...tableKeys].sort(),
    [...expected].sort(),
    "每个可合并字段都必须在策略表中声明，且策略表不能包含 id/updatedAt",
  );
  assert.equal(tableKeys.includes("id"), false);
  assert.equal(tableKeys.includes("updatedAt"), false);
  assert.equal(new Set(tableKeys).size, tableKeys.length, "策略表不能有重复字段");
});

test("策略表里的每个策略值都是已知策略或带合并函数的 union-by-id", () => {
  const customFields: MergedSessionField[] = [];
  for (const field of Object.keys(
    SESSION_MERGE_STRATEGIES,
  ) as MergedSessionField[]) {
    const rule = SESSION_MERGE_STRATEGIES[field];
    if (typeof rule === "string") {
      assert.ok(
        KNOWN_STRATEGIES[rule],
        `${field} 使用了未知策略 ${String(rule)}`,
      );
      assert.notEqual(rule, "union-by-id", `${field} 的 union-by-id 必须带专用合并函数`);
      continue;
    }
    assert.equal(rule.strategy, "union-by-id", `${field} 的自定义策略只允许 union-by-id`);
    assert.equal(typeof rule.merge, "function", `${field} 缺少合并函数`);
    customFields.push(field);
  }

  // 两个 union-by-id 字段必须是消息与复习项，避免新增字段误用穷举策略。
  assert.deepEqual(customFields.sort(), ["messages", "reviews"]);
});

/* ── union：两边数据都保留 ───────────────────────────────────────────── */

test("union 字段双向合并：双方独有的阶段与已复习闪卡都保留且去重", () => {
  const current = makeSession({
    updatedAt: 300,
    completedStages: ["stage-1", "stage-2", "stage-1"],
    reviewedCards: ["c1"],
  });
  const incoming = makeSession({
    updatedAt: 100,
    completedStages: ["stage-2", "stage-3"],
    reviewedCards: ["c1", "c2", "c2"],
  });

  for (const [label, left, right] of [
    ["incoming 较旧", current, incoming],
    ["incoming 较新", { ...current, updatedAt: 100 }, { ...incoming, updatedAt: 300 }],
  ] as const) {
    const merged = mergedOne(left, right);
    assert.deepEqual(
      [...merged.completedStages].sort(),
      ["stage-1", "stage-2", "stage-3"],
      `${label}：完成阶段不能丢`,
    );
    assert.equal(new Set(merged.completedStages).size, merged.completedStages.length);
    assert.deepEqual([...merged.reviewedCards].sort(), ["c1", "c2"], `${label}：复习卡不能丢`);
    assert.equal(new Set(merged.reviewedCards).size, merged.reviewedCards.length);
  }
});

test("union 字段：空数组不抹掉对方的记录", () => {
  const merged = mergedOne(
    makeSession({ completedStages: ["stage-1"], reviewedCards: ["c1"] }),
    makeSession({ updatedAt: 200, completedStages: [], reviewedCards: [] }),
  );
  assert.deepEqual(merged.completedStages, ["stage-1"]);
  assert.deepEqual(merged.reviewedCards, ["c1"]);
});

/* ── lww-nonempty：新快照为空也不能清空旧内容 ────────────────────────── */

test("lww-nonempty：较新的空计划/测验/闪卡/参考不能覆盖旧的非空内容", () => {
  const older = makeSession({
    updatedAt: 100,
    plan: ["旧计划"],
    quiz: [quiz("q-old")],
    flashcards: [{ id: "c-old", front: "旧正面", back: "旧背面" }],
    references: [{ name: "旧来源", text: "旧引文" }],
  });
  const newer = makeSession({
    updatedAt: 200,
    plan: [],
    quiz: [],
    flashcards: [],
    references: [],
  });

  // incoming 较新但数组为空：策略必须回退到较旧快照的非空内容。
  const merged = mergedOne(older, newer);
  assert.deepEqual(merged.plan, ["旧计划"]);
  assert.deepEqual(merged.quiz, older.quiz);
  assert.deepEqual(merged.flashcards, older.flashcards);
  assert.deepEqual(merged.references, older.references);

  // 反向：较旧为空、较新非空时保留较新的内容。
  const reverse = mergedOne(
    makeSession({ updatedAt: 100, plan: [], quiz: [], flashcards: [], references: [] }),
    makeSession({
      updatedAt: 200,
      plan: ["新计划"],
      quiz: [quiz("q-new")],
      flashcards: [{ id: "c-new", front: "新正面", back: "新背面" }],
      references: [{ name: "新来源", text: "新引文" }],
    }),
  );
  assert.deepEqual(reverse.plan, ["新计划"]);
  assert.deepEqual(reverse.quiz.map((item) => item.id), ["q-new"]);
  assert.deepEqual(reverse.flashcards.map((item) => item.id), ["c-new"]);
  assert.deepEqual(reverse.references.map((item) => item.name), ["新来源"]);
});

test("lww-nonempty：双方都非空时按较新快照整体选择，不出现 undefined", () => {
  const merged = mergedOne(
    makeSession({ plan: ["旧"], quiz: [quiz("q-old")] }),
    makeSession({ updatedAt: 200, plan: ["新"], quiz: [quiz("q-new")] }),
  );
  assert.deepEqual(merged.plan, ["新"]);
  assert.deepEqual(merged.quiz.map((item) => item.id), ["q-new"]);
});

/* ── record-merge：键级并集，0 值不能被真值判断吞掉 ──────────────────── */

test("record-merge：作答键取并集，较新值覆盖同键且保留 0", () => {
  const merged = mergedOne(
    makeSession({
      updatedAt: 100,
      stageAnswers: { "stage-1": 2, "stage-2": 1 },
      quizAnswers: { q1: 1, q2: 0 },
    }),
    makeSession({
      updatedAt: 200,
      stageAnswers: { "stage-1": 0, "stage-3": 1 },
      quizAnswers: { q1: 0, q3: 1 },
    }),
  );
  assert.deepEqual(merged.stageAnswers, {
    "stage-1": 0,
    "stage-2": 1,
    "stage-3": 1,
  });
  assert.deepEqual(merged.quizAnswers, { q1: 0, q2: 0, q3: 1 });
});

test("record-merge：__proto__ 键不会污染全局原型", () => {
  const polluted = JSON.parse('{"__proto__": 1, "safe": 2}') as Record<string, number>;
  const merged = mergedOne(
    makeSession({ stageAnswers: {} }),
    makeSession({ updatedAt: 200, stageAnswers: polluted }),
  );
  assert.equal(merged.stageAnswers.safe, 2);
  const globalScope: Record<string, unknown> = {};
  assert.equal(
    globalScope.polluted,
    undefined,
    "合并恶意键不能向 Object.prototype 写入属性",
  );
  assert.equal(Object.getPrototypeOf(merged.stageAnswers), Object.prototype);
});

/* ── union-by-id：消息与复习项 ───────────────────────────────────────── */

test("消息按 ID 取时间戳较新的版本，双方独有消息都保留并保持时间顺序", () => {
  const current = makeSession({
    messages: [
      { id: "m1", role: "user", content: "旧问题", timestamp: 10 },
      { id: "m2", role: "assistant", content: "本地回答", timestamp: 20 },
    ],
  });
  const incoming = makeSession({
    updatedAt: 200,
    messages: [
      { id: "m1", role: "user", content: "新问题", timestamp: 30 },
      { id: "m3", role: "assistant", content: "云端回答", timestamp: 40 },
    ],
  });

  const merged = mergedOne(current, incoming);
  assert.deepEqual(
    merged.messages.map((message) => message.id),
    ["m2", "m1", "m3"],
    "消息必须按时间戳升序且同一 ID 只保留一份",
  );
  assert.equal(merged.messages.find((message) => message.id === "m1")?.content, "新问题");
  assert.equal(new Set(merged.messages.map((message) => message.id)).size, 3);
});

test("消息时间戳较旧的 incoming 版本不能覆盖较新的本地消息", () => {
  const current = makeSession({
    messages: [{ id: "m1", role: "user", content: "本地较新", timestamp: 50 }],
  });
  const incoming = makeSession({
    updatedAt: 999,
    messages: [{ id: "m1", role: "user", content: "云端较旧", timestamp: 5 }],
  });
  const merged = mergedOne(current, incoming);
  assert.equal(merged.messages[0].content, "本地较新");
});

test("消息时间戳相等时 incoming 获胜且不丢失另一方的独有消息", () => {
  const current = makeSession({
    messages: [
      { id: "m1", role: "user", content: "当前", timestamp: 10 },
      { id: "m2", role: "assistant", content: "当前独有", timestamp: 20 },
    ],
  });
  const incoming = makeSession({
    updatedAt: 200,
    messages: [{ id: "m1", role: "user", content: "来件", timestamp: 10 }],
  });
  const merged = mergedOne(current, incoming);
  assert.equal(merged.messages.find((message) => message.id === "m1")?.content, "来件");
  assert.ok(merged.messages.some((message) => message.id === "m2"));
});

test("复习项按会话新旧选择同 ID 版本，双方独有复习项都保留", () => {
  const newerSide = mergedOne(
    makeSession({ updatedAt: 100, reviews: [review("r1", 1), review("r2", 1)] }),
    makeSession({ updatedAt: 200, reviews: [review("r1", 3), review("r3", 1)] }),
  );
  assert.deepEqual(
    newerSide.reviews?.map((item) => [item.id, item.attempts]).sort(),
    [["r1", 3], ["r2", 1], ["r3", 1]],
  );

  const olderSide = mergedOne(
    makeSession({ updatedAt: 200, reviews: [review("r1", 5)] }),
    makeSession({ updatedAt: 100, reviews: [review("r1", 1)] }),
  );
  assert.equal(olderSide.reviews?.[0].attempts, 5, "较旧快照不能覆盖复习进度");
});

test("复习项缺省与空数组互操作时不丢数据", () => {
  const kept = mergedOne(
    makeSession({ updatedAt: 200, reviews: [review("r1")] }),
    makeSession({ updatedAt: 100, reviews: undefined }),
  );
  assert.deepEqual(kept.reviews?.map((item) => item.id), ["r1"]);

  const added = mergedOne(
    makeSession({ updatedAt: 100, reviews: undefined }),
    makeSession({ updatedAt: 200, reviews: [review("r2")] }),
  );
  assert.deepEqual(added.reviews?.map((item) => item.id), ["r2"]);
});

/* ── lww-optional 与普通 lww ─────────────────────────────────────────── */

test("lww-optional：较新快照缺省的可选对象回退到较旧值，不丢失诊断/迁移/书籍上下文", () => {
  const diagnostic = diagnosticFixture();
  const track = {
    id: "t1",
    sessionId: "s1",
    steps: [],
    currentStepId: "",
    createdAt: 1,
    updatedAt: 2,
  };
  const bookContext = {
    bookId: "book-1",
    title: "书",
    author: "作者",
    format: "txt" as const,
    mode: "chapter" as const,
    tableOfContents: ["第一章"],
    totalChapters: 1,
    totalBlocks: 2,
    chapterBlocks: 2,
    suppliedBlockIds: ["b1"],
    completeChapter: true,
    completeBook: false,
  };

  const merged = mergedOne(
    makeSession({
      diagnostic,
      transferTrack: track,
      bookContext,
      learningState: learningState(),
    }),
    makeSession({
      updatedAt: 200,
      diagnostic: undefined,
      transferTrack: undefined,
      bookContext: undefined,
      learningState: undefined,
    }),
  );
  assert.deepEqual(merged.diagnostic, diagnostic);
  assert.deepEqual(merged.transferTrack, track);
  assert.deepEqual(merged.bookContext, bookContext);
  assert.deepEqual(merged.learningState, learningState());
});

test("lww-optional：较新快照提供的对象整体生效，局部缺字段也不会崩溃", () => {
  const partialDiagnostic = {
    id: "d-partial",
    topic: "主题",
  } as unknown as StudySession["diagnostic"];
  const merged = mergedOne(
    makeSession({ diagnostic: diagnosticFixture() }),
    makeSession({ updatedAt: 200, diagnostic: partialDiagnostic }),
  );
  assert.equal(merged.diagnostic, partialDiagnostic);
});

test("普通 lww 字段只由 updatedAt 决定胜负，createdAt 取双方较早值", () => {
  const current = makeSession({
    updatedAt: 200,
    createdAt: 2,
    title: "当前标题",
    topic: "当前主题",
    level: "当前等级",
    goal: "当前目标",
    stageIndex: 2,
    quizSubmitted: true,
  });
  const olderIncoming = makeSession({
    updatedAt: 100,
    createdAt: 1,
    title: "旧标题",
    topic: "旧主题",
    level: "旧等级",
    goal: "旧目标",
    stageIndex: 0,
    quizSubmitted: false,
  });
  const keepCurrent = mergedOne(current, olderIncoming);
  assert.equal(keepCurrent.title, "当前标题");
  assert.equal(keepCurrent.topic, "当前主题");
  assert.equal(keepCurrent.level, "当前等级");
  assert.equal(keepCurrent.goal, "当前目标");
  assert.equal(keepCurrent.stageIndex, 2);
  assert.equal(keepCurrent.quizSubmitted, true);
  assert.equal(keepCurrent.createdAt, 1, "createdAt 取双方较早值，不随较新快照漂移");

  const newerIncoming = mergedOne(olderIncoming, current);
  assert.equal(newerIncoming.title, "当前标题");
  assert.equal(newerIncoming.updatedAt, 200);
  assert.equal(newerIncoming.createdAt, 1);
});

test("updatedAt 相等时 incoming 获胜，合并时间取双方较大值", () => {
  const merged = mergedOne(
    makeSession({ updatedAt: 123, title: "当前" }),
    makeSession({ updatedAt: 123, title: "来件" }),
  );
  assert.equal(merged.title, "来件");
  assert.equal(merged.updatedAt, 123);
});

test("不同 ID 的会话全部保留、按 updatedAt 降序且重复合并收敛", () => {
  const a = makeSession({ id: "s-a", updatedAt: 300 });
  const b = makeSession({ id: "s-b", updatedAt: 100 });
  const c = makeSession({ id: "s-c", updatedAt: 200 });
  const first = mergeSessions([a, b], [c]);
  assert.deepEqual(first.map((session) => session.id), ["s-a", "s-c", "s-b"]);

  const second = mergeSessions(first, [c]);
  assert.deepEqual(second.map((session) => session.id), first.map((session) => session.id));
  const firstC = first.find((session) => session.id === "s-c");
  const secondC = second.find((session) => session.id === "s-c");
  assert.deepEqual(secondC?.messages, firstC?.messages, "重复同步不得丢失消息");
  assert.deepEqual(secondC?.plan, firstC?.plan);
  assert.deepEqual(secondC?.completedStages, firstC?.completedStages);
  // 合并会为同 ID 冲突的会话补全可选字段（如 reviews: []），一次规范化后必须稳定。
  assert.equal(
    JSON.stringify(mergeSessions(second, [c])),
    JSON.stringify(second),
    "规范化后的重复同步不得改变已合并结果",
  );
});

/* ── 恶意嵌套结构 ────────────────────────────────────────────────────── */

test("恶意嵌套结构：quiz/flashcards/references 局部缺字段时合并不崩溃且不丢类别", () => {
  const hostileQuiz = [{ id: "q-hostile" } as unknown as QuizQuestion];
  const hostileFlashcards = [{ id: "c-hostile" } as unknown as Flashcard];
  const hostileReferences = [
    { name: "只有名称" } as unknown as StudySession["references"][number],
  ];
  const hostileLearningState = { version: 1 } as unknown as LearningState;

  const merged = mergedOne(
    makeSession({ updatedAt: 100 }),
    makeSession({
      updatedAt: 200,
      quiz: hostileQuiz,
      flashcards: hostileFlashcards,
      references: hostileReferences,
      learningState: hostileLearningState,
    }),
  );
  assert.equal(merged.quiz, hostileQuiz);
  assert.equal(merged.flashcards, hostileFlashcards);
  assert.equal(merged.references, hostileReferences);
  assert.equal(merged.learningState, hostileLearningState);
});

test("本地存储校验放过的 null 消息/复习项元素不能让合并抛 TypeError", () => {
  const nullMessageSession = makeSession({
    messages: [null as unknown as ChatMessage],
  });
  const nullReviewSession = makeSession({
    reviews: [null as unknown as ReviewItem],
  });

  const scenarios: Array<[string, StudySession[]]> = [
    ["messages 含 null", [nullMessageSession]],
    ["reviews 含 null", [nullReviewSession]],
  ];
  const crashes: string[] = [];

  for (const [label, sessions] of scenarios) {
    // 复刻 useStoredList 的真实读盘路径：校验层接受后就会进入合并。
    const loaded = readStoredValue(
      { getItem: () => JSON.stringify(sessions) },
      "sessions",
      [] as StudySession[],
      (value): value is StudySession[] =>
        Array.isArray(value) && value.every((item) => isSession(item)),
    );
    // 校验层拒绝坏记录是可接受的防线；只有“校验放过 + 合并抛错”才违反不变量。
    if (loaded.preserveRaw) continue;
    try {
      mergeSessions(loaded.value, loaded.value);
    } catch (error) {
      crashes.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  assert.deepEqual(
    crashes,
    [],
    "本地校验放过的恶意记录会让合并抛出 TypeError；useStudyStorage 只能把它降级成持久化失败，" +
      `而不是让坏记录被校验层拒绝：\n${crashes.join("\n")}`,
  );
});

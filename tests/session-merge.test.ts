import assert from "node:assert/strict";
import test from "node:test";
import type { BookStudyContext } from "../src/bookTypes";
import type {
  DiagnosticProfile,
  LearningState,
  ReviewItem,
  StudySession,
  TransferTrack,
} from "../src/types";
import {
  mergeSessions,
  mergeSessionIds,
  SESSION_MERGE_STRATEGIES,
  type SessionMergeStrategy,
} from "../src/lib/sessionMerge";

function session(id: string, updatedAt: number): StudySession {
  return {
    id, title: id, topic: id, level: "从零开始", goal: id,
    messages: [], stageIndex: 0, completedStages: [], stageAnswers: {},
    plan: [], quiz: [], flashcards: [], quizAnswers: {}, quizSubmitted: false,
    reviewedCards: [], references: [], createdAt: 1, updatedAt,
  };
}

function learningState(
  revision: number,
  goal: string,
  evidenceQuote: string,
): LearningState {
  return {
    version: 1,
    revision,
    goal,
    steps: [{ id: "step-1", title: "理解净值", mastery: "learning", evidence: [] }],
    currentStepId: "step-1",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: {
      verdict: "partial",
      evidenceQuote,
      questionId: "q-1",
      demonstrated: "reasoning",
      feedback: `第 ${revision} 次评估`,
    },
    lastMove: "probe",
  };
}

function diagnostic(
  profileId: string,
  evidence: string,
  evaluatedAt: number,
): DiagnosticProfile {
  return {
    id: profileId,
    topic: "银行理财",
    level: "从零开始",
    questions: [
      {
        id: "dq-1",
        question: "单位净值是什么？",
        options: ["每份产品的价值", "产品的总售价"],
        correctIndex: 0,
        explanation: "单位净值是每份产品当前的价值。",
        hint: "想清楚分母。",
      },
    ],
    answers: { "dq-1": 0 },
    submitted: true,
    evaluatedAt,
    recommendedStepIndex: 0,
    evidenceSummary: [evidence],
    weakConcepts: [],
    skippedConcepts: [],
  };
}

function transferTrack(
  trackId: string,
  currentStepId: string,
  updatedAt: number,
): TransferTrack {
  return {
    id: trackId,
    sessionId: "s1",
    steps: [
      {
        id: currentStepId,
        title: "迁移到真实场景",
        scenario: "银行 App 展示单位净值",
        prompt: "净值下跌是否代表亏损已实现？",
        expectedFocus: "区分浮亏与已实现亏损",
        level: "variant",
        status: "current",
      },
    ],
    currentStepId,
    createdAt: 1,
    updatedAt,
  };
}

function bookContext(bookId: string): BookStudyContext {
  return {
    bookId,
    title: `书名 ${bookId}`,
    author: "作者",
    format: "epub",
    mode: "chapter",
    chapterId: `${bookId}-ch1`,
    chapterTitle: "第一章 净值",
    tableOfContents: ["第一章 净值"],
    totalChapters: 1,
    totalBlocks: 2,
    chapterBlocks: 2,
    suppliedBlockIds: [`${bookId}-b1`, `${bookId}-b2`],
    completeChapter: true,
    completeBook: true,
  };
}

function review(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    sessionId: "s1",
    topic: "银行理财",
    questionId: "q-1",
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
    ...overrides,
  };
}

test("跨标签页合并保留同一会话双方新增消息和最新发送状态", () => {
  const first = session("one", 1);
  first.messages = [{ id: "u1", role: "user", content: "问题", timestamp: 1, delivery: "failed" }];
  const second = session("one", 2);
  second.messages = [...first.messages, { id: "a2", role: "assistant", content: "回答", timestamp: 2 }];
  const firstWithRetry = session("one", 3);
  firstWithRetry.messages = [{ ...first.messages[0], delivery: "sent" }];
  const merged = mergeSessions([first], [second, firstWithRetry]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].messages.map(message => message.id), ["u1", "a2"]);
  assert.equal(merged[0].messages[0].delivery, "sent");
  assert.equal(merged[0].updatedAt, 3);
});

test("跨标签页合并保留不同会话、完成阶段和活动日期", () => {
  const a = session("a", 1);
  a.completedStages = ["intro"];
  a.reviewedCards = ["card-a"];
  const b = session("b", 2);
  const merged = mergeSessions([a], [b]);
  assert.deepEqual(new Set(merged.map(item => item.id)), new Set(["a", "b"]));
  assert.deepEqual(mergeSessionIds(["2026-10-25"], ["2026-10-25", "2026-10-24"]), ["2026-10-25", "2026-10-24"]);
});

test("较旧 incoming 快照不覆盖较新 current 的字段，但保留双方增量", () => {
  const current = session("s1", 2000);
  current.title = "当前标题";
  current.plan = ["当前计划"];
  current.learningState = learningState(3, "当前目标", "我现在能解释净值了");
  current.diagnostic = diagnostic("diag-current", "当前诊断证据", 1900);
  current.transferTrack = transferTrack("track-current", "current-step", 1900);
  current.bookContext = bookContext("book-current");
  current.messages = [
    { id: "m-shared", role: "user", content: "双方都有的提问", timestamp: 10 },
    { id: "m-current", role: "assistant", content: "当前标签页的回复", timestamp: 20 },
  ];
  current.completedStages = ["stage-1"];
  current.reviewedCards = ["card-1"];
  current.reviews = [
    review("review-shared", {
      prompt: "当前快照的复习题",
      attempts: 2,
      lastOutcome: "known",
      dueAt: 900,
    }),
    review("review-current-only"),
  ];
  current.stageAnswers = { "stage-shared": 1 };
  current.quizAnswers = { "quiz-shared": 1 };

  const incoming = session("s1", 1000);
  incoming.title = "过期标题";
  incoming.plan = ["过期计划"];
  incoming.learningState = learningState(1, "过期目标", "旧证据");
  incoming.diagnostic = diagnostic("diag-stale", "过期诊断证据", 900);
  incoming.transferTrack = transferTrack("track-stale", "stale-step", 900);
  incoming.bookContext = bookContext("book-stale");
  incoming.messages = [
    { id: "m-old", role: "user", content: "旧标签页的提问", timestamp: 5 },
    { id: "m-shared", role: "user", content: "双方都有的提问", timestamp: 10 },
  ];
  incoming.completedStages = ["stage-old"];
  incoming.reviewedCards = ["card-old"];
  incoming.reviews = [
    review("review-shared", {
      prompt: "旧快照的复习题",
      attempts: 1,
      lastOutcome: "again",
      dueAt: 300,
    }),
    review("review-old-only"),
  ];
  incoming.stageAnswers = { "stage-shared": 0, "stage-old-only": 0 };
  incoming.quizAnswers = { "quiz-shared": 0, "quiz-old-only": 0 };

  const merged = mergeSessions([current], [incoming]);
  assert.equal(merged.length, 1);
  const [result] = merged;

  assert.equal(result.title, "当前标题");
  assert.equal(result.updatedAt, 2000);
  assert.deepEqual(result.plan, ["当前计划"]);
  assert.equal(result.learningState?.revision, 3);
  assert.equal(result.learningState?.goal, "当前目标");
  assert.equal(result.learningState?.lastAssessment?.evidenceQuote, "我现在能解释净值了");
  assert.equal(result.diagnostic?.id, "diag-current");
  assert.equal(result.diagnostic?.evidenceSummary[0], "当前诊断证据");
  assert.equal(result.transferTrack?.currentStepId, "current-step");
  assert.equal(result.bookContext?.bookId, "book-current");

  assert.deepEqual(result.messages.map((message) => message.id), ["m-old", "m-shared", "m-current"]);
  assert.equal(
    result.messages.find((message) => message.id === "m-shared")?.content,
    "双方都有的提问",
  );
  assert.deepEqual([...result.completedStages].sort(), ["stage-1", "stage-old"]);
  assert.deepEqual([...result.reviewedCards].sort(), ["card-1", "card-old"]);

  assert.deepEqual(
    [...(result.reviews ?? [])].map((item) => item.id).sort(),
    ["review-current-only", "review-old-only", "review-shared"],
  );
  const sharedReview = result.reviews?.find((item) => item.id === "review-shared");
  assert.equal(sharedReview?.prompt, "当前快照的复习题");
  assert.equal(sharedReview?.attempts, 2);
  assert.equal(sharedReview?.lastOutcome, "known");
  assert.equal(sharedReview?.dueAt, 900);

  assert.deepEqual(result.stageAnswers, { "stage-shared": 1, "stage-old-only": 0 });
  assert.deepEqual(result.quizAnswers, { "quiz-shared": 1, "quiz-old-only": 0 });
});

test("较新 incoming 快照以其字段为准，同时保留双方增量", () => {
  const current = session("s1", 1000);
  current.title = "旧标题";
  current.plan = ["旧计划"];
  current.learningState = learningState(1, "旧目标", "旧证据");
  current.diagnostic = diagnostic("diag-stale", "旧诊断证据", 900);
  current.transferTrack = transferTrack("track-stale", "stale-step", 900);
  current.bookContext = bookContext("book-stale");
  current.messages = [{ id: "m-current", role: "user", content: "旧标签页的提问", timestamp: 1 }];
  current.completedStages = ["stage-1"];
  current.reviews = [
    review("review-shared", { attempts: 1, lastOutcome: "again", dueAt: 300 }),
  ];

  const incoming = session("s1", 4000);
  incoming.title = "新标题";
  incoming.plan = ["新计划"];
  incoming.learningState = learningState(4, "新目标", "新证据");
  incoming.diagnostic = diagnostic("diag-incoming", "新诊断证据", 3900);
  incoming.transferTrack = transferTrack("track-incoming", "incoming-step", 3900);
  incoming.bookContext = bookContext("book-incoming");
  incoming.messages = [{ id: "m-incoming", role: "assistant", content: "新标签页的回复", timestamp: 2 }];
  incoming.completedStages = ["stage-2"];
  incoming.quiz = [
    {
      id: "quiz-incoming",
      question: "净值下跌意味着？",
      options: ["浮亏", "已实现亏损"],
      correctIndex: 0,
      explanation: "未卖出时只是浮亏。",
      hint: "看是否卖出。",
    },
  ];
  incoming.flashcards = [{ id: "card-incoming", front: "净值", back: "每份价值" }];
  incoming.references = [{ name: "新参考", text: "净值章节" }];
  incoming.reviews = [
    review("review-shared", { attempts: 3, lastOutcome: "known", dueAt: 1200 }),
  ];

  const merged = mergeSessions([current], [incoming]);
  assert.equal(merged.length, 1);
  const [result] = merged;

  assert.equal(result.title, "新标题");
  assert.equal(result.updatedAt, 4000);
  assert.deepEqual(result.plan, ["新计划"]);
  assert.equal(result.learningState?.revision, 4);
  assert.equal(result.learningState?.goal, "新目标");
  assert.equal(result.learningState?.lastAssessment?.evidenceQuote, "新证据");
  assert.equal(result.diagnostic?.id, "diag-incoming");
  assert.equal(result.transferTrack?.currentStepId, "incoming-step");
  assert.equal(result.bookContext?.bookId, "book-incoming");
  assert.deepEqual(result.quiz.map((item) => item.id), ["quiz-incoming"]);
  assert.deepEqual(result.flashcards.map((item) => item.id), ["card-incoming"]);
  assert.deepEqual(result.references.map((item) => item.name), ["新参考"]);

  assert.deepEqual(result.messages.map((message) => message.id), ["m-current", "m-incoming"]);
  assert.deepEqual([...result.completedStages].sort(), ["stage-1", "stage-2"]);
  const sharedReview = result.reviews?.find((item) => item.id === "review-shared");
  assert.equal(sharedReview?.attempts, 3);
  assert.equal(sharedReview?.lastOutcome, "known");
  assert.equal(sharedReview?.dueAt, 1200);
});

test("同 ID 复习项逐项采用较新版本，旧快照独有复习项仍保留", () => {
  const older = session("s1", 1000);
  older.reviews = [
    review("r1", { attempts: 1, lastOutcome: "again", dueAt: 400 }),
    review("r-older-only"),
  ];
  const newer = session("s1", 2000);
  newer.reviews = [
    review("r1", { attempts: 4, lastOutcome: "known", dueAt: 2000, streak: 3 }),
  ];

  const [currentIsNewer] = mergeSessions([newer], [older]);
  assert.deepEqual(
    (currentIsNewer.reviews ?? []).map((item) => item.id).sort(),
    ["r-older-only", "r1"],
  );
  const kept = currentIsNewer.reviews?.find((item) => item.id === "r1");
  assert.equal(kept?.attempts, 4);
  assert.equal(kept?.lastOutcome, "known");
  assert.equal(kept?.dueAt, 2000);
  assert.equal(kept?.streak, 3);

  const [incomingIsNewer] = mergeSessions([older], [newer]);
  const fromIncoming = incomingIsNewer.reviews?.find((item) => item.id === "r1");
  assert.equal(fromIncoming?.attempts, 4);
  assert.equal(fromIncoming?.lastOutcome, "known");
  assert.equal(fromIncoming?.dueAt, 2000);
  assert.equal(incomingIsNewer.updatedAt, 2000);
});

test("会话 updatedAt 较新的旧复习项不覆盖另一标签页已打分的复习项", () => {
  // 标签页 A 刚给复习项打分；标签页 B 只是后来改了消息，却带着旧复习进度。
  const tabA = session("s1", 1000);
  tabA.reviews = [
    review("r1", {
      attempts: 3,
      lastOutcome: "known",
      dueAt: 1800,
      streak: 2,
      updatedAt: 1500,
    }),
    review("r-legacy", { attempts: 2, lastOutcome: "known", dueAt: 900 }),
    review("r-due", { attempts: 1, lastOutcome: "again", dueAt: 900 }),
    review("r-graded", { attempts: 1, lastOutcome: "known", dueAt: 500 }),
    review("r-a-only"),
  ];

  const tabB = session("s1", 2000);
  tabB.messages = [
    { id: "m-b", role: "user", content: "B 只改了消息", timestamp: 2500 },
  ];
  tabB.reviews = [
    review("r1", {
      attempts: 1,
      lastOutcome: "again",
      dueAt: 300,
      streak: 0,
      updatedAt: 1000,
    }),
    review("r-legacy", { attempts: 1, lastOutcome: "again", dueAt: 300 }),
    review("r-due", { attempts: 1, lastOutcome: "again", dueAt: 300 }),
    review("r-graded", {
      attempts: 1,
      lastOutcome: undefined,
      dueAt: 500,
    }),
    review("r-b-only"),
  ];

  // 无论哪一边作为 current / incoming，都应由每个复习项自身的版本决定胜负。
  for (const merged of [
    mergeSessions([tabA], [tabB]),
    mergeSessions([tabB], [tabA]),
  ]) {
    assert.equal(merged.length, 1);
    const [result] = merged;
    assert.equal(result.updatedAt, 2000);
    assert.ok(result.messages.some((message) => message.id === "m-b"));

    const reviews = new Map((result.reviews ?? []).map((item) => [item.id, item]));
    assert.deepEqual(
      [...reviews.keys()].sort(),
      ["r-a-only", "r-b-only", "r-due", "r-graded", "r-legacy", "r1"],
    );
    assert.equal(reviews.get("r1")?.attempts, 3);
    assert.equal(reviews.get("r1")?.lastOutcome, "known");
    assert.equal(reviews.get("r1")?.dueAt, 1800);
    assert.equal(reviews.get("r1")?.streak, 2);
    assert.equal(reviews.get("r1")?.updatedAt, 1500);
    assert.equal(reviews.get("r-legacy")?.attempts, 2);
    assert.equal(reviews.get("r-legacy")?.lastOutcome, "known");
    assert.equal(reviews.get("r-due")?.dueAt, 900);
    assert.equal(reviews.get("r-graded")?.lastOutcome, "known");
  }
});

test("复习项版本独立于会话 updatedAt：较旧会话里的较新复习项仍然胜出", () => {
  const newerSessionOldItem = session("s1", 3000);
  newerSessionOldItem.reviews = [
    review("r1", { attempts: 9, lastOutcome: "again", dueAt: 900, updatedAt: 100 }),
  ];
  const olderSessionNewItem = session("s1", 2000);
  olderSessionNewItem.reviews = [
    review("r1", { attempts: 1, lastOutcome: "known", dueAt: 700, updatedAt: 500 }),
  ];

  for (const merged of [
    mergeSessions([newerSessionOldItem], [olderSessionNewItem]),
    mergeSessions([olderSessionNewItem], [newerSessionOldItem]),
  ]) {
    const item = merged[0].reviews?.find((reviewItem) => reviewItem.id === "r1");
    assert.equal(merged[0].updatedAt, 3000);
    assert.equal(item?.updatedAt, 500);
    assert.equal(item?.attempts, 1);
    assert.equal(item?.lastOutcome, "known");
    assert.equal(item?.dueAt, 700);
  }
});

test("createdAt 合并取双方较早值，不随较新快照漂移", () => {
  const early = { ...session("s1", 5000), createdAt: 1000 };
  const late = { ...session("s1", 3000), createdAt: 2000 };

  for (const merged of [
    mergeSessions([early], [late]),
    mergeSessions([late], [early]),
  ]) {
    assert.equal(merged.length, 1);
    assert.equal(merged[0].createdAt, 1000);
    assert.equal(merged[0].updatedAt, 5000);
  }

  const sameCreation = { ...session("s1", 4000), createdAt: 1000 };
  const [mergedSame] = mergeSessions([early], [sameCreation]);
  assert.equal(mergedSame.createdAt, 1000);
});

test("较新快照的空 quiz、flashcards、references 不覆盖较旧快照内容", () => {
  const deviceA = session("s1", 1000);
  deviceA.quiz = [
    {
      id: "q1",
      question: "单位净值是什么？",
      options: ["每份产品的价值", "产品的总售价"],
      correctIndex: 0,
      explanation: "单位净值是每份产品当前的价值。",
      hint: "想清楚分母。",
    },
    {
      id: "q2",
      question: "净值下跌意味着亏损已实现吗？",
      options: ["是", "否"],
      correctIndex: 1,
      explanation: "未卖出时只是浮亏。",
      hint: "看是否已经卖出。",
    },
  ];
  deviceA.flashcards = [{ id: "f1", front: "单位净值", back: "每份产品当前的价值" }];
  deviceA.references = [{ name: "资料一", text: "净值章节" }];

  // 设备 B 的 updatedAt 更新，但 quiz / flashcards / references 均为空。
  const deviceB = session("s1", 2000);

  for (const merged of [
    mergeSessions([deviceA], [deviceB]),
    mergeSessions([deviceB], [deviceA]),
  ]) {
    assert.equal(merged.length, 1);
    const [result] = merged;
    assert.equal(result.updatedAt, 2000);
    assert.deepEqual(result.quiz.map((item) => item.id), ["q1", "q2"]);
    assert.deepEqual(result.flashcards.map((item) => item.id), ["f1"]);
    assert.deepEqual(result.references.map((item) => item.name), ["资料一"]);
  }
});

test("较新快照的 quiz、flashcards、references 有内容时取较新", () => {
  const older = session("s1", 1000);
  older.quiz = [
    {
      id: "q-old",
      question: "旧问题",
      options: ["A", "B"],
      correctIndex: 0,
      explanation: "旧解析",
      hint: "旧提示",
    },
  ];
  older.flashcards = [{ id: "f-old", front: "旧正面", back: "旧背面" }];
  older.references = [{ name: "旧资料", text: "旧内容" }];

  const newer = session("s1", 2000);
  newer.quiz = [
    {
      id: "q-new",
      question: "新问题",
      options: ["C", "D"],
      correctIndex: 1,
      explanation: "新解析",
      hint: "新提示",
    },
  ];
  newer.flashcards = [{ id: "f-new", front: "新正面", back: "新背面" }];
  newer.references = [{ name: "新资料", text: "新内容" }];

  for (const merged of [
    mergeSessions([older], [newer]),
    mergeSessions([newer], [older]),
  ]) {
    assert.equal(merged.length, 1);
    const [result] = merged;
    assert.equal(result.updatedAt, 2000);
    assert.deepEqual(result.quiz.map((item) => item.id), ["q-new"]);
    assert.deepEqual(result.flashcards.map((item) => item.id), ["f-new"]);
    assert.deepEqual(result.references.map((item) => item.name), ["新资料"]);
  }
});

test("合并策略表与 StudySession 字段一一对应且策略合法", () => {
  const expectedFields: Record<
    Exclude<keyof StudySession, "id" | "updatedAt">,
    true
  > = {
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
  };

  assert.deepEqual(
    Object.keys(SESSION_MERGE_STRATEGIES).sort(),
    Object.keys(expectedFields).sort(),
  );

  const validStrategies: Record<SessionMergeStrategy, true> = {
    lww: true,
    "lww-nonempty": true,
    union: true,
    "union-by-id": true,
    "record-merge": true,
    "lww-optional": true,
    min: true,
  };
  assert.equal(
    SESSION_MERGE_STRATEGIES.createdAt,
    "min",
    "createdAt 必须使用取较早值的 min 策略",
  );
  for (const [field, rule] of Object.entries(SESSION_MERGE_STRATEGIES)) {
    const strategy = typeof rule === "string" ? rule : rule.strategy;
    assert.ok(
      validStrategies[strategy],
      `${field} 使用了未知合并策略：${strategy}`,
    );
  }
});

test("时钟校准：current 快 1 小时时按偏移比较，旧快照不压过较新的 incoming", () => {
  const trueNow = 1_800_000_000_000;
  const hour = 3_600_000;
  // 设备快 1 小时：两小时前的编辑记录成 trueNow - 1h，校准后是 trueNow - 2h。
  const local = { ...session("clock", trueNow - hour), title: "本地旧内容" };
  const cloud = { ...session("clock", trueNow - 60_000), title: "云端新内容" };
  const merged = mergeSessions([local], [cloud], { currentClockOffset: -hour });
  assert.equal(merged[0].title, "云端新内容");
  assert.equal(merged[0].updatedAt, trueNow - 60_000);
});

test("同 ID 同时间戳的消息：已发送不被失败状态覆盖", () => {
  const sent = session("s1", 2000);
  sent.messages = [{ id: "m1", role: "user", content: "问", timestamp: 100, delivery: "sent" }];
  const failed = session("s1", 1000);
  failed.messages = [{ id: "m1", role: "user", content: "问", timestamp: 100, delivery: "failed" }];

  for (const merged of [mergeSessions([sent], [failed]), mergeSessions([failed], [sent])]) {
    assert.equal(merged[0].messages[0].delivery, "sent");
  }
});

test("courseId 是可选字段：较新快照缺省时回退较旧快照的课程关联", () => {
  const withCourse = { ...session("s1", 1000), courseId: "derivative" };
  const withoutCourse = session("s1", 2000);

  for (const merged of [mergeSessions([withCourse], [withoutCourse]), mergeSessions([withoutCourse], [withCourse])]) {
    assert.equal(merged[0].courseId, "derivative");
  }
});

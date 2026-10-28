import assert from "node:assert/strict";
import test from "node:test";
import type {
  DiagnosticProfile,
  LearningState,
  Note,
  ReviewItem,
  StudyBackup,
  StudySession,
} from "../src/types";
import {
  createBackup,
  MAX_DELETED_NOTE_IDS,
  mergeBackup,
  parseBackup,
} from "../src/lib/backup";
import { mergeNotes } from "../src/lib/storage";

function sessionFixture(id: string, updatedAt: number): StudySession {
  return {
    id,
    title: `会话 ${id}`,
    topic: "银行理财",
    level: "从零开始",
    goal: "理解净值机制",
    messages: [
      { id: `${id}-m1`, role: "user", content: "什么是单位净值？", timestamp: 1 },
      {
        id: `${id}-m2`,
        role: "assistant",
        content: "单位净值是每份产品当前的价值。",
        timestamp: 2,
      },
    ],
    stageIndex: 0,
    completedStages: [],
    stageAnswers: {},
    plan: ["先讲概念", "再做推理题"],
    quiz: [
      {
        id: `${id}-q1`,
        question: "分红从哪里支付？",
        options: ["产品资产", "客户存款"],
        correctIndex: 0,
        explanation: "分红从产品资产中转出。",
        hint: "想清楚钱的来源。",
      },
    ],
    flashcards: [{ id: `${id}-c1`, front: "单位净值", back: "每份产品当前价值" }],
    quizAnswers: {},
    quizSubmitted: false,
    reviewedCards: [],
    references: [{ name: "教材", text: "净值相关章节" }],
    createdAt: 1,
    updatedAt,
  };
}

function reviewFixture(id: string): ReviewItem {
  return {
    id,
    sessionId: "s1",
    topic: "银行理财",
    questionId: "s1-q1",
    prompt: "分红从哪里支付？",
    kind: "quiz",
    reason: "测验答错",
    hint: "想清楚钱的来源。",
    learnerQuote: "分红是额外发的钱",
    correctExplanation: "分红从产品资产中转出，进入客户现金账户。",
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
        id: "d1-q1",
        question: "累计净值是否扣除分红？",
        options: ["不扣除", "扣除"],
        correctIndex: 0,
        explanation: "累计净值把历史分红加回。",
        hint: "对比单位净值。",
      },
    ],
    answers: { "d1-q1": 1 },
    submitted: true,
    evaluatedAt: 300,
    recommendedStepIndex: 0,
    evidenceSummary: ["对分红机制判断错误"],
    weakConcepts: ["累计净值"],
    skippedConcepts: [],
  };
}

function noteFixture(id: string): Note {
  return {
    id,
    sessionId: "s1",
    title: "净值笔记",
    content: "单位净值每份当前价值，累计净值含历史分红。",
    createdAt: 50,
  };
}

function stateWithEvidence(): LearningState {
  return {
    version: 1,
    revision: 2,
    goal: "理解净值机制",
    steps: [
      {
        id: "step-1",
        title: "两种净值的区别",
        mastery: "understood",
        evidence: [
          {
            quote: "累计净值把历史分红加回来",
            questionId: "s1-q1",
            kind: "reasoning",
            turn: 2,
          },
        ],
      },
    ],
    currentStepId: "step-1",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: null,
    lastMove: "explain",
  };
}

function safeSettingsFixture(): StudyBackup["settingsWithoutSecrets"] {
  return {
    provider: "gemini",
    model: "gemini-2.5-flash",
    baseUrl: "https://api.openai.com/v1",
    structuredOutput: true,
    thinkingLevel: "auto",
  };
}

function backupFixture(overrides: Partial<StudyBackup> = {}): StudyBackup {
  const session = sessionFixture("s1", 10);
  session.diagnostic = diagnosticFixture("d1");
  return {
    format: "zhixu-study-backup",
    version: 1,
    exportedAt: 1000,
    sessions: [session],
    notes: [noteFixture("n1")],
    reviews: [reviewFixture("r1")],
    diagnostics: [diagnosticFixture("d1")],
    settingsWithoutSecrets: safeSettingsFixture(),
    activity: ["2026-10-24", "2026-10-25"],
    ...overrides,
  };
}

function currentFixture(): {
  sessions: StudySession[];
  notes: Note[];
  reviews: ReviewItem[];
  diagnostics: DiagnosticProfile[];
} {
  const session = sessionFixture("local", 5);
  session.diagnostic = diagnosticFixture("local-d");
  const review = reviewFixture("local-r");
  review.sessionId = "local";
  return {
    sessions: [session],
    notes: [noteFixture("local-n")],
    reviews: [review],
    diagnostics: [diagnosticFixture("local-d")],
  };
}

test("导出再导入是完整往返：会话、笔记、复习、诊断、活动全部保留", () => {
  const current = currentFixture();
  const backup = createBackup({
    ...current,
    settingsWithoutSecrets: safeSettingsFixture(),
    activity: ["2026-10-25"],
    exportedAt: 1234,
  });
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.format, "zhixu-study-backup");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.exportedAt, 1234);
  assert.deepEqual(parsed.sessions, current.sessions);
  assert.deepEqual(parsed.notes, current.notes);
  assert.deepEqual(parsed.reviews, current.reviews);
  assert.deepEqual(parsed.diagnostics, current.diagnostics);
  assert.deepEqual(parsed.activity, ["2026-10-25"]);
  assert.deepEqual(parsed.settingsWithoutSecrets, safeSettingsFixture());
  assert.equal("apiKey" in parsed.settingsWithoutSecrets, false);
});

test("合并导入：新 ID 全部进入，无冲突时计数为零", () => {
  const merged = mergeBackup(currentFixture(), backupFixture());
  assert.deepEqual(
    new Set(merged.sessions.map((item) => item.id)),
    new Set(["local", "s1"]),
  );
  assert.deepEqual(new Set(merged.notes.map((item) => item.id)), new Set(["local-n", "n1"]));
  assert.deepEqual(new Set(merged.reviews.map((item) => item.id)), new Set(["local-r", "r1"]));
  assert.deepEqual(
    new Set(merged.diagnostics.map((item) => item.id)),
    new Set(["local-d", "d1"]),
  );
  assert.deepEqual(merged.imported, { sessions: 1, notes: 1, reviews: 1, diagnostics: 1 });
  assert.deepEqual(merged.conflicts, { sessions: 0, notes: 0, reviews: 0, diagnostics: 0 });
});

test("同 ID 会话合并：本地更新与备份双方消息都不丢", () => {
  const local = sessionFixture("s1", 100);
  local.messages = [
    { id: "m1", role: "user", content: "本地提问", timestamp: 1 },
    { id: "m2", role: "assistant", content: "本地回答", timestamp: 2 },
  ];
  local.completedStages = ["intro"];
  const backupSession = sessionFixture("s1", 50);
  backupSession.messages = [
    { id: "m1", role: "user", content: "本地提问", timestamp: 1 },
    { id: "m3", role: "user", content: "备份端提问", timestamp: 3 },
  ];
  const merged = mergeBackup(
    { sessions: [local], notes: [], reviews: [], diagnostics: [] },
    backupFixture({ sessions: [backupSession], notes: [], reviews: [], diagnostics: [] }),
  );
  assert.equal(merged.sessions.length, 1);
  assert.deepEqual(
    merged.sessions[0].messages.map((message) => message.id),
    ["m1", "m2", "m3"],
    "双方新增消息都应保留且按时间排序",
  );
  assert.deepEqual([...merged.sessions[0].completedStages], ["intro"]);
  assert.equal(merged.sessions[0].updatedAt, 100, "应保留较新的本地更新时间");
  assert.equal(merged.imported.sessions, 0);
  assert.equal(merged.conflicts.sessions, 1);
});

test("备份解析后合并：导入结果不与原始备份共享引用", () => {
  const backup = backupFixture();
  const parsed = parseBackup(JSON.stringify(backup));
  const merged = mergeBackup(
    { sessions: [], notes: [], reviews: [], diagnostics: [] },
    parsed,
  );
  assert.deepEqual(merged.sessions, backup.sessions);
  merged.sessions[0].title = "改过的标题";
  assert.equal(backup.sessions[0].title, "会话 s1");
  merged.reviews.push(reviewFixture("extra"));
  assert.equal(backup.reviews.length, 1);
});

test("未知格式或版本、坏 JSON、非对象拒绝导入", () => {
  const wrongFormat = JSON.stringify({ ...backupFixture(), format: "other-backup" });
  assert.throws(() => parseBackup(wrongFormat), /不支持的备份格式或版本/);
  const wrongVersion = JSON.stringify({ ...backupFixture(), version: 2 });
  assert.throws(() => parseBackup(wrongVersion), /不支持的备份格式或版本/);
  assert.throws(() => parseBackup("{broken"), /不是有效的 JSON/);
  assert.throws(() => parseBackup(JSON.stringify([backupFixture()])), /必须是 JSON 对象/);
});

test("缺少任一数据集合的损坏包拒绝导入", () => {
  for (const key of ["sessions", "notes", "reviews", "diagnostics", "activity"] as const) {
    const broken = backupFixture();
    delete (broken as unknown as Record<string, unknown>)[key];
    assert.throws(() => parseBackup(JSON.stringify(broken)), /备份缺少/);
  }
});

test("嵌套字段中的密钥字段触发拒绝，正文里出现“API key”字样不误伤", () => {
  // 学习状态里被夹带的密钥字段必须被拒绝（模拟恶意文件深度注入）。
  const injected = backupFixture();
  (injected.sessions[0] as unknown as Record<string, unknown>).extra = {
    authorization: "Bearer sk-secret",
  };
  assert.throws(() => parseBackup(JSON.stringify(injected)), /敏感字段/);

  const settingsInjection = backupFixture() as unknown as Record<string, unknown>;
  (settingsInjection.settingsWithoutSecrets as Record<string, unknown>).access_token = "t";
  assert.throws(() => parseBackup(JSON.stringify(settingsInjection)), /敏感字段/);

  // 用户消息内容里聊到 "API key" 是正常学习内容，不应被字段名扫描误杀。
  const mentioned = backupFixture();
  mentioned.sessions[0].messages.push({
    id: "m3",
    role: "user",
    content: "在哪里填 API key？我的 api_key 输入框在哪？",
    timestamp: 3,
  });
  const parsed = parseBackup(JSON.stringify(mentioned));
  assert.equal(parsed.sessions[0].messages.length, 3);
});

test("伪造掌握状态拒绝导入：understood/applied 没有推理或迁移证据", () => {
  const recognitionOnly = backupFixture();
  recognitionOnly.sessions[0].learningState = {
    ...stateWithEvidence(),
    steps: [
      {
        id: "step-1",
        title: "两种净值的区别",
        mastery: "understood",
        evidence: [
          { quote: "看到了这个词", questionId: "s1-q1", kind: "recognition", turn: 1 },
        ],
      },
    ],
  };
  assert.throws(() => parseBackup(JSON.stringify(recognitionOnly)), /理解状态必须有学习者解释的证据|迁移通过必须有不同问题上的解释和迁移证据/);

  const emptyEvidence = backupFixture();
  emptyEvidence.sessions[0].learningState = {
    ...stateWithEvidence(),
    steps: [
      { id: "step-1", title: "两种净值的区别", mastery: "applied", evidence: [] },
    ],
  };
  assert.throws(() => parseBackup(JSON.stringify(emptyEvidence)), /理解状态必须有学习者解释的证据|迁移通过必须有不同问题上的解释和迁移证据/);

  const fakeDetour = backupFixture();
  fakeDetour.sessions[0].learningState = {
    ...stateWithEvidence(),
    steps: [
      {
        id: "step-1",
        title: "两种净值的区别",
        mastery: "learning",
        evidence: [
          { quote: "引用", questionId: "s1-q1", kind: "reasoning", turn: 1 },
        ],
      },
    ],
    detours: [
      {
        topic: "分红机制",
        returnStepId: "step-1",
        returnQuestion: null,
        mastery: "understood",
        evidence: [],
      },
    ],
  };
  assert.throws(() => parseBackup(JSON.stringify(fakeDetour)), /理解状态必须有学习者解释的证据|迁移通过必须有不同问题上的解释和迁移证据/);
});

test("真实推理证据的掌握状态可以导入，识别证据不影响 learning 级别", () => {
  const ok = backupFixture();
  ok.sessions[0].learningState = stateWithEvidence();
  const parsed = parseBackup(JSON.stringify(ok));
  assert.equal(parsed.sessions[0].learningState?.steps[0].mastery, "understood");

  const learningOnly = backupFixture();
  learningOnly.sessions[0].learningState = {
    ...stateWithEvidence(),
    steps: [
      {
        id: "step-1",
        title: "两种净值的区别",
        mastery: "learning",
        evidence: [
          { quote: "看到了这个词", questionId: "s1-q1", kind: "recognition", turn: 1 },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => parseBackup(JSON.stringify(learningOnly)));
});

test("重复 ID 拒绝导入：会话、笔记、复习项、诊断各自查重", () => {
  const duplicateSessions = backupFixture({
    sessions: [sessionFixture("s1", 1), sessionFixture("s1", 2)],
  });
  assert.throws(() => parseBackup(JSON.stringify(duplicateSessions)), /会话 ID 重复/);

  const duplicateNotes = backupFixture({ notes: [noteFixture("n1"), noteFixture("n1")] });
  assert.throws(() => parseBackup(JSON.stringify(duplicateNotes)), /笔记 ID 重复/);

  const duplicateReviews = backupFixture({
    reviews: [reviewFixture("r1"), reviewFixture("r1")],
  });
  assert.throws(() => parseBackup(JSON.stringify(duplicateReviews)), /复习项 ID 重复/);

  const duplicateDiagnostics = backupFixture({
    diagnostics: [diagnosticFixture("d1"), diagnosticFixture("d1")],
  });
  assert.throws(() => parseBackup(JSON.stringify(duplicateDiagnostics)), /诊断记录 ID 重复/);
});

test("结构损坏的会话、复习项、诊断、活动、配置拒绝导入", () => {
  const noMessages = backupFixture();
  delete (noMessages.sessions[0] as unknown as Record<string, unknown>).messages;
  assert.throws(() => parseBackup(JSON.stringify(noMessages)), /会话消息列表无效/);

  const badReview = backupFixture({ reviews: [{ ...reviewFixture("r1"), dueAt: "明天" }] } as unknown as Partial<StudyBackup>);
  assert.throws(() => parseBackup(JSON.stringify(badReview)));

  const badDiagnostic = backupFixture({
    diagnostics: [{ ...diagnosticFixture("d1"), submitted: "yes" }],
  } as unknown as Partial<StudyBackup>);
  assert.throws(() => parseBackup(JSON.stringify(badDiagnostic)));

  const badActivity = backupFixture({ activity: ["2026/10/25"] });
  assert.throws(() => parseBackup(JSON.stringify(badActivity)), /活动记录日期无效/);

  const missingSettings = backupFixture();
  delete (missingSettings as unknown as Record<string, unknown>).settingsWithoutSecrets;
  assert.throws(() => parseBackup(JSON.stringify(missingSettings)), /非敏感配置/);

  const badProvider = backupFixture();
  (badProvider.settingsWithoutSecrets as { provider: string }).provider = "claude";
  assert.throws(() => parseBackup(JSON.stringify(badProvider)), /模型提供方无效/);
});

test("校验失败发生在合并之前：恶意包不会改变当前数据", () => {
  const current = currentFixture();
  const before = JSON.stringify(current);
  const malicious = backupFixture();
  (malicious.sessions[0] as unknown as Record<string, unknown>).apiKey = "sk";
  (malicious.settingsWithoutSecrets as unknown as Record<string, unknown>).searchApiKey = "search-secret";
  assert.throws(() => parseBackup(JSON.stringify(malicious)), /敏感字段/);
  assert.equal(JSON.stringify(current), before, "当前数据保持原样");
});

test("createBackup 即使传入完整 ProviderSettings 也不会带出 apiKey", () => {
  const backup = createBackup({
    ...currentFixture(),
    settingsWithoutSecrets: {
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      structuredOutput: false,
      thinkingLevel: "high",
      // 误传完整配置时，createBackup 逐字段重建，密钥不会进入备份。
      apiKey: "sk-live-secret",
      searchApiKey: "search-live-secret",
    } as StudyBackup["settingsWithoutSecrets"],
    activity: [],
  });
  const raw = JSON.stringify(backup);
  assert.equal(raw.includes("sk-live-secret"), false, "密钥不得出现在备份字符串里");
  assert.equal(raw.includes("search-live-secret"), false, "搜索密钥不得出现在备份字符串里");
  assert.equal("apiKey" in backup.settingsWithoutSecrets, false);
  const parsed = parseBackup(raw);
  assert.equal(parsed.settingsWithoutSecrets.structuredOutput, false);
  assert.equal(parsed.settingsWithoutSecrets.thinkingLevel, "high");
});

test("冲突计数与导入计数按集合准确统计", () => {
  const local = currentFixture();
  // 笔记/复习/诊断与备份同 ID：应计为冲突并保留本地内容。
  local.notes.push(noteFixture("n1"));
  local.notes[local.notes.length - 1].content = "本地较新内容";
  local.reviews.push(reviewFixture("r1"));
  local.diagnostics.push(diagnosticFixture("d1"));
  const merged = mergeBackup(local, backupFixture());
  assert.deepEqual(merged.imported, { sessions: 1, notes: 0, reviews: 0, diagnostics: 0 });
  assert.deepEqual(merged.conflicts, { sessions: 0, notes: 1, reviews: 1, diagnostics: 1 });
  const keptNote = merged.notes.find((note) => note.id === "n1");
  assert.equal(keptNote?.content, "本地较新内容", "冲突笔记必须保留本地内容");
  const keptReview = merged.reviews.find((item) => item.id === "r1");
  assert.equal(keptReview, local.reviews[local.reviews.length - 1], "冲突复习项保留本地引用");
  const keptDiagnostic = merged.diagnostics.find((profile) => profile.id === "d1");
  assert.equal(
    keptDiagnostic,
    local.diagnostics[local.diagnostics.length - 1],
    "冲突诊断保留本地引用",
  );
});

test("独立/书架笔记的空 sessionId 可以完整备份往返", () => {
  const note = { ...noteFixture("standalone"), sessionId: "" };
  const parsed = parseBackup(JSON.stringify(backupFixture({ notes: [note] })));
  assert.equal(parsed.notes[0].sessionId, "");
  const merged = mergeBackup(currentFixture(), parsed);
  assert.equal(
    merged.notes.find((item) => item.id === "standalone")?.sessionId,
    "",
  );
  assert.equal(parsed.notes[0].sessionId, "");
});

test("诊断记录深度校验：题目、作答题号与证据数组的坏数据在导入阶段拒绝", () => {
  const cases: Array<[string, (profile: DiagnosticProfile) => void]> = [
    ["题目缺少 ID", (profile) => { profile.questions[0].id = " "; }],
    ["题目缺少题干", (profile) => { profile.questions[0].question = " "; }],
    ["选项不足两个", (profile) => { profile.questions[0].options = ["唯一"]; profile.questions[0].correctIndex = 0; }],
    ["选项为空串", (profile) => { profile.questions[0].options = ["", "扣除"]; }],
    ["正确下标越界", (profile) => { profile.questions[0].correctIndex = 2; }],
    ["解析为空", (profile) => { profile.questions[0].explanation = " "; }],
    ["提示为空", (profile) => { profile.questions[0].hint = ""; }],
    ["题目 ID 重复", (profile) => { profile.questions.push({ ...profile.questions[0] }); }],
    ["作答指向未知题", (profile) => { profile.answers = { "not-a-question": 0 }; }],
    ["作答下标越界", (profile) => { profile.answers = { "d1-q1": 9 }; }],
    ["作答下标非整数", (profile) => { profile.answers = { "d1-q1": 0.5 }; }],
    ["evidenceSummary 非字符串数组", (profile) => {
      (profile as unknown as Record<string, unknown>).evidenceSummary = "证据";
    }],
    ["weakConcepts 含非字符串", (profile) => {
      profile.weakConcepts = ["累计净值", 3] as unknown as string[];
    }],
    ["skippedConcepts 含空串", (profile) => { profile.skippedConcepts = [""]; }],
  ];
  for (const [label, mutate] of cases) {
    const profile = diagnosticFixture("d1");
    mutate(profile);
    assert.throws(
      () => parseBackup(JSON.stringify(backupFixture({ diagnostics: [profile] }))),
      /诊断/,
      label,
    );
  }
});

test("会话测验题与 quizAnswers 下标越界拒绝导入", () => {
  const badQuestion = sessionFixture("s1", 1);
  badQuestion.quiz[0].correctIndex = 2;
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [badQuestion] }))),
    /测验题|下标/,
  );

  const emptyOptions = sessionFixture("s1", 1);
  emptyOptions.quiz[0].options = [];
  emptyOptions.quiz[0].correctIndex = 0;
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [emptyOptions] }))),
    /测验题|选项/,
  );

  const outOfRange = sessionFixture("s1", 1);
  outOfRange.quizAnswers = { "s1-q1": 2 };
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [outOfRange] }))),
    /下标越界/,
  );

  const fractional = sessionFixture("s1", 1);
  fractional.quizAnswers = { "s1-q1": 0.5 };
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [fractional] }))),
    /下标无效/,
  );

  const negative = sessionFixture("s1", 1);
  negative.quizAnswers = { "s1-q1": -1 };
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [negative] }))),
    /下标无效/,
  );
});

test("书籍上下文复用 parseBookContext 的真实约束", () => {
  const broken = sessionFixture("s1", 1);
  (broken as unknown as Record<string, unknown>).bookContext = { bookId: "book-1" };
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [broken] }))),
    /会话书籍上下文无效/,
  );

  const locationWithoutContext = sessionFixture("s1", 1);
  locationWithoutContext.references = [
    {
      name: "第一章",
      text: "单位净值是每份产品当前的价值。",
      location: {
        bookId: "book-1",
        chapterId: "ch-1",
        blockId: "blk-1",
        chapterTitle: "第一章 净值",
        locator: "第1段",
      },
    },
  ];
  assert.throws(
    () => parseBackup(JSON.stringify(backupFixture({ sessions: [locationWithoutContext] }))),
    /会话书籍上下文无效/,
  );

  const valid = sessionFixture("s1", 1);
  valid.bookContext = {
    bookId: "book-1",
    title: "理财产品入门",
    author: "",
    format: "txt",
    mode: "chapter",
    chapterId: "ch-1",
    chapterTitle: "第一章 净值",
    tableOfContents: ["第一章 净值"],
    totalChapters: 1,
    totalBlocks: 2,
    chapterBlocks: 1,
    suppliedBlockIds: ["blk-1"],
    completeChapter: false,
    completeBook: false,
  };
  valid.references = [
    {
      name: "第一章 净值",
      text: "单位净值是每份产品当前的价值。",
      location: {
        bookId: "book-1",
        chapterId: "ch-1",
        blockId: "blk-1",
        chapterTitle: "第一章 净值",
        locator: "第1段",
      },
    },
  ];
  const parsed = parseBackup(
    JSON.stringify(backupFixture({ sessions: [valid], diagnostics: [] })),
  );
  assert.equal(parsed.sessions[0].bookContext?.bookId, "book-1");
  assert.equal(parsed.sessions[0].references[0].location?.blockId, "blk-1");

  // 真实书籍会话持久化时正文被清空，只保留定位；不能因此误杀合法备份。
  const stripped = sessionFixture("s1", 1);
  stripped.bookContext = valid.bookContext;
  stripped.references = valid.references.map((reference) => ({ ...reference, text: "" }));
  assert.doesNotThrow(() =>
    parseBackup(
      JSON.stringify(backupFixture({ sessions: [stripped], diagnostics: [] })),
    ),
  );
});

test("备份解析保留活动记录，且嵌套对象不与原始备份共享引用", () => {
  const backup = backupFixture();
  backup.sessions[0].learningState = stateWithEvidence();
  const parsed = parseBackup(JSON.stringify(backup));
  assert.deepEqual(parsed.activity, backup.activity);
  assert.notEqual(parsed.activity, backup.activity);

  assert.notEqual(parsed.sessions[0], backup.sessions[0]);
  assert.notEqual(
    parsed.sessions[0].learningState,
    backup.sessions[0].learningState,
  );
  parsed.sessions[0].learningState!.steps[0].title = "改过的步骤";
  assert.equal(
    backup.sessions[0].learningState?.steps[0].title,
    "两种净值的区别",
  );

  assert.notEqual(
    parsed.diagnostics[0].questions[0],
    backup.diagnostics[0].questions[0],
  );
  parsed.diagnostics[0].questions[0].options[0] = "改过的选项";
  assert.equal(backup.diagnostics[0].questions[0].options[0], "不扣除");

  assert.notEqual(parsed.notes[0], backup.notes[0]);
  parsed.notes[0].content = "改过的笔记";
  assert.equal(backup.notes[0].content, noteFixture("n1").content);

  parsed.activity!.push("2026-10-26");
  assert.deepEqual(backup.activity, ["2026-10-24", "2026-10-25"]);
});

test("顶层诊断与复习项必须能回溯到所属会话", () => {
  const orphanDiagnostic = backupFixture({
    sessions: [sessionFixture("s1", 1)],
    diagnostics: [diagnosticFixture("d1")],
  });
  assert.throws(
    () => parseBackup(JSON.stringify(orphanDiagnostic)),
    /诊断 d1 缺少所属会话/,
  );

  const orphanReview = backupFixture({
    reviews: [{ ...reviewFixture("r1"), sessionId: "missing-session" }],
  });
  assert.throws(
    () => parseBackup(JSON.stringify(orphanReview)),
    /复习项 r1 缺少所属会话/,
  );
});

test("删除笔记后以旧云端备份合并不会复活", () => {
  const current = currentFixture();
  // 本机已删除 n1：墓碑存在，列表里没有该笔记。
  const merged = mergeBackup(
    { ...current, deletedNoteIds: ["n1"] },
    backupFixture({ notes: [noteFixture("n1"), noteFixture("n2")] }),
  );
  assert.deepEqual(
    merged.notes.map((note) => note.id).sort(),
    ["local-n", "n2"],
    "旧备份里的已删笔记必须被墓碑过滤，未删除的新笔记仍要导入",
  );
  assert.deepEqual(merged.deletedNoteIds, ["n1"]);
  assert.equal(merged.imported.notes, 1, "被墓碑拦下的笔记不计入导入");
  assert.equal(merged.conflicts.notes, 0);
});

test("双方墓碑取并集，并过滤双方各自的笔记", () => {
  const merged = mergeBackup(
    {
      ...currentFixture(),
      notes: [noteFixture("local-n"), noteFixture("tombstoned-local")],
      deletedNoteIds: ["tombstoned-local", "shared"],
    },
    backupFixture({
      notes: [noteFixture("backup-n"), noteFixture("tombstoned-cloud")],
      deletedNoteIds: ["tombstoned-cloud", "shared"],
    }),
  );
  assert.deepEqual(merged.deletedNoteIds, [
    "shared",
    "tombstoned-cloud",
    "tombstoned-local",
  ]);
  assert.deepEqual(
    merged.notes.map((note) => note.id).sort(),
    ["backup-n", "local-n"],
    "任一端墓碑都能阻止笔记复活",
  );
  assert.deepEqual(parseBackup(JSON.stringify(backupFixture({
    deletedNoteIds: merged.deletedNoteIds,
  }))).deletedNoteIds, merged.deletedNoteIds);
});

test("坏墓碑拒绝导入：类型、长度、重复与数量都严格校验", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["非数组", "n1", /已删除笔记列表无效/],
    ["非字符串项", [1], /已删除笔记 ID 无效/],
    ["空串", [""], /已删除笔记 ID 无效/],
    ["纯空白", ["   "], /已删除笔记 ID 无效/],
    ["首尾空白", [" n1 "], /已删除笔记 ID 无效/],
    ["重复 ID", ["n1", "n1"], /已删除笔记 ID 重复/],
    ["超长 ID", ["x".repeat(201)], /已删除笔记 ID 过长/],
    [
      "数量超限",
      Array.from({ length: MAX_DELETED_NOTE_IDS + 1 }, (_, index) => `n-${index}`),
      /已删除笔记数量过多/,
    ],
  ];
  for (const [label, value, pattern] of cases) {
    const broken = backupFixture() as unknown as Record<string, unknown>;
    broken.deletedNoteIds = value;
    assert.throws(() => parseBackup(JSON.stringify(broken)), pattern, label);
  }
  // 合法空数组与合法 ID 不受影响。
  assert.deepEqual(
    parseBackup(JSON.stringify(backupFixture({ deletedNoteIds: [] }))).deletedNoteIds,
    [],
  );
  assert.deepEqual(
    parseBackup(JSON.stringify(backupFixture({ deletedNoteIds: ["n1"] }))).deletedNoteIds,
    ["n1"],
  );
});

test("坏设置版本拒绝导入，缺失或 0 按旧备份处理", () => {
  for (const value of ["soon", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const broken = backupFixture() as unknown as Record<string, unknown>;
    broken.settingsUpdatedAt = value;
    assert.throws(() => parseBackup(JSON.stringify(broken)), /设置版本时间无效/);
  }
  const legacy = backupFixture();
  assert.equal("settingsUpdatedAt" in legacy, false);
  assert.doesNotThrow(() => parseBackup(JSON.stringify(legacy)));
  assert.equal(
    parseBackup(JSON.stringify(backupFixture({ settingsUpdatedAt: 0 }))).settingsUpdatedAt,
    0,
  );
});

test("设置版本：较新覆盖较旧，较旧与无版本都不抢新值", () => {
  const localSettings = { ...safeSettingsFixture(), model: "local-model" };
  const cloudSettings = { ...safeSettingsFixture(), model: "cloud-model" };
  const current = {
    ...currentFixture(),
    settingsWithoutSecrets: localSettings,
    settingsUpdatedAt: 200,
  };

  const newer = mergeBackup(
    current,
    backupFixture({ settingsWithoutSecrets: cloudSettings, settingsUpdatedAt: 300 }),
  );
  assert.deepEqual(newer.settingsWithoutSecrets, cloudSettings);
  assert.equal(newer.settingsUpdatedAt, 300);

  const older = mergeBackup(
    current,
    backupFixture({ settingsWithoutSecrets: cloudSettings, settingsUpdatedAt: 100 }),
  );
  assert.deepEqual(older.settingsWithoutSecrets, localSettings);
  assert.equal(older.settingsUpdatedAt, 200);

  // 无版本旧备份按 0 处理，不能覆盖本地较新的设置。
  const legacyBackup = backupFixture({ settingsWithoutSecrets: cloudSettings });
  assert.equal("settingsUpdatedAt" in legacyBackup, false);
  const legacy = mergeBackup(current, legacyBackup);
  assert.deepEqual(legacy.settingsWithoutSecrets, localSettings);
  assert.equal(legacy.settingsUpdatedAt, 200);

  // 反向：本地无版本、云端带版本时，云端可以成为新的设置来源。
  const cloudVersioned = mergeBackup(
    { ...current, settingsUpdatedAt: undefined },
    backupFixture({ settingsWithoutSecrets: cloudSettings, settingsUpdatedAt: 50 }),
  );
  assert.deepEqual(cloudVersioned.settingsWithoutSecrets, cloudSettings);
  assert.equal(cloudVersioned.settingsUpdatedAt, 50);
});

test("备份往返保留墓碑与设置版本，createBackup 归一化输入", () => {
  const backup = createBackup({
    ...currentFixture(),
    settingsWithoutSecrets: safeSettingsFixture(),
    activity: ["2026-10-25"],
    deletedNoteIds: ["note-b", "note-a", "note-a", "   "],
    settingsUpdatedAt: 777,
  });
  assert.deepEqual(backup.deletedNoteIds, ["note-a", "note-b"]);
  assert.equal(backup.settingsUpdatedAt, 777);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.deepEqual(parsed.deletedNoteIds, ["note-a", "note-b"]);
  assert.equal(parsed.settingsUpdatedAt, 777);
  assert.deepEqual(parsed, backup);

  // 即使调用方状态不干净，墓碑与同 ID 笔记也不能一起导出。
  const dirty = createBackup({
    ...currentFixture(),
    notes: [noteFixture("deleted-in-backup")],
    settingsWithoutSecrets: safeSettingsFixture(),
    activity: [],
    deletedNoteIds: ["deleted-in-backup"],
  });
  assert.deepEqual(dirty.notes, []);
  assert.deepEqual(parseBackup(JSON.stringify(dirty)).notes, []);

  // 未提供时明确输出 0 / 空数组，仍能被同一个解析器接受。
  const bare = createBackup({
    ...currentFixture(),
    settingsWithoutSecrets: safeSettingsFixture(),
    activity: [],
  });
  assert.deepEqual(bare.deletedNoteIds, []);
  assert.equal(bare.settingsUpdatedAt, 0);
  assert.doesNotThrow(() => parseBackup(JSON.stringify(bare)));
});

test("合并导入同样保留墓碑并过滤已删笔记", () => {
  const merged = mergeBackup(
    { sessions: [], notes: [], reviews: [], diagnostics: [] },
    backupFixture({
      notes: [noteFixture("n1"), noteFixture("n2")],
      deletedNoteIds: ["n1"],
      settingsUpdatedAt: 42,
    }),
  );
  assert.deepEqual(merged.notes.map((note) => note.id), ["n2"]);
  assert.deepEqual(merged.deletedNoteIds, ["n1"]);
  assert.equal(merged.settingsUpdatedAt, 42);
});

/* ── 跨设备同 ID 版本判定 ────────────────────────────────────── */

const EMPTY_COLLECTIONS = { sessions: [], notes: [], reviews: [], diagnostics: [] };

test("同 ID 笔记：只有严格更新的 updatedAt 才覆盖当前内容", () => {
  const newer = {
    ...noteFixture("n1"),
    content: "A 设备更新后的内容",
    updatedAt: 200,
  };
  const older = {
    ...noteFixture("n1"),
    content: "B 设备旧副本",
    updatedAt: 100,
  };

  // A 更新、B/云端仍是旧副本：旧副本不能覆盖 A 的新内容。
  const kept = mergeBackup(
    { ...EMPTY_COLLECTIONS, notes: [newer] },
    backupFixture({ ...EMPTY_COLLECTIONS, notes: [older] }),
  );
  assert.equal(kept.notes[0].content, "A 设备更新后的内容");
  assert.equal(kept.conflicts.notes, 1);
  assert.equal(kept.imported.notes, 0);

  // 反向：B 本地是旧副本，备份/A 的较新内容应当覆盖。
  const updated = mergeBackup(
    { ...EMPTY_COLLECTIONS, notes: [older] },
    backupFixture({ ...EMPTY_COLLECTIONS, notes: [newer] }),
  );
  assert.equal(updated.notes[0].content, "A 设备更新后的内容");
  assert.equal(updated.conflicts.notes, 1);

  // 时间戳相同无法证明更新：保留当前内容。
  const tied = mergeBackup(
    { ...EMPTY_COLLECTIONS, notes: [{ ...newer, content: "当前" }] },
    backupFixture({
      ...EMPTY_COLLECTIONS,
      notes: [{ ...newer, content: "同时间戳的备份" }],
    }),
  );
  assert.equal(tied.notes[0].content, "当前");
});

test("旧备份没有 updatedAt 时，同 ID 笔记不得覆盖当前内容", () => {
  const legacyBackupNote = { ...noteFixture("n1"), content: "没有版本的旧备份" };
  assert.equal(legacyBackupNote.updatedAt, undefined);

  const kept = mergeBackup(
    {
      ...EMPTY_COLLECTIONS,
      notes: [{ ...noteFixture("n1"), content: "本地当前内容", updatedAt: 300 }],
    },
    backupFixture({ ...EMPTY_COLLECTIONS, notes: [legacyBackupNote] }),
  );
  assert.equal(kept.notes[0].content, "本地当前内容");

  // 当前没有版本、备份有可靠版本：备份是唯一能证明较新的一方，可以覆盖。
  const upgraded = mergeBackup(
    {
      ...EMPTY_COLLECTIONS,
      notes: [{ ...noteFixture("n1"), content: "旧本地" }],
    },
    backupFixture({
      ...EMPTY_COLLECTIONS,
      notes: [{ ...noteFixture("n1"), content: "新版备份", updatedAt: 50 }],
    }),
  );
  assert.equal(upgraded.notes[0].content, "新版备份");
});

test("同 ID 复习项：显式 updatedAt / attempts / dueAt 均可拒绝旧副本", () => {
  const currentItem = {
    ...reviewFixture("r1"),
    attempts: 3,
    lastOutcome: "known" as const,
    dueAt: 900,
    updatedAt: 500,
  };
  const olderItem = {
    ...reviewFixture("r1"),
    attempts: 1,
    lastOutcome: "again" as const,
    dueAt: 200,
    updatedAt: 100,
  };

  const kept = mergeBackup(
    { ...EMPTY_COLLECTIONS, reviews: [currentItem] },
    backupFixture({ ...EMPTY_COLLECTIONS, reviews: [olderItem] }),
  );
  assert.equal(kept.reviews[0], currentItem, "旧副本不能覆盖较新的复习进度");
  assert.equal(kept.conflicts.reviews, 1);

  const updated = mergeBackup(
    { ...EMPTY_COLLECTIONS, reviews: [olderItem] },
    backupFixture({ ...EMPTY_COLLECTIONS, reviews: [currentItem] }),
  );
  assert.equal(updated.reviews[0], currentItem, "较新备份应覆盖旧复习进度");

  // 旧数据兼容：attempts 更高的快照更新，即使 dueAt 更早（again 会立即到期）。
  const legacyCurrent = {
    ...reviewFixture("r1"),
    attempts: 2,
    dueAt: 300,
    lastOutcome: "known" as const,
  };
  const legacyOlderWithLaterDue = {
    ...reviewFixture("r1"),
    attempts: 1,
    dueAt: 9_999,
    lastOutcome: "known" as const,
  };
  const legacyKept = mergeBackup(
    { ...EMPTY_COLLECTIONS, reviews: [legacyCurrent] },
    backupFixture({ ...EMPTY_COLLECTIONS, reviews: [legacyOlderWithLaterDue] }),
  );
  assert.equal(legacyKept.reviews[0].attempts, 2, "attempts 优先于 dueAt");
  assert.equal(legacyKept.reviews[0].dueAt, 300);

  // attempts 相同再比 dueAt：较晚到期的一侧视为更新的评分结果。
  const sameAttemptsNewer = {
    ...reviewFixture("r1"),
    attempts: 2,
    dueAt: 400,
    lastOutcome: "known" as const,
  };
  const byDueAt = mergeBackup(
    { ...EMPTY_COLLECTIONS, reviews: [legacyCurrent] },
    backupFixture({ ...EMPTY_COLLECTIONS, reviews: [sameAttemptsNewer] }),
  );
  assert.equal(byDueAt.reviews[0].dueAt, 400);

  // attempts/dueAt 相同：已评分项优先于初始项，其余平局保留当前项。
  const initial = {
    ...reviewFixture("r1"),
    attempts: 0,
    dueAt: 100,
    lastOutcome: undefined,
  };
  const rated = {
    ...reviewFixture("r1"),
    attempts: 0,
    dueAt: 100,
    lastOutcome: "again" as const,
  };
  const byOutcome = mergeBackup(
    { ...EMPTY_COLLECTIONS, reviews: [initial] },
    backupFixture({ ...EMPTY_COLLECTIONS, reviews: [rated] }),
  );
  assert.equal(byOutcome.reviews[0].lastOutcome, "again");

  // 显式 updatedAt 是权威版本：不能被 attempts 更高的旧格式数据覆盖。
  const explicitCurrent = {
    ...reviewFixture("r1"),
    attempts: 1,
    dueAt: 200,
    updatedAt: 900,
  };
  const legacyManyAttempts = {
    ...reviewFixture("r1"),
    attempts: 9,
    dueAt: 9_999,
  };
  const guarded = mergeBackup(
    { ...EMPTY_COLLECTIONS, reviews: [explicitCurrent] },
    backupFixture({ ...EMPTY_COLLECTIONS, reviews: [legacyManyAttempts] }),
  );
  assert.equal(guarded.reviews[0], explicitCurrent);
});

test("同 ID 诊断：submitted 与 evaluatedAt 决定是否覆盖", () => {
  const currentProfile = { ...diagnosticFixture("d1"), evaluatedAt: 500 };
  const olderProfile = {
    ...diagnosticFixture("d1"),
    evaluatedAt: 400,
    evidenceSummary: ["旧评价"],
  };
  const newerProfile = {
    ...diagnosticFixture("d1"),
    evaluatedAt: 800,
    evidenceSummary: ["新评价"],
  };

  const kept = mergeBackup(
    { ...EMPTY_COLLECTIONS, diagnostics: [currentProfile] },
    backupFixture({ ...EMPTY_COLLECTIONS, diagnostics: [olderProfile] }),
  );
  assert.equal(kept.diagnostics[0], currentProfile, "较旧评价不能覆盖当前诊断");

  const updated = mergeBackup(
    { ...EMPTY_COLLECTIONS, diagnostics: [olderProfile] },
    backupFixture({ ...EMPTY_COLLECTIONS, diagnostics: [newerProfile] }),
  );
  assert.equal(updated.diagnostics[0], newerProfile, "较新评价应覆盖旧诊断");

  // 已提交永远优于未提交；未提交不能抹掉已评价结果。
  const unsubmitted = {
    ...diagnosticFixture("d1"),
    submitted: false,
    evaluatedAt: undefined,
    evidenceSummary: [],
    weakConcepts: [],
    skippedConcepts: [],
    answers: {},
  };
  const submittedWins = mergeBackup(
    { ...EMPTY_COLLECTIONS, diagnostics: [unsubmitted] },
    backupFixture({ ...EMPTY_COLLECTIONS, diagnostics: [currentProfile] }),
  );
  assert.equal(submittedWins.diagnostics[0], currentProfile);

  const unsubmittedLoses = mergeBackup(
    { ...EMPTY_COLLECTIONS, diagnostics: [currentProfile] },
    backupFixture({ ...EMPTY_COLLECTIONS, diagnostics: [unsubmitted] }),
  );
  assert.equal(unsubmittedLoses.diagnostics[0], currentProfile);

  // 双方都已提交但旧备份没有 evaluatedAt：无法证明更新，保留当前。
  const noTimestamp = { ...diagnosticFixture("d1"), evaluatedAt: undefined };
  const legacyKept = mergeBackup(
    { ...EMPTY_COLLECTIONS, diagnostics: [currentProfile] },
    backupFixture({ ...EMPTY_COLLECTIONS, diagnostics: [noTimestamp] }),
  );
  assert.equal(legacyKept.diagnostics[0], currentProfile);
});

test("同浏览器 storage 合并：墓碑过滤已删笔记，显式版本阻止旧快照写回", () => {
  const currentNotes: Note[] = [
    { ...noteFixture("n1"), content: "新内容", updatedAt: 200 },
    noteFixture("n2"),
  ];
  const incomingNotes: Note[] = [
    { ...noteFixture("n1"), content: "旧内容", updatedAt: 100 },
    noteFixture("n3"),
    noteFixture("deleted-old"),
  ];
  const merged = mergeNotes(currentNotes, incomingNotes, ["deleted-old"]);
  assert.deepEqual(merged.map((note) => note.id), ["n1", "n2", "n3"]);
  assert.equal(merged[0].content, "新内容", "较旧标签页快照不能写回旧内容");
  assert.equal(
    merged.some((note) => note.id === "deleted-old"),
    false,
    "墓碑阻止旧标签页复活已删笔记",
  );

  // 旧数据没有 updatedAt 时保留既有“最近写入获胜”语义。
  const legacy = mergeNotes(
    [noteFixture("n9")],
    [{ ...noteFixture("n9"), content: "刚保存的内容" }],
    [],
  );
  assert.equal(legacy[0].content, "刚保存的内容");

  // 当前已有版本、incoming 是无版本旧快照：旧快照不得覆盖。
  const guarded = mergeNotes(
    [{ ...noteFixture("n10"), content: "当前版本", updatedAt: 500 }],
    [{ ...noteFixture("n10"), content: "无版本旧快照" }],
    [],
  );
  assert.equal(guarded[0].content, "当前版本");
});

test("非法 updatedAt 拒绝导入，旧数据缺字段仍可导入", () => {
  for (const value of ["now", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const badNote = { ...noteFixture("n1"), updatedAt: value } as unknown as Note;
    assert.throws(
      () => parseBackup(JSON.stringify(backupFixture({ notes: [badNote] }))),
      /笔记更新时间无效/,
    );
    const badReview = {
      ...reviewFixture("r1"),
      updatedAt: value,
    } as unknown as ReviewItem;
    assert.throws(
      () => parseBackup(JSON.stringify(backupFixture({ reviews: [badReview] }))),
      /复习项更新时间无效/,
    );
  }

  // 旧备份（无 updatedAt）仍能通过完整校验。
  assert.doesNotThrow(() =>
    parseBackup(JSON.stringify(backupFixture({ notes: [noteFixture("legacy")] }))),
  );

  // 合法版本字段在往返中保留，不会被校验器丢弃。
  const versioned = backupFixture();
  versioned.notes[0].updatedAt = 123;
  versioned.reviews[0].updatedAt = 456;
  const parsed = parseBackup(JSON.stringify(versioned));
  assert.equal(parsed.notes[0].updatedAt, 123);
  assert.equal(parsed.reviews[0].updatedAt, 456);
});

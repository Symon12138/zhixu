import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewItem, StudySession } from "../src/types";
import {
  DAY_MS,
  REVIEW_INTERVAL_DAYS,
  createReviewItem,
  isReviewDue,
  isReviewItem,
  misconceptionToReviewItem,
  rateReviewItem,
  sessionReviewItems,
} from "../src/lib/review";

const NOW = 1_700_000_000_000;

function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

function opts(now = NOW) {
  return { now, newId: ids() };
}

function quizItem(): ReviewItem {
  return createReviewItem(
    {
      sessionId: "s1",
      topic: "二次函数",
      questionId: "q1",
      prompt: "抛物线 y=x^2 的开口方向？",
      kind: "quiz",
      reason: "测验答错：选择了「向下」",
      hint: "看二次项系数的正负",
      learnerQuote: "向下",
      correctExplanation: "二次项系数 1 > 0，开口向上。",
      source: "quiz",
    },
    opts(),
  );
}

function session(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "s1",
    title: "二次函数入门",
    topic: "二次函数",
    level: "从零开始",
    goal: "理解二次函数图像",
    messages: [],
    stageIndex: 0,
    completedStages: [],
    stageAnswers: {},
    plan: [],
    quiz: [
      {
        id: "q1",
        question: "y=x^2 的开口方向？",
        options: ["向上", "向下"],
        correctIndex: 0,
        explanation: "二次项系数 1 > 0，开口向上。",
        hint: "看二次项系数的正负",
      },
      {
        id: "q2",
        question: "y=-x^2 的开口方向？",
        options: ["向上", "向下"],
        correctIndex: 1,
        explanation: "二次项系数 -1 < 0，开口向下。",
        hint: "看二次项系数的正负",
      },
    ],
    flashcards: [],
    quizAnswers: { q1: 1, q2: 1 },
    quizSubmitted: true,
    reviewedCards: [],
    references: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("创建复习项保存题干、原因、提示、原话与解析，初始状态待复习", () => {
  const item = quizItem();
  assert.equal(item.id, "id-1");
  assert.equal(item.sessionId, "s1");
  assert.equal(item.topic, "二次函数");
  assert.equal(item.prompt, "抛物线 y=x^2 的开口方向？");
  assert.equal(item.reason, "测验答错：选择了「向下」");
  assert.equal(item.hint, "看二次项系数的正负");
  assert.equal(item.learnerQuote, "向下");
  assert.equal(
    item.correctExplanation,
    "二次项系数 1 > 0，开口向上。",
  );
  assert.equal(item.createdAt, NOW);
  assert.equal(item.dueAt, NOW);
  assert.equal(item.intervalDays, 0);
  assert.equal(item.streak, 0);
  assert.equal(item.attempts, 0);
  assert.equal(item.lastOutcome, undefined);
});

test("创建复习项拒绝空必填字段与无效 kind/source", () => {
  const base = {
    sessionId: "s1",
    topic: "二次函数",
    prompt: "题干",
    kind: "quiz" as const,
    reason: "答错",
    correctExplanation: "解析",
    source: "quiz" as const,
  };
  assert.throws(() => createReviewItem({ ...base, sessionId: "  " }, opts()), /sessionId/);
  assert.throws(() => createReviewItem({ ...base, prompt: "" }, opts()), /prompt/);
  assert.throws(
    () => createReviewItem({ ...base, correctExplanation: "" }, opts()),
    /correctExplanation/,
  );
  assert.throws(
    () => createReviewItem({ ...base, kind: "bogus" as never }, opts()),
    /kind/,
  );
  assert.throws(
    () => createReviewItem({ ...base, source: "bogus" as never }, opts()),
    /source/,
  );
  assert.throws(
    () => createReviewItem(base, { now: Number.NaN, newId: ids() }),
    /now/,
  );
  assert.throws(
    () => createReviewItem(base, { now: NOW, newId: undefined as never }),
    /newId/,
  );
});

test("again 评分立即重学：dueAt 等于当前时刻，streak 与区间清零", () => {
  const item = rateReviewItem(quizItem(), "known", NOW);
  assert.equal(item.intervalDays, 1);
  const again = rateReviewItem(item, "again", NOW + DAY_MS);
  assert.equal(again.dueAt, NOW + DAY_MS);
  assert.equal(again.intervalDays, 0);
  assert.equal(again.streak, 0);
  assert.equal(again.lastOutcome, "again");
  assert.equal(again.attempts, 2);
  // 原对象不被修改
  assert.equal(item.streak, 1);
});

test("fuzzy 评分安排短间隔（1 天）重学，streak 不推进", () => {
  const item = rateReviewItem(quizItem(), "known", NOW);
  const fuzzy = rateReviewItem(item, "fuzzy", NOW + DAY_MS);
  assert.equal(fuzzy.dueAt, NOW + 2 * DAY_MS);
  assert.equal(fuzzy.intervalDays, 1);
  assert.equal(fuzzy.streak, 1);
  assert.equal(fuzzy.lastOutcome, "fuzzy");
  assert.equal(fuzzy.attempts, 2);
});

test("known 评分按 1/3/7/14 天递增并封顶", () => {
  assert.deepEqual([...REVIEW_INTERVAL_DAYS], [1, 3, 7, 14]);
  let item = quizItem();
  const dueTimes: number[] = [];
  let now = NOW;
  for (let i = 0; i < 6; i++) {
    item = rateReviewItem(item, "known", now);
    dueTimes.push(item.dueAt - now);
    now = item.dueAt;
  }
  assert.deepEqual(dueTimes.map((ms) => ms / DAY_MS), [1, 3, 7, 14, 14, 14]);
  assert.equal(item.streak, 6);
  assert.equal(item.intervalDays, 14);
  assert.equal(item.attempts, 6);
});

test("isReviewDue 到期判断使用注入时刻", () => {
  const item = rateReviewItem(quizItem(), "known", NOW);
  assert.equal(isReviewDue(item, NOW + DAY_MS - 1), false);
  assert.equal(isReviewDue(item, NOW + DAY_MS), true);
});

test("误区转换保留原话与既有讲解，缺讲解时拒绝", () => {
  const review = misconceptionToReviewItem(
    {
      id: "m1",
      stepId: "step-1",
      questionId: "q9",
      question: "以为开口由常数项决定",
      scope: "main",
      topic: "二次函数",
      description: "认为 y=x^2+c 的开口随 c 变化",
      evidenceQuote: "c 越大开口越大",
      status: "open",
    },
    "开口方向只由二次项系数决定，c 只影响上下平移。",
    opts(),
    "s1",
  );
  assert.equal(review.kind, "misconception");
  assert.equal(review.source, "misconception");
  assert.equal(review.sessionId, "s1");
  assert.equal(review.prompt, "以为开口由常数项决定");
  assert.equal(review.reason, "误区未修复：认为 y=x^2+c 的开口随 c 变化");
  assert.equal(review.learnerQuote, "c 越大开口越大");
  assert.equal(
    review.correctExplanation,
    "开口方向只由二次项系数决定，c 只影响上下平移。",
  );
  assert.equal(review.questionId, "q9");

  // 缺少讲解：拒绝（不能编造 AI 回答）
  assert.throws(
    () =>
      misconceptionToReviewItem(
        {
          id: "m2",
          stepId: "step-1",
          questionId: "q9",
          scope: "main",
          topic: "二次函数",
          description: "认为开口随 c 变化",
          evidenceQuote: "c 越大开口越大",
          status: "open",
        },
        "  ",
        opts(),
        "s1",
      ),
    /correctExplanation/,
  );
  // question 缺失时回退到描述，evidenceQuote 为空串时不设原话
  const fallback = misconceptionToReviewItem(
    {
      id: "m3",
      stepId: "step-1",
      questionId: "q9",
      scope: "main",
      topic: "二次函数",
      description: "认为开口随 c 变化",
      evidenceQuote: "",
      status: "open",
    },
    "开口方向只由二次项系数决定。",
    opts(),
    "s1",
  );
  assert.equal(fallback.prompt, "认为开口随 c 变化");
  assert.equal(fallback.learnerQuote, undefined);
});

test("会话复习项只为真实答错的题生成，保留选项原话与原解析", () => {
  const items = sessionReviewItems(session(), opts());
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.questionId, "q1");
  assert.equal(item.kind, "quiz");
  assert.equal(item.source, "quiz");
  assert.equal(item.prompt, "y=x^2 的开口方向？");
  assert.equal(item.learnerQuote, "向下");
  assert.equal(item.reason, "测验答错：选择了「向下」");
  assert.equal(item.hint, "看二次项系数的正负");
  assert.equal(item.correctExplanation, "二次项系数 1 > 0，开口向上。");
  // 答对的 q2 不生成
  assert.ok(!items.some((i) => i.questionId === "q2"));
});

test("会话复习项不重复生成，未作答的题跳过", () => {
  const first = sessionReviewItems(session(), opts());
  const second = sessionReviewItems(session(), opts(), first);
  assert.equal(second.length, 0);

  const partial = sessionReviewItems(
    session({ quizAnswers: { q2: 1 } }),
    opts(),
  );
  assert.deepEqual(partial, []);
});

test("会话复习项拒绝损坏的题目与越界作答", () => {
  const broken = session({
    quiz: [{ ...session().quiz[0], options: [] }],
  });
  assert.throws(() => sessionReviewItems(broken, opts()), /选项/);

  const badIndex = session({ quizAnswers: { q1: 5 } });
  assert.throws(() => sessionReviewItems(badIndex, opts()), /越界/);

  const noExplanation = session({
    quiz: [{ ...session().quiz[0], explanation: " " }],
  });
  assert.throws(() => sessionReviewItems(noExplanation, opts()), /解析/);
});

test("isReviewItem 校验备份还原的复习项结构", () => {
  const item = quizItem();
  assert.equal(isReviewItem(item), true);
  assert.equal(isReviewItem({ ...item, prompt: "" }), false);
  assert.equal(isReviewItem({ ...item, source: "bogus" }), false);
  assert.equal(isReviewItem({ ...item, lastOutcome: "maybe" }), false);
  assert.equal(isReviewItem({ ...item, attempts: -1 }), false);
  assert.equal(isReviewItem(null), false);
  assert.equal(isReviewItem([]), false);
});

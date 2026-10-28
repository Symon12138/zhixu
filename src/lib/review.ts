import type {
  LearningMisconception,
  ReviewItem,
  ReviewRating,
  StudySession,
} from "../types";

/**
 * 复习调度（间隔复习 / 错题本）核心逻辑。
 *
 * 调度规则（与契约一致）：
 * - again（忘了）：立即重学，dueAt = now，连续次数清零。
 * - fuzzy（模糊）：短间隔 1 天后重学，连续次数不变。
 * - known（会了）：按 1 / 3 / 7 / 14 天递增，封顶 14 天。
 *
 * 所有时间均由调用方注入（now），ID 由调用方注入（newId），保证测试确定性。
 * 复习项的 correctExplanation 必须来自已有的讲解/解析，这里绝不编造内容。
 */

export const REVIEW_INTERVAL_DAYS: readonly number[] = [1, 3, 7, 14];
export const DAY_MS = 24 * 60 * 60 * 1000;
export const FUZZY_INTERVAL_DAYS = 1;

const REVIEW_KINDS = ["quiz", "misconception", "concept"] as const;
const REVIEW_SOURCES = ["quiz", "misconception", "concept", "diagnostic"] as const;
const REVIEW_RATINGS = ["again", "fuzzy", "known"] as const;

export interface ReviewIdOptions {
  /** 注入的当前时间（毫秒时间戳）。 */
  now: number;
  /** 注入的 ID 生成器，保证测试可复现。 */
  newId: () => string;
}

export interface CreateReviewItemInput {
  sessionId: string;
  topic: string;
  questionId?: string;
  prompt: string;
  kind: ReviewItem["kind"];
  reason: string;
  hint?: string;
  learnerQuote?: string;
  correctExplanation: string;
  source: ReviewItem["source"];
}

function requireNow(now: unknown, context: string): number {
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
    throw new Error(`${context} 需要有效的注入时间 now（非负毫秒时间戳）`);
  }
  return now;
}

function requireIdFactory(newId: unknown, context: string): () => string {
  if (typeof newId !== "function") {
    throw new Error(`${context} 需要注入 newId 生成函数`);
  }
  return newId as () => string;
}

function requireText(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context}：字段 ${field} 不能为空`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 校验任意值是否为结构完整的 ReviewItem（备份导入等场景复用）。 */
export function isReviewItem(value: unknown): value is ReviewItem {
  if (!isPlainRecord(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.trim() !== "" &&
    typeof item.sessionId === "string" &&
    item.sessionId.trim() !== "" &&
    typeof item.topic === "string" &&
    item.topic.trim() !== "" &&
    (item.questionId === undefined || typeof item.questionId === "string") &&
    typeof item.prompt === "string" &&
    item.prompt.trim() !== "" &&
    typeof item.kind === "string" &&
    (REVIEW_KINDS as readonly string[]).includes(item.kind) &&
    typeof item.reason === "string" &&
    item.reason.trim() !== "" &&
    typeof item.hint === "string" &&
    (item.learnerQuote === undefined || typeof item.learnerQuote === "string") &&
    typeof item.correctExplanation === "string" &&
    item.correctExplanation.trim() !== "" &&
    isNonNegativeNumber(item.createdAt) &&
    isNonNegativeNumber(item.dueAt) &&
    isNonNegativeNumber(item.intervalDays) &&
    isNonNegativeNumber(item.streak) &&
    isNonNegativeNumber(item.attempts) &&
    (item.lastOutcome === undefined ||
      (typeof item.lastOutcome === "string" &&
        (REVIEW_RATINGS as readonly string[]).includes(item.lastOutcome))) &&
    typeof item.source === "string" &&
    (REVIEW_SOURCES as readonly string[]).includes(item.source)
  );
}

function assertReviewItem(value: unknown, context: string): ReviewItem {
  if (!isReviewItem(value)) {
    throw new Error(`${context} 不是结构完整的复习项`);
  }
  return value;
}

/**
 * 创建复习项。初始状态：dueAt = createdAt（待复习），intervalDays = 0，streak = 0。
 * prompt / hint / learnerQuote / correctExplanation 必须来自真实学习过程，不能编造。
 */
export function createReviewItem(
  input: CreateReviewItemInput,
  options: ReviewIdOptions,
): ReviewItem {
  const context = "创建复习项";
  const now = requireNow(options?.now, context);
  const newId = requireIdFactory(options?.newId, context);
  if (!isPlainRecord(input)) {
    throw new Error(`${context}：输入必须为对象`);
  }
  const sessionId = requireText(input.sessionId, "sessionId", context);
  const topic = requireText(input.topic, "topic", context);
  const prompt = requireText(input.prompt, "prompt", context);
  const reason = requireText(input.reason, "reason", context);
  const correctExplanation = requireText(
    input.correctExplanation,
    "correctExplanation",
    context,
  );
  if (input.questionId !== undefined && typeof input.questionId !== "string") {
    throw new Error(`${context}：questionId 必须为字符串`);
  }
  if (input.learnerQuote !== undefined && typeof input.learnerQuote !== "string") {
    throw new Error(`${context}：learnerQuote 必须为字符串`);
  }
  if (
    typeof input.kind !== "string" ||
    !(REVIEW_KINDS as readonly string[]).includes(input.kind)
  ) {
    throw new Error(`${context}：kind 必须是 quiz | misconception | concept`);
  }
  if (
    typeof input.source !== "string" ||
    !(REVIEW_SOURCES as readonly string[]).includes(input.source)
  ) {
    throw new Error(
      `${context}：source 必须是 quiz | misconception | concept | diagnostic`,
    );
  }
  return {
    id: newId(),
    sessionId,
    topic,
    questionId: input.questionId,
    prompt,
    kind: input.kind,
    reason,
    hint: typeof input.hint === "string" ? input.hint : "",
    learnerQuote: input.learnerQuote,
    correctExplanation,
    createdAt: now,
    dueAt: now,
    intervalDays: 0,
    streak: 0,
    attempts: 0,
    source: input.source,
  };
}

/**
 * 对复习项打分（忘了 / 模糊 / 会了），返回新的复习项（不修改原对象）。
 * - again：立即重学（dueAt = now），streak 清零，intervalDays 归零。
 * - fuzzy：短间隔（1 天）后重学，streak 保持，不推进区间。
 * - known：streak 加一，区间按 1 / 3 / 7 / 14 递增并封顶。
 */
export function rateReviewItem(
  item: ReviewItem,
  rating: ReviewRating,
  now: number,
): ReviewItem {
  assertReviewItem(item, "打分的对象");
  requireNow(now, "复习打分");
  if (!(REVIEW_RATINGS as readonly string[]).includes(rating)) {
    throw new Error(`无效的复习评分：${String(rating)}`);
  }
  const attempts = item.attempts + 1;
  if (rating === "again") {
    return {
      ...item,
      attempts,
      lastOutcome: rating,
      streak: 0,
      intervalDays: 0,
      dueAt: now,
    };
  }
  if (rating === "fuzzy") {
    return {
      ...item,
      attempts,
      lastOutcome: rating,
      streak: item.streak,
      intervalDays: FUZZY_INTERVAL_DAYS,
      dueAt: now + FUZZY_INTERVAL_DAYS * DAY_MS,
    };
  }
  const streak = item.streak + 1;
  const intervalDays =
    REVIEW_INTERVAL_DAYS[
      Math.min(streak - 1, REVIEW_INTERVAL_DAYS.length - 1)
    ];
  return {
    ...item,
    attempts,
    lastOutcome: rating,
    streak,
    intervalDays,
    dueAt: now + intervalDays * DAY_MS,
  };
}

/** 该复习项在给定时刻是否到期。 */
export function isReviewDue(item: ReviewItem, now: number): boolean {
  assertReviewItem(item, "判断到期的对象");
  requireNow(now, "判断复习到期");
  return item.dueAt <= now;
}

/**
 * 把学习过程中的误区转换为复习项。
 * correctExplanation 必须来自修复环节已有讲解，缺失时抛错（绝不编造 AI 回答）。
 * 误区描述本身即待修复原因，学习者原话（evidenceQuote）随复习项保留。
 */
export function misconceptionToReviewItem(
  misconception: LearningMisconception,
  correctExplanation: string,
  options: ReviewIdOptions,
  sessionId: string,
): ReviewItem {
  const context = "误区转换复习项";
  requireNow(options?.now, context);
  requireIdFactory(options?.newId, context);
  if (!isPlainRecord(misconception)) {
    throw new Error(`${context}：误区必须为对象`);
  }
  const description = requireText(
    misconception.description,
    "description",
    context,
  );
  const topic = requireText(misconception.topic, "topic", context);
  const explanation = requireText(
    correctExplanation,
    "correctExplanation",
    context,
  );
  const sessionIdText = requireText(sessionId, "sessionId", context);
  const question =
    typeof misconception.question === "string" && misconception.question.trim() !== ""
      ? misconception.question
      : description;
  const quote =
    typeof misconception.evidenceQuote === "string" &&
    misconception.evidenceQuote.trim() !== ""
      ? misconception.evidenceQuote
      : undefined;
  return createReviewItem(
    {
      sessionId: sessionIdText,
      topic,
      questionId: misconception.questionId,
      prompt: question,
      kind: "misconception",
      reason: `误区未修复：${description}`,
      hint: "",
      learnerQuote: quote,
      correctExplanation: explanation,
      source: "misconception",
    },
    options,
  );
}

function assertQuizQuestion(question: unknown, context: string): asserts question is NonNullable<StudySession["quiz"][number]> {
  if (!isPlainRecord(question)) {
    throw new Error(`${context}：测验题必须为对象`);
  }
  const q = question as Record<string, unknown>;
  if (typeof q.id !== "string" || q.id.trim() === "") {
    throw new Error(`${context}：测验题缺少有效 id`);
  }
  if (typeof q.question !== "string" || q.question.trim() === "") {
    throw new Error(`${context}：测验题 ${String(q.id)} 缺少题干`);
  }
  if (
    !Array.isArray(q.options) ||
    q.options.length < 2 ||
    !q.options.every((option) => typeof option === "string" && option.trim() !== "")
  ) {
    throw new Error(`${context}：测验题 ${String(q.id)} 的选项不完整`);
  }
  if (
    typeof q.correctIndex !== "number" ||
    !Number.isInteger(q.correctIndex) ||
    q.correctIndex < 0 ||
    q.correctIndex >= q.options.length
  ) {
    throw new Error(`${context}：测验题 ${String(q.id)} 的 correctIndex 越界`);
  }
  if (typeof q.explanation !== "string" || q.explanation.trim() === "") {
    throw new Error(`${context}：测验题 ${String(q.id)} 缺少解析，无法生成复习项`);
  }
  if (typeof q.hint !== "string") {
    throw new Error(`${context}：测验题 ${String(q.id)} 的 hint 必须为字符串`);
  }
}

/**
 * 从学习会话生成复习项：仅针对「已作答且答错」的测验题。
 * - 学习者原话（learnerQuote）取其实际选择的选项文本；
 * - reason 记录错误选择；hint 与解析沿用原题，不编造；
 * - 已存在的同题复习项（按 sessionId + questionId 判断）不会重复生成；
 * - 未作答的题目不生成复习项（没有真实作答证据）。
 */
export function sessionReviewItems(
  session: StudySession,
  options: ReviewIdOptions,
  existing: ReviewItem[] = [],
): ReviewItem[] {
  const context = "会话复习项生成";
  requireNow(options?.now, context);
  requireIdFactory(options?.newId, context);
  if (!isPlainRecord(session)) {
    throw new Error(`${context}：会话必须为对象`);
  }
  if (!Array.isArray(session.quiz)) {
    throw new Error(`${context}：会话缺少测验列表`);
  }
  if (!isPlainRecord(session.quizAnswers)) {
    throw new Error(`${context}：会话缺少测验作答记录`);
  }
  const topic = requireText(session.topic, "topic", context);
  const sessionId = requireText(session.id, "id", context);
  const tracked = new Set(
    existing
      .filter(
        (item) =>
          isReviewItem(item) &&
          item.sessionId === sessionId &&
          typeof item.questionId === "string",
      )
      .map((item) => item.questionId as string),
  );
  const items: ReviewItem[] = [];
  for (const question of session.quiz) {
    assertQuizQuestion(question, context);
    const answer = session.quizAnswers[question.id];
    if (typeof answer !== "number") continue;
    if (
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= question.options.length
    ) {
      throw new Error(
        `${context}：会话 ${sessionId} 测验题 ${question.id} 的作答越界`,
      );
    }
    if (answer === question.correctIndex) continue;
    if (tracked.has(question.id)) continue;
    const chosen = question.options[answer];
    items.push(
      createReviewItem(
        {
          sessionId,
          topic,
          questionId: question.id,
          prompt: question.question,
          kind: "quiz",
          reason: `测验答错：选择了「${chosen}」`,
          hint: question.hint,
          learnerQuote: chosen,
          correctExplanation: question.explanation,
          source: "quiz",
        },
        options,
      ),
    );
  }
  return items;
}

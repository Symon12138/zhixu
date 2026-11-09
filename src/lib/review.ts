import type {
  KnowledgeGraph,
  KnowledgeProposition,
  LearningMisconception,
  ReviewItem,
  ReviewRating,
  StudySession,
} from "../types";
import { unmetPrerequisites } from "./knowledgeGraph";

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

/**
 * 知识图谱命题生成的复习项沿用既有的 concept 来源/类型。
 * 界面据此标注「来自知识图谱 · 主题」，不引入无法通过备份校验的新来源值。
 */
export const KNOWLEDGE_GRAPH_REVIEW_SOURCE = "concept" as const;

export interface ReviewIdOptions {
  /** 注入的当前时间（毫秒时间戳）。 */
  now: number;
  /** 注入的 ID 生成器，保证测试可复现。 */
  newId: () => string;
}

export interface KnowledgeGraphReviewOptions extends ReviewIdOptions {
  /** 最多生成的新复习项数量（未核验的前置补练也计入）；缺省不限制。 */
  limit?: number;
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
 * 是否为知识图谱命题生成的主动回忆练习。
 * 图谱练习复用 concept 来源（见 KNOWLEDGE_GRAPH_REVIEW_SOURCE），
 * 界面据此标注「来自知识图谱 · 主题」。
 */
export function isKnowledgeGraphReviewItem(item: ReviewItem): boolean {
  return (
    isReviewItem(item) &&
    item.source === KNOWLEDGE_GRAPH_REVIEW_SOURCE &&
    item.kind === "concept"
  );
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

function comparePropositions(
  a: KnowledgeProposition,
  b: KnowledgeProposition,
): number {
  if (a.verifiedAt !== b.verifiedAt) return a.verifiedAt - b.verifiedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function latestEvidenceQuote(proposition: KnowledgeProposition): string | undefined {
  for (let index = proposition.evidence.length - 1; index >= 0; index -= 1) {
    const evidence: unknown = proposition.evidence[index];
    if (
      isPlainRecord(evidence) &&
      typeof evidence.quote === "string" &&
      evidence.quote.trim() !== ""
    ) {
      return evidence.quote;
    }
  }
  return undefined;
}

/** 把一条图谱命题转换为「不看资料、主动复述」的复习项输入。 */
function knowledgeGraphReviewInput(
  proposition: KnowledgeProposition,
  prerequisites: KnowledgeProposition[],
): CreateReviewItemInput {
  const prerequisiteText = prerequisites
    .map((item) => `「${item.statement}」`)
    .join("、");
  const prompt = prerequisites.length
    ? `不看资料，主动复述「${proposition.statement}」，并说明它与前置概念${prerequisiteText}的关系。`
    : `不看资料，主动复述这个概念：「${proposition.statement}」。`;
  const correctExplanation = prerequisites.length
    ? `${proposition.statement}\n\n前置关系：先理解${prerequisiteText}，再理解「${proposition.statement}」。`
    : proposition.statement;
  return {
    sessionId: proposition.sourceSessionId,
    topic: proposition.topic,
    questionId: proposition.id,
    prompt,
    kind: "concept",
    reason: "知识图谱中只达到「能辨认」，尚未完成应用核验",
    hint: prerequisites.length
      ? `先回想这句话的含义，再说明它为什么依赖前置概念${prerequisiteText}。`
      : "先合上资料，用一句话说出它的含义，再举一个自己的例子。",
    learnerQuote: latestEvidenceQuote(proposition),
    correctExplanation,
    source: KNOWLEDGE_GRAPH_REVIEW_SOURCE,
  };
}

/** 校验知识图谱快照，避免损坏数据在生成复习项时静默跳过。 */
function assertKnowledgeGraph(
  value: unknown,
  context: string,
): asserts value is KnowledgeGraph {
  if (!isPlainRecord(value)) {
    throw new Error(`${context}：知识图谱必须为对象`);
  }
  if (!Array.isArray(value.propositions)) {
    throw new Error(`${context}：知识图谱缺少命题列表`);
  }
  if (!Array.isArray(value.dependencies)) {
    throw new Error(`${context}：知识图谱缺少依赖列表`);
  }
  for (const proposition of value.propositions) {
    if (!isPlainRecord(proposition)) {
      throw new Error(`${context}：命题必须为对象`);
    }
    for (const field of ["id", "statement", "topic", "sourceSessionId"] as const) {
      const fieldValue = proposition[field];
      if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
        throw new Error(`${context}：命题缺少有效 ${field}`);
      }
    }
    if (!isNonNegativeNumber(proposition.verifiedAt)) {
      throw new Error(`${context}：命题 ${String(proposition.id)} 的 verifiedAt 无效`);
    }
    if (
      proposition.strength !== "understood" &&
      proposition.strength !== "applied"
    ) {
      throw new Error(`${context}：命题 ${String(proposition.id)} 的 strength 无效`);
    }
    if (!Array.isArray(proposition.evidence)) {
      throw new Error(`${context}：命题 ${String(proposition.id)} 缺少证据列表`);
    }
  }
  for (const dependency of value.dependencies) {
    if (!isPlainRecord(dependency)) {
      throw new Error(`${context}：依赖必须为对象`);
    }
    for (const field of ["fromId", "toId"] as const) {
      const fieldValue = dependency[field];
      if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
        throw new Error(`${context}：依赖缺少有效 ${field}`);
      }
    }
    if (!isNonNegativeNumber(dependency.createdAt)) {
      throw new Error(
        `${context}：依赖 ${String(dependency.fromId)}→${String(dependency.toId)} 的 createdAt 无效`,
      );
    }
  }
}

function trackedPropositionIds(existing: ReviewItem[]): Set<string> {
  return new Set(
    existing
      .filter(
        (item) => isReviewItem(item) && typeof item.questionId === "string",
      )
      .map((item) => item.questionId as string),
  );
}

/**
 * 从知识图谱生成主动回忆练习：只取 strength="understood" 的命题
 * （能辨认但还没应用），优先安排仍被别人依赖、或自身前置未核验的命题。
 *
 * 练习某个命题前会先递归补练其未核验的前置（unmetPrerequisites），
 * 因此返回顺序满足「先懂前置，再练目标」。已有相同 questionId 的复习项
 * 不会重复生成；前置已升级为 applied 时视为已满足，不再补练。
 * 本函数只生成复习项，调用方负责并入会话/工作区并持久化。
 */
export function knowledgeGraphReviewItems(
  graph: KnowledgeGraph,
  options: KnowledgeGraphReviewOptions,
  existing: ReviewItem[] = [],
): ReviewItem[] {
  const context = "知识图谱复习生成";
  assertKnowledgeGraph(graph, context);
  const now = requireNow(options?.now, context);
  const newId = requireIdFactory(options?.newId, context);
  if (!Array.isArray(existing)) {
    throw new Error(`${context}：existing 必须为数组`);
  }
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`${context}：limit 必须为非负整数`);
  }
  if (limit === 0) return [];

  const tracked = trackedPropositionIds(existing);
  const unmetByTarget = new Map<string, KnowledgeProposition[]>();
  const blocking = new Set<string>();
  for (const proposition of graph.propositions) {
    const prerequisites = unmetPrerequisites(graph, proposition.id);
    unmetByTarget.set(proposition.id, prerequisites);
    for (const prerequisite of prerequisites) blocking.add(prerequisite.id);
  }
  const priority = (proposition: KnowledgeProposition): number => {
    if (blocking.has(proposition.id)) return 0;
    if ((unmetByTarget.get(proposition.id)?.length ?? 0) > 0) return 1;
    return 2;
  };
  const candidates = graph.propositions
    .filter((proposition) => proposition.strength === "understood")
    .sort(
      (a, b) => priority(a) - priority(b) || comparePropositions(a, b),
    );

  const items: ReviewItem[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(proposition: KnowledgeProposition): void {
    if (visited.has(proposition.id) || visiting.has(proposition.id)) return;
    visiting.add(proposition.id);
    const prerequisites = (unmetByTarget.get(proposition.id) ?? [])
      .slice()
      .sort(comparePropositions);
    for (const prerequisite of prerequisites) visit(prerequisite);
    visiting.delete(proposition.id);
    visited.add(proposition.id);
    if (proposition.strength !== "understood") return;
    if (tracked.has(proposition.id)) return;
    if (limit !== undefined && items.length >= limit) return;
    items.push(
      createReviewItem(knowledgeGraphReviewInput(proposition, prerequisites), {
        now,
        newId,
      }),
    );
  }

  for (const candidate of candidates) {
    if (limit !== undefined && items.length >= limit) break;
    visit(candidate);
  }
  return items;
}

/**
 * 为指定图谱命题生成练习：未核验的前置递归补练在前，目标命题在后。
 * 目标已是 applied（已能应用）时无需再练，返回空数组。
 * 已存在的复习项按 questionId 去重，但不会阻止其缺失的前置补练。
 */
export function propositionReviewItems(
  graph: KnowledgeGraph,
  propositionId: string,
  options: ReviewIdOptions,
  existing: ReviewItem[] = [],
): ReviewItem[] {
  const context = "命题练习生成";
  assertKnowledgeGraph(graph, context);
  const now = requireNow(options?.now, context);
  const newId = requireIdFactory(options?.newId, context);
  if (!Array.isArray(existing)) {
    throw new Error(`${context}：existing 必须为数组`);
  }
  const targetId = requireText(propositionId, "propositionId", context);
  const target = graph.propositions.find(
    (proposition) => proposition.id === targetId,
  );
  if (!target) {
    throw new Error(`${context}：知识图谱中不存在命题 ${targetId}`);
  }
  if (target.strength !== "understood") return [];

  const tracked = trackedPropositionIds(existing);
  const items: ReviewItem[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(proposition: KnowledgeProposition): void {
    if (visited.has(proposition.id) || visiting.has(proposition.id)) return;
    visiting.add(proposition.id);
    const prerequisites = unmetPrerequisites(graph, proposition.id)
      .slice()
      .sort(comparePropositions);
    for (const prerequisite of prerequisites) visit(prerequisite);
    visiting.delete(proposition.id);
    visited.add(proposition.id);
    if (proposition.strength !== "understood") return;
    if (tracked.has(proposition.id)) return;
    items.push(
      createReviewItem(knowledgeGraphReviewInput(proposition, prerequisites), {
        now,
        newId,
      }),
    );
  }

  visit(target);
  return items;
}

import type { DiagnosticProfile, QuizQuestion } from "../types";

/**
 * 学习前诊断：基于主题诊断题（QuizQuestion）的真实作答，产出能力画像。
 *
 * 关键边界（与契约一致）：
 * - 诊断选择题只能产生「识别证据」（答对/答错/未答），
 *   绝不据此认证推理掌握；答对只说明「识别正确、可从后续内容开始」，
 *   仍需独立推理/迁移作答核验。
 * - 未作答的题不臆测水平，记录为证据缺口并回退到更早的起点。
 * - 时间与 ID 均由调用方注入，保证测试确定性。
 */

export interface DiagnosticQuestionInput {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  hint: string;
}

export interface DiagnosticEvaluateInput {
  topic: string;
  level: string;
  questions: DiagnosticQuestionInput[];
  answers: Record<string, number>;
  submitted: boolean;
}

export interface DiagnosticEvaluation {
  evaluatedAt: number;
  recommendedStepIndex: number;
  evidenceSummary: string[];
  weakConcepts: string[];
  skippedConcepts: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNow(now: unknown, context: string): number {
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
    throw new Error(`${context} 需要有效的注入时间 now（非负毫秒时间戳）`);
  }
  return now;
}

function requireText(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context}：字段 ${field} 不能为空`);
  }
  return value;
}

/** 校验一道选择题：身份、题干、至少两个非空选项、正确下标、解析与提示都必须真实存在。 */
export function validateQuizQuestion(
  question: unknown,
  context: string,
  label = "诊断题",
): asserts question is QuizQuestion {
  if (!isPlainRecord(question)) {
    throw new Error(`${context}：${label}必须为对象`);
  }
  const q = question as Record<string, unknown>;
  if (typeof q.id !== "string" || q.id.trim() === "") {
    throw new Error(`${context}：${label}缺少有效 id`);
  }
  if (typeof q.question !== "string" || q.question.trim() === "") {
    throw new Error(`${context}：${label} ${String(q.id)} 缺少题干`);
  }
  if (
    !Array.isArray(q.options) ||
    q.options.length < 2 ||
    !q.options.every((option) => typeof option === "string" && option.trim() !== "")
  ) {
    throw new Error(`${context}：${label} ${String(q.id)} 的选项不完整`);
  }
  if (
    typeof q.correctIndex !== "number" ||
    !Number.isInteger(q.correctIndex) ||
    q.correctIndex < 0 ||
    q.correctIndex >= q.options.length
  ) {
    throw new Error(`${context}：${label} ${String(q.id)} 的 correctIndex 越界`);
  }
  if (typeof q.explanation !== "string" || q.explanation.trim() === "") {
    throw new Error(`${context}：${label} ${String(q.id)} 缺少解析`);
  }
  if (typeof q.hint !== "string" || q.hint.trim() === "") {
    throw new Error(`${context}：${label} ${String(q.id)} 缺少提示`);
  }
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() !== "")
  );
}

/**
 * 深度校验诊断画像（备份导入等场景复用）：
 * 题目、作答关联、下标与证据数组都必须真实可解释；任何不可证明的部分都拒绝，
 * 而不是留到界面渲染时才崩溃。
 */
export function validateDiagnosticProfile(
  value: unknown,
  context = "诊断记录",
): DiagnosticProfile {
  if (!isPlainRecord(value)) throw new Error(`${context}格式无效`);
  const profile = value as Record<string, unknown>;
  if (typeof profile.id !== "string" || profile.id.trim() === "") {
    throw new Error(`${context}缺少有效 ID`);
  }
  if (typeof profile.topic !== "string" || profile.topic.trim() === "") {
    throw new Error(`${context}缺少主题`);
  }
  if (typeof profile.level !== "string" || profile.level.trim() === "") {
    throw new Error(`${context}缺少起始水平`);
  }
  if (!Array.isArray(profile.questions) || profile.questions.length === 0) {
    throw new Error(`${context}：诊断题不能为空`);
  }
  const questionIds = new Set<string>();
  for (const question of profile.questions) {
    validateQuizQuestion(question, context);
    if (questionIds.has(question.id)) {
      throw new Error(`${context}：诊断题 ID 重复 ${question.id}`);
    }
    questionIds.add(question.id);
  }
  if (!isPlainRecord(profile.answers)) {
    throw new Error(`${context}：作答记录必须为对象`);
  }
  for (const [questionId, answer] of Object.entries(profile.answers)) {
    const question = (profile.questions as QuizQuestion[]).find(
      (item) => item.id === questionId,
    );
    if (!question) {
      throw new Error(`${context}：作答记录包含未知题 ${questionId}`);
    }
    if (
      typeof answer !== "number" ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= question.options.length
    ) {
      throw new Error(`${context}：题 ${questionId} 的作答越界`);
    }
  }
  if (!isStringList(profile.evidenceSummary)) {
    throw new Error(`${context}：字段 evidenceSummary 必须是非空字符串数组`);
  }
  if (!isStringList(profile.weakConcepts)) {
    throw new Error(`${context}：字段 weakConcepts 必须是非空字符串数组`);
  }
  if (!isStringList(profile.skippedConcepts)) {
    throw new Error(`${context}：字段 skippedConcepts 必须是非空字符串数组`);
  }
  if (typeof profile.submitted !== "boolean") {
    throw new Error(`${context}：submitted 必须是布尔值`);
  }
  if (
    profile.evaluatedAt !== undefined &&
    (typeof profile.evaluatedAt !== "number" || !Number.isFinite(profile.evaluatedAt))
  ) {
    throw new Error(`${context}：evaluatedAt 必须是有效时间`);
  }
  if (
    typeof profile.recommendedStepIndex !== "number" ||
    !Number.isInteger(profile.recommendedStepIndex) ||
    profile.recommendedStepIndex < 0
  ) {
    throw new Error(`${context}：recommendedStepIndex 必须是非负整数`);
  }
  return value as unknown as DiagnosticProfile;
}

/** 校验任意值是否为结构完整的 DiagnosticProfile（备份导入等场景复用）。 */
export function isDiagnosticProfile(value: unknown): value is DiagnosticProfile {
  try {
    validateDiagnosticProfile(value);
    return true;
  } catch {
    return false;
  }
}

function assertDiagnosticProfile(
  value: unknown,
  context: string,
): DiagnosticProfile {
  try {
    return validateDiagnosticProfile(value, context);
  } catch (error) {
    throw new Error(
      `${context} 不是结构完整的诊断画像：${error instanceof Error ? error.message : "格式无效"}`,
    );
  }
}

/**
 * 评价诊断作答（核心函数）：基于每题的实际选项作答，产出
 * - weakConcepts / skippedConcepts：按题归类；
 * - evidenceSummary：逐题识别证据，明确「识别正确 ≠ 推理掌握」；
 * - recommendedStepIndex：第一个答错（或未答）题的题号作为进入点；
 *   全对时给出靠后的起点，但仍提示需要独立解释核验。
 *
 * 只接受真实记录的作答（answers 键必须对应 questions 中的题），
 * 未提交（submitted=false）时拒绝评价——按钮点击不构成评价依据。
 */
export function evaluateDiagnostic(
  questions: QuizQuestion[],
  answers: Record<string, number>,
  now: number,
): DiagnosticEvaluation {
  const context = "诊断评价";
  requireNow(now, context);
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${context}：诊断题不能为空`);
  }
  if (!isPlainRecord(answers)) {
    throw new Error(`${context}：作答记录必须为对象`);
  }
  questions.forEach((question) => validateQuizQuestion(question, context));

  // answers 里出现未知题 ID 说明作答记录与诊断题集不一致，拒绝评价。
  for (const answerId of Object.keys(answers)) {
    if (!questions.some((question) => question.id === answerId)) {
      throw new Error(`${context}：作答记录包含未知题 ${answerId}`);
    }
  }

  const weakConcepts: string[] = [];
  const skippedConcepts: string[] = [];
  const evidenceSummary: string[] = [];
  let firstUnresolvedIndex = -1;

  questions.forEach((question, index) => {
    const answer = answers[question.id];
    if (typeof answer !== "number") {
      evidenceSummary.push(
        `第${index + 1}题「${question.question}」未作答，无法判断前置水平，需从更早内容进入。`,
      );
      if (firstUnresolvedIndex < 0) firstUnresolvedIndex = index;
      return;
    }
    if (
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= question.options.length
    ) {
      throw new Error(
        `${context}：题 ${question.id} 的作答 ${String(answer)} 越界`,
      );
    }
    if (answer === question.correctIndex) {
      skippedConcepts.push(question.question);
      evidenceSummary.push(
        `第${index + 1}题「${question.question}」识别正确：可作为可跳过的前置，但仍需独立解释与推理作答核验，不能仅凭选项点击认定掌握。`,
      );
    } else {
      weakConcepts.push(question.question);
      evidenceSummary.push(
        `第${index + 1}题「${question.question}」答错：需要补充前置理解（提示：${question.hint}），进入微课修复后再推进。`,
      );
      if (firstUnresolvedIndex < 0) firstUnresolvedIndex = index;
    }
  });

  if (firstUnresolvedIndex < 0) {
    firstUnresolvedIndex = Math.min(questions.length, 2);
    evidenceSummary.push(
      `全部 ${questions.length} 题识别正确：建议从后续综合应用开始，但掌握结论仍需独立推理与迁移作答核验。`,
    );
  }
  return {
    evaluatedAt: now,
    recommendedStepIndex: firstUnresolvedIndex,
    evidenceSummary,
    weakConcepts,
    skippedConcepts,
  };
}

/** 创建诊断画像（未提交状态）。answers 初始为空，等待真实作答。 */
export function createDiagnosticProfile(
  input: DiagnosticEvaluateInput,
  options: { now: number; newId: () => string },
): DiagnosticProfile {
  const context = "创建诊断画像";
  const now = requireNow(options?.now, context);
  if (typeof options?.newId !== "function") {
    throw new Error(`${context} 需要注入 newId 生成函数`);
  }
  const topic = requireText(input?.topic, "topic", context);
  const level = requireText(input?.level, "level", context);
  if (!Array.isArray(input?.questions) || input.questions.length === 0) {
    throw new Error(`${context}：诊断题不能为空`);
  }
  input.questions.forEach((question) => validateQuizQuestion(question, context));
  return {
    id: options.newId(),
    topic,
    level,
    questions: input.questions.map((question) => ({ ...question })),
    answers: {},
    submitted: false,
    recommendedStepIndex: 0,
    evidenceSummary: [],
    weakConcepts: [],
    skippedConcepts: [],
  };
}

/**
 * 提交并评价诊断：原子地完成 submitted 翻转与评价。
 * 重复提交会被拒绝；answers 必须覆盖全部诊断题（未答按未作答处理并回退起点）。
 */
export function submitDiagnostic(
  profile: DiagnosticProfile,
  answers: Record<string, number>,
  now: number,
): DiagnosticProfile {
  assertDiagnosticProfile(profile, "提交的对象");
  requireNow(now, "诊断提交");
  if (!isPlainRecord(answers)) {
    throw new Error("诊断提交：作答记录必须为对象");
  }
  if (profile.submitted) {
    throw new Error("诊断提交：该诊断已提交，不能重复评价");
  }
  for (const answerId of Object.keys(answers)) {
    if (!profile.questions.some((question) => question.id === answerId)) {
      throw new Error(`诊断提交：作答记录包含未知题 ${answerId}`);
    }
  }
  const evaluation = evaluateDiagnostic(profile.questions, answers, now);
  return {
    ...profile,
    answers: { ...answers },
    submitted: true,
    evaluatedAt: evaluation.evaluatedAt,
    recommendedStepIndex: evaluation.recommendedStepIndex,
    evidenceSummary: evaluation.evidenceSummary,
    weakConcepts: evaluation.weakConcepts,
    skippedConcepts: evaluation.skippedConcepts,
  };
}

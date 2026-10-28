import type {
  AssessmentVerdict,
  EvidenceKind,
  LearningAssessment,
  LearningDetour,
  LearningEvidence,
  LearningMisconception,
  LearningQuestion,
  LearningState,
  LearningStep,
  MasteryLevel,
  QuestionKind,
  TeachingMove,
} from "../types";

export interface TeachingIssue {
  code: string;
  detail: string;
}

export class LearningProtocolError extends Error {
  constructor(public issues: TeachingIssue[]) {
    super(issues.map((issue) => issue.detail).join("；"));
    this.name = "LearningProtocolError";
  }
}

export interface QuestionContent {
  prompt: string;
  kind: QuestionKind;
  options: string[];
  successCriteria: string[];
  protectedAnswers?: string[];
}

export interface QuestionDraft extends QuestionContent {
  stepId: string;
}

export const moves: TeachingMove[] = [
  "orient", "explain", "probe", "hint", "repair", "clarify", "answer", "return", "transfer", "recap",
];
const verdicts: AssessmentVerdict[] = ["not_assessed", "uncertain", "incorrect", "partial", "correct"];
const evidenceKinds: ("none" | EvidenceKind)[] = ["none", "recognition", "reasoning", "transfer"];
const questionKinds: QuestionKind[] = ["orientation", "diagnostic", "reasoning", "calculation", "transfer", "choice"];
const masteryLevels: MasteryLevel[] = ["new", "learning", "understood", "applied"];

function invalid(detail: string, code = "invalid_protocol"): never {
  throw new LearningProtocolError([{ code, detail }]);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 2000, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max)
    invalid(`${name} 必须是${empty ? "" : "非空"}字符串，且不超过 ${max} 字符`);
  return value.trim();
}

function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(`${name} 不在允许的范围内`);
  return value as T;
}

function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${name} 必须是数组，最多 ${max} 项`);
  return value;
}

function strings(value: unknown, name: string, max = 8, min = 0, itemMax = 1000): string[] {
  const result = list(value, name, max).map((item, index) => text(item, `${name}[${index}]`, itemMax));
  if (result.length < min) invalid(`${name} 至少需要 ${min} 项`);
  return result;
}

export function assessment(value: unknown): LearningAssessment {
  const data = object(value, "assessment");
  return {
    verdict: choice(data.verdict, verdicts, "assessment.verdict"),
    evidenceQuote: text(data.evidenceQuote, "assessment.evidenceQuote", 1000, true),
    questionId: data.questionId === null ? null : text(data.questionId, "assessment.questionId", 150),
    demonstrated: choice(data.demonstrated, evidenceKinds, "assessment.demonstrated"),
    feedback: text(data.feedback, "assessment.feedback", 1500),
  };
}

export function parseQuestionContent(value: unknown): QuestionContent {
  const data = object(value, "question");
  const result: QuestionContent = {
    prompt: text(data.prompt, "question.prompt", 2500),
    kind: choice(data.kind, questionKinds, "question.kind"),
    options: strings(data.options ?? [], "question.options", 6, 0, 1000),
    successCriteria: strings(data.successCriteria, "question.successCriteria", 6, 1, 1000),
    ...(data.protectedAnswers === undefined ? {} : { protectedAnswers: strings(data.protectedAnswers, "question.protectedAnswers", 8, 0, 200) }),
  };
  if (result.kind === "choice" && result.options.length < 2) invalid("选择题至少需要两个选项");
  return result;
}

export function questionDraft(value: unknown): QuestionDraft {
  const data = object(value, "question");
  return { ...parseQuestionContent(data), stepId: text(data.stepId, "question.stepId", 150) };
}

function storedQuestion(value: unknown): LearningQuestion {
  const data = object(value, "pendingQuestion");
  return {
    ...questionDraft(data),
    id: text(data.id, "question.id", 150),
    scope: choice(data.scope, ["main", "detour"] as const, "question.scope"),
  };
}

function evidence(value: unknown): LearningEvidence {
  const data = object(value, "evidence");
  if (!Number.isSafeInteger(data.turn) || (data.turn as number) < 1) invalid("证据轮次必须是正整数");
  return {
    quote: text(data.quote, "evidence.quote", 1000),
    questionId: text(data.questionId, "evidence.questionId", 150),
    ...(data.question === undefined ? {} : { question: text(data.question, "evidence.question", 2500) }),
    kind: choice(data.kind, ["recognition", "reasoning", "transfer"] as const, "evidence.kind"),
    turn: data.turn as number,
  };
}

function normalizedQuestion(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/g, "");
  return normalized === "" ? undefined : normalized;
}

/**
 * 是否已有「另一个问题」上的解释证据。
 * 迁移通过必须证明解释与迁移发生在不同问题：两个问题的题干都要真实存在且可比较；
 * 缺少题干（旧证据）或题干相同仅换 ID 都不能冒充新问题。无法证明时返回 false，
 * 由调用方拒绝 applied，而不是修改或补造证据。
 */
export function hasPriorReasoning(items: LearningEvidence[], questionId: string, prompt?: string): boolean {
  const target = normalizedQuestion(prompt);
  if (target === undefined) return false;
  return items.some(item => {
    const prior = normalizedQuestion(item.question);
    return item.kind === "reasoning" && item.questionId !== questionId &&
      prior !== undefined && prior !== target;
  });
}

function masteryEvidence(value: unknown, name: string): { mastery: MasteryLevel; evidence: LearningEvidence[] } {
  const data = object(value, name);
  const mastery = choice(data.mastery, masteryLevels, `${name}.mastery`);
  const items = list(data.evidence, `${name}.evidence`, 200).map(evidence);
  if ((mastery === "understood" || mastery === "applied") && !items.some(item => item.kind === "reasoning"))
    invalid("理解状态必须有学习者解释的证据", "unproven_mastery");
  if (mastery === "applied" && !items.some(item => item.kind === "transfer" && hasPriorReasoning(items, item.questionId, item.question)))
    invalid("迁移通过必须有不同问题上的解释和迁移证据", "unproven_mastery");
  return { mastery, evidence: items };
}

/** 浏览器与服务器共享：不信任模型自报进度，只校验已保存的结构与证据。 */
export function parseLearningState(value: unknown): LearningState | undefined {
  if (value === undefined || value === null) return undefined;
  const data = object(value, "learningState");
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0)
    invalid("学习状态版本或轮次无效", "invalid_state");
  const steps: LearningStep[] = list(data.steps, "steps", 8).map((item) => {
    const step = object(item, "step");
    return { id: text(step.id, "step.id", 150), title: text(step.title, "step.title", 300), ...masteryEvidence(step, "step") };
  });
  if (!steps.length || new Set(steps.map(step => step.id)).size !== steps.length)
    invalid("学习路线不能为空，步骤编号不能重复", "invalid_state");
  const currentStepId = text(data.currentStepId, "currentStepId", 150);
  const pendingQuestion = data.pendingQuestion === null ? null : storedQuestion(data.pendingQuestion);
  const detours: LearningDetour[] = list(data.detours, "detours", 5).map((item) => {
    const detour = object(item, "detour");
    return {
      topic: text(detour.topic, "detour.topic", 500),
      returnStepId: text(detour.returnStepId, "detour.returnStepId", 150),
      returnQuestion: detour.returnQuestion === null ? null : storedQuestion(detour.returnQuestion),
      ...masteryEvidence(detour, "detour"),
    };
  });
  const misconceptions: LearningMisconception[] = list(data.misconceptions, "misconceptions", 100).map((item) => {
    const entry = object(item, "misconception");
    return {
      id: text(entry.id, "misconception.id", 150),
      stepId: text(entry.stepId, "misconception.stepId", 150),
      questionId: text(entry.questionId, "misconception.questionId", 150),
      ...(entry.question === undefined ? {} : { question: text(entry.question, "misconception.question", 2500) }),
      scope: choice(entry.scope, ["main", "detour"] as const, "misconception.scope"),
      topic: text(entry.topic, "misconception.topic", 500),
      description: text(entry.description, "misconception.description", 1500),
      evidenceQuote: text(entry.evidenceQuote, "misconception.evidenceQuote", 1000),
      status: choice(entry.status, ["open", "repairing", "resolved"] as const, "misconception.status"),
    };
  });
  const stepIds = new Set(steps.map(step => step.id));
  if (!stepIds.has(currentStepId) || (pendingQuestion && !stepIds.has(pendingQuestion.stepId)) ||
    detours.some(detour => !stepIds.has(detour.returnStepId) || (detour.returnQuestion && !stepIds.has(detour.returnQuestion.stepId))) ||
    misconceptions.some(item => !stepIds.has(item.stepId))) invalid("学习状态引用了不存在的步骤", "invalid_state");
  if (pendingQuestion?.scope === "detour" && !detours.length) invalid("补课问题缺少主线返回点", "invalid_state");
  if ([...steps.flatMap(step => step.evidence), ...detours.flatMap(detour => detour.evidence)].some(item => item.turn > (data.revision as number)))
    invalid("理解证据不能来自未来轮次", "invalid_state");
  const savedTracks = list(data.savedTracks ?? [], "savedTracks", 8).map((item) => {
    const track = object(item, "savedTrack");
    const parsed = parseLearningState({
      ...track, version: 1, revision: data.revision, savedTracks: [], deferredTopics: [], lastAssessment: null, lastMove: null,
    })!;
    return {
      goal: parsed.goal, steps: parsed.steps, currentStepId: parsed.currentStepId,
      pendingQuestion: parsed.pendingQuestion, detours: parsed.detours,
      misconceptions: parsed.misconceptions, assumptions: parsed.assumptions,
    };
  });
  if (new Set(savedTracks.map(track => track.goal)).size !== savedTracks.length)
    invalid("已保存学习主线不能重复", "invalid_state");
  return {
    version: 1,
    revision: data.revision as number,
    goal: text(data.goal, "learningState.goal", 2000),
    steps,
    currentStepId,
    pendingQuestion,
    detours,
    misconceptions,
    deferredTopics: strings(data.deferredTopics, "deferredTopics", 50, 0, 2000),
    savedTracks,
    assumptions: strings(data.assumptions, "assumptions", 30, 0, 1000),
    lastAssessment: data.lastAssessment === null ? null : assessment(data.lastAssessment),
    lastMove: data.lastMove === null ? null : choice(data.lastMove, moves, "lastMove"),
  };
}

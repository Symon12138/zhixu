import type {
  LearningQuestion,
  EvidenceKind,
  LearningEvidence,
  TransferStep,
  TransferTrack,
} from "../types";

export type TransferLevel = TransferStep["level"];
export type TransferAnswerVerdict =
  | "correct"
  | "partial"
  | "incorrect"
  | "uncertain";

export interface TransferStepSpec {
  id: string;
  title: string;
  scenario: string;
  prompt: string;
  expectedFocus: string;
  questionId?: string;
  level?: TransferLevel;
}

export interface TransferAnswer {
  stepId: string;
  verdict: TransferAnswerVerdict;
  evidence: LearningEvidence;
}

export type TransferOutcome = "passed" | "retry";

export type TransferRejectionReason =
  | "not_current_step"
  | "already_done"
  | "verdict_not_correct"
  | "evidence_kind_mismatch"
  | "question_mismatch"
  | "empty_quote";

export interface TransferRecordResult {
  track: TransferTrack;
  outcome: TransferOutcome;
  reason: TransferRejectionReason | "passed";
  requiredEvidence: EvidenceKind;
}

export class TransferTrackError extends Error {
  code: "empty_track" | "bad_level_order" | "bad_start_index";

  constructor(
    code: "empty_track" | "bad_level_order" | "bad_start_index",
    message: string,
  ) {
    super(message);
    this.name = "TransferTrackError";
    this.code = code;
  }
}

const levelRank: Record<TransferLevel, number> = {
  variant: 0,
  context: 1,
  mixed: 2,
};

/**
 * 迁移层级对应的独立作答证据门槛：变式题要求学习者解释推理，
 * 新情境与综合边界要求把机制迁移到新情境；识别（recognition）永远不够。
 */
export function requiredEvidenceForLevel(level: TransferLevel): EvidenceKind {
  return level === "variant" ? "reasoning" : "transfer";
}

/** 按「done…current, available…」重排步骤状态；cursor 越过末尾时全部 done。 */
function withStatuses(steps: TransferStep[], cursor: number): TransferStep[] {
  return steps.map((step, index) => ({
    ...step,
    status:
      index < cursor
        ? ("done" as const)
        : index === cursor
          ? ("current" as const)
          : ("available" as const),
  }));
}

/**
 * 由出题规格建立迁移轨道。层级按顺序形成 变式→新情境→综合边界 的递进：
 * - 完整多步轨道必须从同概念变式开始，且层级不允许倒退；
 * - 只有一道题，或显式传入 startIndex 从导师当前真实迁移题起轨时，
 *   起点可以是 context/mixed（它本来就不是安排的第一个层级）；
 * - startIndex 之前的步骤记为已完成，只有起点及之后的步骤能通过作答推进，
 *   界面按钮无法把起点之前的步骤标成完成。
 * 题目 id 原样保留，不重新生成。
 */
export function createTransferTrack(input: {
  id: string;
  sessionId: string;
  steps: TransferStepSpec[];
  now: number;
  /**
   * 以第几道题作为当前关卡（0 起）。用于从导师当前给出的真实迁移题继续：
   * 之前的步骤视为已经完成，recordTransferAnswer 只接受当前关卡。
   */
  startIndex?: number;
}): TransferTrack {
  const { id, sessionId, now } = input;
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new TransferTrackError("empty_track", "迁移轨道至少需要一道题");
  }

  const startIndex = input.startIndex ?? 0;
  if (
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= input.steps.length
  ) {
    throw new TransferTrackError(
      "bad_start_index",
      "迁移轨道起点必须是已存在的题目序号",
    );
  }

  const steps: TransferStep[] = input.steps.map((spec, index) => ({
    id: spec.id,
    title: spec.title,
    scenario: spec.scenario,
    prompt: spec.prompt,
    expectedFocus: spec.expectedFocus,
    level: spec.level ?? (index === 0 ? "variant" : index === 1 ? "context" : "mixed"),
    status: "available" as const,
    questionId: spec.questionId,
  }));

  // 单题或显式从真实当前题起轨时，首步不必是变式；其余完整轨道保持原顺序约束。
  const beginsAtCurrentQuestion = input.startIndex !== undefined || steps.length === 1;
  if (!beginsAtCurrentQuestion && steps[0].level !== "variant") {
    throw new TransferTrackError(
      "bad_level_order",
      "完整迁移轨道应从同概念变式开始，或通过 startIndex 从当前真实题起轨",
    );
  }
  for (let i = 1; i < steps.length; i += 1) {
    if (levelRank[steps[i].level] < levelRank[steps[i - 1].level]) {
      throw new TransferTrackError("bad_level_order", "迁移层级不能倒退：变式→新情境→综合边界");
    }
  }

  return {
    id,
    sessionId,
    steps: withStatuses(steps, startIndex),
    currentStepId: steps[startIndex].id,
    createdAt: now,
    updatedAt: now,
  };
}

export function isTrackComplete(track: TransferTrack): boolean {
  return track.steps.every((step) => step.status === "done");
}

/** 把导师当前真实迁移题同步到轨道；未通过的旧关卡绝不会因换题被标成完成。 */
export function syncTransferQuestion(input: {
  track: TransferTrack | undefined;
  question: LearningQuestion;
  sessionId: string;
  now: number;
  newId: () => string;
}): TransferTrack {
  const { track, question, sessionId, now, newId } = input;
  const spec: TransferStepSpec = {
    id: `transfer-${question.id}`,
    title: question.prompt.slice(0, 60),
    scenario: question.prompt,
    prompt: question.prompt,
    expectedFocus: question.successCriteria[0] ?? "在新情境解释机制",
    questionId: question.id,
    level: "context",
  };
  if (!track) {
    return createTransferTrack({ id: newId(), sessionId, now, steps: [spec] });
  }
  if (track.steps.some(step => step.questionId === question.id)) return track;
  if (isTrackComplete(track)) {
    return {
      ...track,
      steps: [...track.steps, { ...spec, level: "context", status: "current" }],
      currentStepId: spec.id,
      updatedAt: now,
    };
  }
  const currentIndex = track.steps.findIndex(step => step.id === track.currentStepId);
  if (currentIndex === -1 || track.steps[currentIndex].status === "done") {
    throw new TransferTrackError("bad_start_index", "迁移轨道当前位置无效，请重置迁移记录后再试");
  }
  // 错答后导师可能已经换了新题：替换未通过的当前关卡，而非假称它已完成。
  return {
    ...track,
    steps: track.steps.map((step, index) =>
      index === currentIndex ? { ...spec, level: "context", status: "current" } : step,
    ),
    currentStepId: spec.id,
    updatedAt: now,
  };
}

/**
 * 记录一次独立作答并推进轨道。证据必须由调用方给出，本函数不生成任何证据：
 * - 只有 verdict === "correct" 且证据类型达到当前层级门槛才推进；
 * - 证据必须引用当前步骤自己的 questionId，题目 id 原样保留；
 * - 答错/部分/模糊/证据类型不符/题目不符时步骤保持 current，
 *   题目与状态不变，学习者原地重试，不产生任何"换数字也算迁移"的推进。
 */
export function recordTransferAnswer(
  track: TransferTrack,
  answer: TransferAnswer,
  now: number,
): TransferRecordResult {
  const index = track.steps.findIndex((step) => step.id === answer.stepId);
  if (index === -1 || track.steps[index].id !== track.currentStepId) {
    const currentIndex = track.steps.findIndex((step) => step.id === track.currentStepId);
    return {
      track,
      outcome: "retry",
      reason: "not_current_step",
      requiredEvidence:
        currentIndex === -1
          ? "reasoning"
          : requiredEvidenceForLevel(track.steps[currentIndex].level),
    };
  }
  const step = track.steps[index];
  const required = requiredEvidenceForLevel(step.level);
  if (step.status === "done") {
    return { track, outcome: "retry", reason: "already_done", requiredEvidence: required };
  }
  if (answer.verdict !== "correct") {
    return { track, outcome: "retry", reason: "verdict_not_correct", requiredEvidence: required };
  }
  const evidence = answer.evidence;
  if (!evidence || typeof evidence.quote !== "string" || evidence.quote.trim() === "") {
    return { track, outcome: "retry", reason: "empty_quote", requiredEvidence: required };
  }
  if (evidence.kind !== required) {
    return { track, outcome: "retry", reason: "evidence_kind_mismatch", requiredEvidence: required };
  }
  if (
    (step.questionId !== undefined && evidence.questionId !== step.questionId) ||
    (step.questionId === undefined &&
      (typeof evidence.questionId !== "string" || evidence.questionId === ""))
  ) {
    return { track, outcome: "retry", reason: "question_mismatch", requiredEvidence: required };
  }

  const isLast = index + 1 === track.steps.length;
  const updated: TransferTrack = {
    ...track,
    steps: withStatuses(
      track.steps.map((item, i) =>
        i === index ? { ...item, status: "done" as const } : item,
      ),
      isLast ? track.steps.length : index + 1,
    ),
    currentStepId: isLast ? step.id : track.steps[index + 1].id,
    updatedAt: now,
  };
  return {
    track: updated,
    outcome: "passed",
    reason: "passed",
    requiredEvidence: required,
  };
}

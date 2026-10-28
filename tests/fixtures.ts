import type {
  ChatRequest,
  LearningAssessment,
  LearningState,
  QuestionKind,
} from "../src/types";
import type { TeachingDirective, TutorDraft } from "../server/learning";

export function stateWithQuestion(mastered = false): LearningState {
  return {
    version: 1,
    revision: 2,
    goal: "理财净值与交易确认",
    steps: [
      {
        id: "step-1",
        title: "现金分红如何影响两种净值",
        mastery: mastered ? "understood" : "learning",
        evidence: mastered
          ? [
              {
                quote: "分红从产品资产中转出，进入客户现金账户。",
                questionId: "earlier-reasoning",
                question: "现金分红从哪里支付？",
                kind: "reasoning",
                turn: 1,
              },
            ]
          : [],
      },
      {
        id: "step-2",
        title: "本地额度与外部确认的边界",
        mastery: "new",
        evidence: [],
      },
      {
        id: "step-3",
        title: "在新条件下检查交易机制",
        mastery: "new",
        evidence: [],
      },
    ],
    currentStepId: "step-1",
    pendingQuestion: {
      id: "nav-question",
      stepId: "step-1",
      prompt:
        "无其它价格变动和费用，分红前单位与累计净值均1.10，每份发现金0.05，分红后两种净值分别是多少？",
      kind: "calculation",
      options: [],
      successCriteria: ["现金从资产池转出", "单位净值1.05", "累计净值1.10"],
      scope: "main",
    },
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: ["本例期间无其它价格变动、费用或份额变化"],
    lastAssessment: null,
    lastMove: "explain",
  };
}

export function requestFor(
  state: LearningState,
  text: string,
  action: ChatRequest["action"] = "message",
): ChatRequest {
  return {
    topic: "银行理财业务",
    level: "从零开始",
    goal: "能解释业务机制并应用",
    action,
    learningState: state,
    messages: [
      {
        role: "assistant",
        content: state.pendingQuestion?.prompt ?? "继续当前学习",
      },
      { role: "user", content: text },
    ],
  };
}

export function answerFor(
  state: LearningState,
  quote: string,
  verdict: LearningAssessment["verdict"] = "correct",
  demonstrated: LearningAssessment["demonstrated"] = "reasoning",
): LearningAssessment {
  return {
    verdict,
    evidenceQuote: quote,
    questionId: state.pendingQuestion?.id ?? null,
    demonstrated,
    feedback: "依据本轮作答核对机制；没有独立核验的部分不计为掌握。",
  };
}

export function draftFor(
  state: LearningState,
  changes: Partial<TeachingDirective> = {},
): TutorDraft {
  return {
    message:
      "先区分资产池里的价值与已经付出的现金。现金分红不是额外创造的收益，需要根据资金流重新核对。",
    sources: [],
    teaching: {
      intent: "continue",
      move: "explain",
      focusStepId: state.currentStepId,
      assessment: {
        verdict: "not_assessed",
        evidenceQuote: "",
        questionId: null,
        demonstrated: "none",
        feedback: "本轮没有新的作答，不增加理解证据。",
      },
      navigation: { kind: "stay" },
      question: {
        stepId: state.currentStepId,
        prompt:
          "若一份产品原有1.20元，付出0.08元现金，剩在产品里的价值如何变化？请解释资金从哪来。",
        kind: "reasoning",
        options: [],
        successCriteria: ["区分现金转出与新增收益"],
      },
      assumptions: [],
      resolvedMisconceptionIds: [],
      ...changes,
    },
  };
}

export function openingDraft(): TutorDraft {
  const state = stateWithQuestion();
  return {
    ...draftFor(state, { move: "orient" }),
    title: "理解现金分红与净值",
    plan: state.steps.map((step) => step.title),
  };
}

export function questionFor(
  state: LearningState,
  kind: QuestionKind,
  prompt: string,
) {
  return {
    stepId: state.currentStepId,
    prompt,
    kind,
    options: [],
    successCriteria: ["说明资金变化与结果之间的因果关系"],
  };
}

export const passingReview = JSON.stringify({
  verdict: "pass",
  checks: {
    responsive: true,
    assessment: true,
    scaffolding: true,
    continuity: true,
    calibration: true,
  },
  issues: [],
});
export const rejectingReview = JSON.stringify({
  verdict: "revise",
  checks: {
    responsive: true,
    assessment: false,
    scaffolding: false,
    continuity: true,
    calibration: true,
  },
  issues: [
    {
      code: "premature_answer",
      detail: "没有定位学习者误区，并在核验之前给出最终答案。",
    },
  ],
});

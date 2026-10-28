import assert from "node:assert/strict";
import test from "node:test";
import type { LearningEvidence, LearningState } from "../src/types";
import {
  hasPriorReasoning,
  parseLearningState,
} from "../src/lib/learningState";

function appliedState(evidence: LearningEvidence[]): LearningState {
  return {
    version: 1,
    revision: 2,
    goal: "能解释分红对两种净值的影响",
    steps: [
      {
        id: "step-1",
        title: "分红与净值",
        mastery: "applied",
        evidence,
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
    lastMove: null,
  };
}

const reasoning: LearningEvidence = {
  quote: "分红从产品资产转出，累积净值把历史现金加回。",
  questionId: "reasoning-1",
  question: "现金分红从哪里支付？",
  kind: "reasoning",
  turn: 1,
};

const transfer: LearningEvidence = {
  quote: "单位净值降为 1.30，累计净值仍为 1.40。",
  questionId: "transfer-1",
  question: "分红后两种净值分别是多少？",
  kind: "transfer",
  turn: 2,
};

test("迁移 applied：解释与迁移发生在两个题干不同的真实问题上才成立", () => {
  const parsed = parseLearningState(appliedState([reasoning, transfer]));
  assert.equal(parsed?.steps[0].mastery, "applied");
  assert.equal(hasPriorReasoning([reasoning], transfer.questionId, transfer.question), true);
});

test("缺少 question 的旧证据不能证明迁移，拒绝 applied 而不篡改证据", () => {
  const { question: _question, ...reasoningWithoutQuestion } = reasoning;
  const state = appliedState([reasoningWithoutQuestion, transfer]);
  assert.throws(
    () => parseLearningState(state),
    /迁移通过必须有不同问题上的解释和迁移证据/,
  );
  assert.equal(
    hasPriorReasoning([reasoningWithoutQuestion], transfer.questionId, transfer.question),
    false,
  );

  const { question: _transferQuestion, ...transferWithoutQuestion } = transfer;
  assert.throws(
    () => parseLearningState(appliedState([reasoning, transferWithoutQuestion])),
    /迁移通过必须有不同问题上的解释和迁移证据/,
  );
  assert.equal(
    hasPriorReasoning([reasoning], transfer.questionId, undefined),
    false,
  );
});

test("同题干换 ID 不能冒充不同问题，忽略空白与全半角差异", () => {
  const sameTextDifferentId: LearningEvidence = {
    ...reasoning,
    questionId: "reasoning-2",
    question: "现金 分红从哪里支付?",
  };
  assert.equal(
    hasPriorReasoning([sameTextDifferentId], transfer.questionId, "现金分红从哪里支付？"),
    false,
  );
  const sameTextTransfer: LearningEvidence = {
    ...transfer,
    question: "现金 分红从哪里支付?",
  };
  assert.throws(
    () => parseLearningState(appliedState([reasoning, sameTextTransfer])),
    /迁移通过必须有不同问题上的解释和迁移证据/,
  );
});

test("缺少迁移题干时即使有解释证据也不能证明 applied", () => {
  assert.equal(hasPriorReasoning([reasoning], transfer.questionId, undefined), false);
  assert.equal(hasPriorReasoning([reasoning], transfer.questionId, "  "), false);
  assert.equal(hasPriorReasoning([], transfer.questionId, transfer.question), false);
});

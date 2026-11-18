import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatRequest,
  DiagnosticProfile,
  KnowledgeGraph,
  KnowledgeProposition,
  QuizQuestion,
} from "../src/types";
import { validateChatRequest } from "../server/index";
import { checkTutorDraft } from "../server/learning";
import { selectDiagnosticQuestions } from "../server/diagnostic";
import {
  createDiagnosticProfile,
  evaluateDiagnostic,
  highConfidenceErrorRatio,
  submitDiagnostic,
  validateDiagnosticProfile,
} from "../src/lib/diagnostic";
import { priorProbeTargets } from "../src/lib/knowledgeGraph";
import { answerFor, draftFor, requestFor, stateWithQuestion } from "./fixtures";

/* ── T5：自报置信度是元认知信息，不是理解证据 ───────────────────── */

const QUESTIONS: QuizQuestion[] = [
  {
    id: "q1",
    question: "先算哪一步？",
    options: ["先算总额", "先算差额"],
    correctIndex: 0,
    explanation: "先确认总额。",
    hint: "看题干给出的总量。",
  },
  {
    id: "q2",
    question: "差额代表什么？",
    options: ["新增收益", "已转出的价值"],
    correctIndex: 1,
    explanation: "差额是转出的价值。",
    hint: "区分转移与新增。",
  },
  {
    id: "q3",
    question: "净值如何变化？",
    options: ["不变", "下降"],
    correctIndex: 1,
    explanation: "资产减少则净值下降。",
    hint: "看产品里还剩什么。",
  },
];

function baseRequest(): Record<string, unknown> {
  return {
    action: "start",
    topic: "现金分红",
    level: "初学",
    goal: "理解资金流向",
    messages: [{ role: "user", content: "开始学习" }],
  };
}

function proposition(
  id: string,
  statement: string,
  strength: "understood" | "applied",
  verifiedAt: number,
): KnowledgeProposition {
  return {
    id,
    statement,
    topic: "分账",
    sourceSessionId: "session-1",
    verifiedAt,
    strength,
    evidence: [],
  };
}

function graphOf(propositions: KnowledgeProposition[], fromIds: string[]): KnowledgeGraph {
  return {
    propositions,
    dependencies: fromIds.map((fromId) => ({
      fromId,
      toId: "target",
      createdAt: 1,
    })),
  };
}

/* ── 请求校验 ───────────────────────────────────────────────── */

test("ChatRequest：answerConfidence 只接受 low/medium/high，旧请求缺省合法", () => {
  const ok = validateChatRequest({ ...baseRequest(), answerConfidence: "high" });
  assert.equal(ok.answerConfidence, "high");

  const legacy = validateChatRequest(baseRequest());
  assert.equal(legacy.answerConfidence, undefined);

  assert.throws(
    () => validateChatRequest({ ...baseRequest(), answerConfidence: "sure" }),
    /answerConfidence 必须是 low、medium 或 high/,
  );
  assert.throws(
    () => validateChatRequest({ ...baseRequest(), answerConfidence: 3 }),
    /answerConfidence 必须是 low、medium 或 high/,
  );
});

/* ── 诊断评价与持久化 ───────────────────────────────────────── */

test("evaluateDiagnostic：统计高置信错误与记录数，未答不计入", () => {
  const evaluation = evaluateDiagnostic(
    QUESTIONS,
    { q1: 0, q2: 0 },
    1_000,
    { q1: "low", q2: "high", q3: "high" },
  );
  // q1 答对但把握低；q2 答错且很确定 → 高置信错误；q3 未答不计。
  assert.equal(evaluation.confidenceRecorded, 2);
  assert.equal(evaluation.highConfidenceErrors, 1);
  assert.equal(evaluation.recommendedStepIndex, 1);
  assert.ok(
    evaluation.evidenceSummary.some((line) => line.includes("高置信错误")),
    "证据摘要要显式指出高置信错误",
  );
});

test("evaluateDiagnostic：未知题与非法置信度都拒绝", () => {
  assert.throws(
    () => evaluateDiagnostic(QUESTIONS, { q1: 0 }, 1_000, { q9: "high" }),
    /置信度记录包含未知题 q9/,
  );
  assert.throws(
    () =>
      evaluateDiagnostic(QUESTIONS, { q1: 0 }, 1_000, {
        q1: "certain" as never,
      }),
    /置信度必须是 low\/medium\/high/,
  );
});

test("submitDiagnostic：持久化置信度与统计，报告比例按已记录题数计算", () => {
  const profile = createDiagnosticProfile(
    { topic: "现金分红", level: "初学", questions: QUESTIONS, answers: {}, submitted: false },
    { now: 1_000, newId: () => "diag-1" },
  );
  const evaluated = submitDiagnostic(
    profile,
    { q1: 0, q2: 0 },
    2_000,
    { q1: "low", q2: "high" },
  );
  assert.deepEqual(evaluated.confidence, { q1: "low", q2: "high" });
  assert.equal(evaluated.confidenceRecorded, 2);
  assert.equal(evaluated.highConfidenceErrors, 1);
  assert.equal(highConfidenceErrorRatio(evaluated), 0.5);
  assert.equal(highConfidenceErrorRatio({}), 0, "没有置信度记录时不能编造比例");

  // 提交后仍是一份结构完整的诊断画像，可进入备份/同步。
  assert.doesNotThrow(() => validateDiagnosticProfile(evaluated));
});

test("validateDiagnosticProfile：校验可选置信度、计数与探测目标", () => {
  const profile = createDiagnosticProfile(
    { topic: "现金分红", level: "初学", questions: QUESTIONS, answers: {}, submitted: false },
    { now: 1_000, newId: () => "diag-1" },
  );
  assert.throws(
    () => validateDiagnosticProfile({ ...profile, confidence: { q9: "high" } }),
    /置信度记录包含未知题 q9/,
  );
  assert.throws(
    () => validateDiagnosticProfile({ ...profile, highConfidenceErrors: -1 }),
    /highConfidenceErrors 必须是非负整数/,
  );
  assert.throws(
    () =>
      validateDiagnosticProfile({
        ...profile,
        probeTargets: [{ questionId: "q1", statement: "" }],
      }),
    /探测目标/,
  );
  // 旧诊断缺省新字段仍合法。
  assert.doesNotThrow(() => validateDiagnosticProfile(profile));
});

/* ── 先验探测目标 ───────────────────────────────────────────── */

test("priorProbeTargets：只选未过期的已理解前置，按核验时间倒序并限量", () => {
  const older = proposition("a", "总额", "understood", 100);
  const newer = proposition("b", "差额", "understood", 300);
  const applied = proposition("c", "净值", "applied", 400);
  const orphan = proposition("d", "无关概念", "understood", 500);
  const deleted = proposition("e", "已删除前置", "understood", 600);
  const graph: KnowledgeGraph = {
    ...graphOf([older, newer, applied, orphan, deleted], ["a", "b", "c"]),
    deletedPropositionIds: ["e"],
  };

  const targets = priorProbeTargets(graph);
  assert.deepEqual(targets.map((item) => item.id), ["b", "a"]);
  assert.deepEqual(priorProbeTargets(graph, 1).map((item) => item.id), ["b"]);
  assert.deepEqual(priorProbeTargets(graph, 0), []);
});

test("selectDiagnosticQuestions：支持动态题数但仍按模型原顺序截取", () => {
  const two = selectDiagnosticQuestions(QUESTIONS, 2);
  assert.deepEqual(two.map((question) => question.id), ["q1", "q2"]);
  const all = selectDiagnosticQuestions(QUESTIONS);
  assert.deepEqual(all.map((question) => question.id), ["q1", "q2", "q3"]);
});

/* ── 高置信错误必须原地修复 ─────────────────────────────────── */

function highConfidenceRequest(): ChatRequest {
  const state = stateWithQuestion();
  const request = requestFor(state, "我把现金分红当成新增收益了");
  request.answerConfidence = "high";
  return request;
}

test("checkTutorDraft：高置信错误推进时触发修复门禁", () => {
  const state = stateWithQuestion();
  const request = highConfidenceRequest();
  const advancing = draftFor(state, {
    intent: "answer",
    move: "repair",
    focusStepId: "step-2",
    misconception: "把现金分红当成新增收益",
    assessment: answerFor(state, "我把现金分红当成新增收益了", "incorrect", "none"),
    navigation: { kind: "advance", targetStepId: "step-2" },
  });
  const codes = checkTutorDraft(request, advancing).map((issue) => issue.code);
  assert.ok(
    codes.includes("high_confidence_error_requires_repair"),
    "高置信错误推进必须被明确拦下",
  );

  const noMisconception = draftFor(state, {
    intent: "answer",
    move: "repair",
    assessment: answerFor(state, "我把现金分红当成新增收益了", "incorrect", "none"),
  });
  assert.ok(
    checkTutorDraft(request, noMisconception)
      .map((issue) => issue.code)
      .includes("high_confidence_error_requires_repair"),
    "缺少误区记录的高置信错误同样不能通过",
  );
});

test("checkTutorDraft：高置信错误在原地修复并记录误区时不触发该门禁", () => {
  const state = stateWithQuestion();
  const request = highConfidenceRequest();
  const repairing = draftFor(state, {
    intent: "answer",
    move: "repair",
    misconception: "把现金分红当成新增收益",
    assessment: answerFor(state, "我把现金分红当成新增收益了", "incorrect", "none"),
  });
  assert.ok(
    !checkTutorDraft(request, repairing)
      .map((issue) => issue.code)
      .includes("high_confidence_error_requires_repair"),
  );

  // 同一份草稿在中/低置信时不应触发本门禁（旧客户端不传也合法）。
  const withoutConfidence = requestFor(state, "我把现金分红当成新增收益了");
  assert.ok(
    !checkTutorDraft(withoutConfidence, repairing)
      .map((issue) => issue.code)
      .includes("high_confidence_error_requires_repair"),
  );
});

test("组合统计：高置信错误比例只用于校准，不能当作掌握证据", () => {
  const profile: Pick<DiagnosticProfile, "highConfidenceErrors" | "confidenceRecorded"> = {
    highConfidenceErrors: 2,
    confidenceRecorded: 4,
  };
  assert.equal(highConfidenceErrorRatio(profile), 0.5);
  // 答对但低置信不会被算进高置信错误；该函数不做任何掌握判定。
  assert.equal(highConfidenceErrorRatio({ highConfidenceErrors: 0, confidenceRecorded: 3 }), 0);
});

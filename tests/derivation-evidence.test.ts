import assert from "node:assert/strict";
import test from "node:test";
import {
  hasDerivationChain,
  hasIndependentReasoning,
  hasPriorReasoning,
  parseLearningState,
} from "../src/lib/learningState";
import type { LearningEvidence } from "../src/types";

const evidence = (overrides: Partial<LearningEvidence>): LearningEvidence => ({
  quote: "学习者原话",
  questionId: "q1",
  question: "题干一",
  kind: "reasoning",
  turn: 1,
  ...overrides,
});

test("一句结论复述（单条 reasoning）不能构成 understood 的证据基础", () => {
  const items = [evidence({})];
  assert.equal(hasDerivationChain(items), false);
  assert.equal(hasIndependentReasoning(items), false);
});

test("完整推导链（derivation + chain）满足 understood 的证据基础", () => {
  const items: LearningEvidence[] = [
    evidence({
      kind: "derivation",
      chain: { premises: ["割线斜率随接近而变化", "变化率是极限"], conclusion: "导数是瞬时变化率" },
    }),
  ];
  assert.equal(hasDerivationChain(items), true);
});

test("两条不同题干的独立 reasoning 也满足 understood 的证据基础", () => {
  const items = [
    evidence({ questionId: "q1", question: "解释单位净值为什么会下降" }),
    evidence({ questionId: "q2", question: "解释分红对资产池的影响", turn: 3 }),
  ];
  assert.equal(hasDerivationChain(items), false);
  assert.equal(hasIndependentReasoning(items), true);
});

test("同题换 ID 不构成独立推理：题干相同仅改题号不能冒充新问题", () => {
  const items = [
    evidence({ questionId: "q1", question: "解释分红对净值的影响" }),
    evidence({ questionId: "q2", question: "解释分红对净值的影响", turn: 4 }),
  ];
  assert.equal(hasIndependentReasoning(items), false);
  // 迁移题与既有推理题干相同时同样不算“另一题上的解释”。
  assert.equal(hasPriorReasoning(items, "q3", "解释分红对净值的影响"), false);
});

test("derivation 证据参与 hasPriorReasoning：推导链可作为迁移前置", () => {
  const items = [
    evidence({
      kind: "derivation",
      questionId: "qd",
      question: "从前提推出导数定义并给出边界",
      chain: { premises: ["割线斜率", "极限"], conclusion: "导数是瞬时变化率" },
    }),
  ];
  assert.equal(hasPriorReasoning(items, "q-new", "在收益曲线场景应用瞬时变化率"), true);
});

test("understood 步骤缺推导链与独立推理时被 parseLearningState 拒绝", () => {
  const bad = {
    version: 1,
    revision: 2,
    goal: "理解导数",
    steps: [
      { id: "s1", title: "导数定义", mastery: "understood", evidence: [evidence({})] },
    ],
    currentStepId: "s1",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: null,
    lastMove: null,
  };
  assert.throws(() => parseLearningState(bad), /unproven_mastery|完整推导链|独立解释证据/);
});

test("understood 步骤带推导链时通过解析（旧状态兼容：chain 可缺省）", () => {
  const good = {
    version: 1,
    revision: 2,
    goal: "理解导数",
    steps: [
      {
        id: "s1",
        title: "导数定义",
        mastery: "understood",
        evidence: [
          evidence({
            kind: "derivation",
            chain: { premises: ["割线斜率趋于定值", "极限存在"], conclusion: "导数是瞬时变化率" },
          }),
        ],
      },
    ],
    currentStepId: "s1",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: null,
    lastMove: null,
  };
  const parsed = parseLearningState(good);
  assert.equal(parsed?.steps[0].mastery, "understood");
  assert.equal(parsed?.steps[0].evidence[0].chain?.conclusion, "导数是瞬时变化率");
});

test("旧数据证据无 chain 字段仍可解析：recognition/transfer 证据不受影响", () => {
  const legacy = {
    version: 1,
    revision: 8,
    goal: "理解导数",
    steps: [
      { id: "s1", title: "导数定义", mastery: "learning", evidence: [evidence({ kind: "recognition" })] },
      {
        id: "s2",
        title: "应用",
        mastery: "applied",
        evidence: [
          evidence({ kind: "derivation", questionId: "qd", question: "推导并给边界", turn: 3, chain: { premises: ["a", "b"], conclusion: "c" } }),
          evidence({ kind: "transfer", questionId: "qt", question: "新情境迁移", turn: 6 }),
        ],
      },
    ],
    currentStepId: "s2",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: null,
    lastMove: null,
  };
  const parsed = parseLearningState(legacy);
  assert.equal(parsed?.steps[1].mastery, "applied");
  assert.equal(parsed?.steps[0].evidence[0].chain, undefined);
});

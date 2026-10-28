import assert from "node:assert/strict";
import test from "node:test";
import type { QuizQuestion } from "../src/types";
import {
  createDiagnosticProfile,
  evaluateDiagnostic,
  isDiagnosticProfile,
  submitDiagnostic,
  validateDiagnosticProfile,
} from "../src/lib/diagnostic";

const NOW = 1_700_000_000_000;

function ids(): () => string {
  let n = 0;
  return () => `diag-${++n}`;
}

function question(
  id: string,
  question: string,
  options: string[],
  correctIndex: number,
  hint = "回忆定义",
): QuizQuestion {
  return {
    id,
    question,
    options,
    correctIndex,
    explanation: `正确答案：${options[correctIndex]}。`,
    hint,
  };
}

const QUESTIONS: QuizQuestion[] = [
  question("d1", "什么是函数的定义域？", ["自变量的取值范围", "因变量的取值范围"], 0),
  question("d2", "二次函数的对称轴公式？", ["x=-b/2a", "x=b/2a"], 0),
  question("d3", "判别式 b²-4ac<0 说明什么？", ["无实根", "两个实根"], 0),
];

test("评价全部答对的诊断：可跳过已识别前置，但不认证推理掌握", () => {
  const evaluation = evaluateDiagnostic(
    QUESTIONS,
    { d1: 0, d2: 0, d3: 0 },
    NOW,
  );
  assert.equal(evaluation.evaluatedAt, NOW);
  assert.deepEqual(evaluation.weakConcepts, []);
  assert.deepEqual(
    evaluation.skippedConcepts,
    QUESTIONS.map((q) => q.question),
  );
  // 全对给出靠后起点（题数封顶 2）
  assert.equal(evaluation.recommendedStepIndex, 2);
  // 证据明确区分识别与推理
  assert.ok(
    evaluation.evidenceSummary.every((line) => line.includes("识别正确")),
  );
  assert.ok(
    evaluation.evidenceSummary.some((line) =>
      line.includes("不能仅凭选项点击认定掌握"),
    ),
  );
});

test("评价部分答错的诊断：弱项归类并从第一个错误题进入", () => {
  const evaluation = evaluateDiagnostic(
    QUESTIONS,
    { d1: 0, d2: 1, d3: 0 },
    NOW,
  );
  assert.deepEqual(evaluation.weakConcepts, ["二次函数的对称轴公式？"]);
  assert.deepEqual(evaluation.skippedConcepts, [
    "什么是函数的定义域？",
    "判别式 b²-4ac<0 说明什么？",
  ]);
  assert.equal(evaluation.recommendedStepIndex, 1);
  assert.ok(
    evaluation.evidenceSummary.some((line) =>
      line.includes("二次函数的对称轴公式"),
    ),
  );
  assert.ok(evaluation.evidenceSummary.some((line) => line.includes("答错")));
});

test("未作答的题不臆测水平：记录证据缺口并把起点回退到该题", () => {
  const evaluation = evaluateDiagnostic(
    QUESTIONS,
    { d1: 0, d3: 0 },
    NOW,
  );
  assert.deepEqual(evaluation.weakConcepts, []);
  assert.ok(
    evaluation.evidenceSummary.some((line) => line.includes("d2") === false),
  );
  assert.ok(
    evaluation.evidenceSummary.some((line) => line.includes("未作答")),
  );
  assert.equal(evaluation.recommendedStepIndex, 1);
  // d3 答对不算弱项，但未答的 d2 已经把起点拉回
  assert.ok(!evaluation.skippedConcepts.includes("d2"));
  assert.ok(evaluation.skippedConcepts.includes("判别式 b²-4ac<0 说明什么？"));
});

test("越界作答与未知题 ID 拒绝评价", () => {
  assert.throws(
    () => evaluateDiagnostic(QUESTIONS, { d1: 7, d2: 0, d3: 0 }, NOW),
    /越界/,
  );
  assert.throws(
    () => evaluateDiagnostic(QUESTIONS, { d1: 0, d2: 0, d3: 0, dX: 1 }, NOW),
    /未知题/,
  );
  assert.throws(
    () => evaluateDiagnostic(QUESTIONS, { d1: 0.5, d2: 0, d3: 0 }, NOW),
    /越界/,
  );
});

test("空题集与非法时刻拒绝评价", () => {
  assert.throws(() => evaluateDiagnostic([], {}, NOW), /不能为空/);
  assert.throws(
    () => evaluateDiagnostic(QUESTIONS, { d1: 0, d2: 0, d3: 0 }, Number.NaN),
    /now/,
  );
  assert.throws(
    () => evaluateDiagnostic(QUESTIONS, { d1: 0, d2: 0, d3: 0 }, -1),
    /now/,
  );
});

test("创建诊断画像：初始未提交、ID 注入、题集被复制", () => {
  const profile = createDiagnosticProfile(
    { topic: "二次函数", level: "从零开始", questions: QUESTIONS, answers: {}, submitted: false },
    { now: NOW, newId: ids() },
  );
  assert.equal(profile.id, "diag-1");
  assert.equal(profile.topic, "二次函数");
  assert.equal(profile.level, "从零开始");
  assert.equal(profile.submitted, false);
  assert.deepEqual(profile.answers, {});
  assert.equal(profile.recommendedStepIndex, 0);
  assert.deepEqual(profile.weakConcepts, []);
  assert.deepEqual(profile.skippedConcepts, []);
  // 返回的题目对象是拷贝
  assert.notEqual(profile.questions[0], QUESTIONS[0]);
  assert.deepEqual(profile.questions, QUESTIONS);

  assert.throws(
    () =>
      createDiagnosticProfile(
        { topic: "", level: "从零开始", questions: QUESTIONS, answers: {}, submitted: false },
        { now: NOW, newId: ids() },
      ),
    /topic/,
  );
  assert.throws(
    () =>
      createDiagnosticProfile(
        { topic: "二次函数", level: "从零开始", questions: [], answers: {}, submitted: false },
        { now: NOW, newId: ids() },
      ),
    /不能为空/,
  );
});

test("提交诊断：真实作答翻转 submitted 并写入评价结果", () => {
  const profile = createDiagnosticProfile(
    { topic: "二次函数", level: "从零开始", questions: QUESTIONS, answers: {}, submitted: false },
    { now: NOW, newId: ids() },
  );
  const submitted = submitDiagnostic(
    profile,
    { d1: 0, d2: 1, d3: 0 },
    NOW + 1000,
  );
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.evaluatedAt, NOW + 1000);
  assert.deepEqual(submitted.answers, { d1: 0, d2: 1, d3: 0 });
  assert.equal(submitted.recommendedStepIndex, 1);
  assert.deepEqual(submitted.weakConcepts, ["二次函数的对称轴公式？"]);
  assert.ok(submitted.evidenceSummary.length === QUESTIONS.length);
  // 原画像未被原地修改
  assert.equal(profile.submitted, false);
});

test("重复提交、越界与未知题 ID 的提交均被拒绝", () => {
  const profile = createDiagnosticProfile(
    { topic: "二次函数", level: "从零开始", questions: QUESTIONS, answers: {}, submitted: false },
    { now: NOW, newId: ids() },
  );
  const submitted = submitDiagnostic(
    profile,
    { d1: 0, d2: 0, d3: 0 },
    NOW + 1000,
  );
  assert.throws(
    () => submitDiagnostic(submitted, { d1: 0, d2: 0, d3: 0 }, NOW + 2000),
    /重复/,
  );
  assert.throws(
    () => submitDiagnostic(profile, { d1: 9, d2: 0, d3: 0 }, NOW + 1000),
    /越界/,
  );
  assert.throws(
    () => submitDiagnostic(profile, { d1: 0, d2: 0, d3: 0, zzz: 0 }, NOW + 1000),
    /未知题/,
  );
  assert.throws(
    () => submitDiagnostic(profile, "not-a-record" as never, NOW + 1000),
    /对象/,
  );
});

test("isDiagnosticProfile 校验备份还原的画像结构", () => {
  const profile = createDiagnosticProfile(
    { topic: "二次函数", level: "从零开始", questions: QUESTIONS, answers: {}, submitted: false },
    { now: NOW, newId: ids() },
  );
  assert.equal(isDiagnosticProfile(profile), true);
  assert.equal(isDiagnosticProfile({ ...profile, id: "" }), false);
  assert.equal(isDiagnosticProfile({ ...profile, answers: [] }), false);
  assert.equal(
    isDiagnosticProfile({ ...profile, recommendedStepIndex: -1 }),
    false,
  );
  assert.equal(isDiagnosticProfile({ ...profile, submitted: "yes" }), false);
  assert.equal(isDiagnosticProfile(null), false);
  assert.equal(isDiagnosticProfile("profile"), false);
});

test("validateDiagnosticProfile 深度校验题目与作答关联", () => {
  const profile = createDiagnosticProfile(
    { topic: "二次函数", level: "从零开始", questions: QUESTIONS, answers: {}, submitted: false },
    { now: NOW, newId: ids() },
  );
  assert.doesNotThrow(() => validateDiagnosticProfile(profile));
  assert.throws(
    () => validateDiagnosticProfile({ ...profile, answers: { "not-a-question": 0 } }),
    /未知题/,
  );
  assert.throws(
    () => validateDiagnosticProfile({ ...profile, answers: { d1: 9 } }),
    /越界/,
  );
  assert.throws(
    () =>
      validateDiagnosticProfile({
        ...profile,
        questions: [{ ...profile.questions[0], options: ["唯一"] }],
      }),
    /选项不完整/,
  );
  assert.throws(
    () => validateDiagnosticProfile({ ...profile, weakConcepts: [1] }),
    /字符串数组/,
  );
});

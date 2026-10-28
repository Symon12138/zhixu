import assert from "node:assert/strict";
import test from "node:test";
import type { ChatRequest, LearningState } from "../src/types";
import {
  buildSeedState,
  evaluateTurnChecks,
  loadSuite,
  REQUIRED_COVERAGE,
  summarizeRun,
  type CaseReport,
  type EvalCase,
  type EvalCheckResult,
  type TurnObservation,
} from "../scripts/eval-teaching";
import {
  runTeachingTurn,
  TeachingQualityError,
  type ModelInvoker,
} from "../server/tutor";

/**
 * 教学发布门禁的自测：全部使用受控模型响应，经真实 server/tutor 编排（草稿 → 独立评审 →
 * 提交状态），再交给 eval-teaching 的纯检查函数。不创建 model invoker，也不发网络请求。
 */

const suite = loadSuite();
const defaults = suite.defaults;

const passingChecks = {
  responsive: true,
  assessment: true,
  scaffolding: true,
  continuity: true,
  calibration: true,
} as const;

function caseById(id: string): EvalCase {
  const found = suite.cases.find((item) => item.id === id);
  assert.ok(found, `缺少用例 ${id}`);
  return found;
}

function seedOf(item: EvalCase): LearningState {
  const seed = item.seed;
  assert.ok(seed, `用例 ${item.id} 缺少种子状态`);
  return buildSeedState(seed);
}

function requestFor(
  item: EvalCase,
  learner: string,
  action: ChatRequest["action"] = "message",
): ChatRequest {
  const seed = item.seed ? buildSeedState(item.seed) : undefined;
  return {
    topic: item.topic ?? defaults.topic,
    level: item.level ?? defaults.level,
    goal: item.goal ?? defaults.goal,
    action,
    messages: [
      ...(item.seed?.history ?? []),
      ...(learner ? [{ role: "user" as const, content: learner }] : []),
    ],
    ...(seed ? { learningState: seed } : {}),
  };
}

function reviewOf(decision?: unknown): string {
  return JSON.stringify({
    verdict: "pass",
    checks: passingChecks,
    issues: [],
    ...(decision === undefined ? {} : { decision }),
  });
}

/** 受控响应：draft/repair 返回同一原稿，review 返回指定评审。 */
function controlledInvoker(draft: string, review: string): ModelInvoker {
  return async ({ purpose }) => (purpose === "review" ? review : draft);
}

function failedChecks(checks: EvalCheckResult[]): EvalCheckResult[] {
  return checks.filter((check) => !check.passed);
}

/** assert.rejects 的校验器不会自动收窄 unknown，这里显式收窄为教学门禁错误。 */
function qualityRejection(error: unknown): TeachingQualityError {
  if (error instanceof TeachingQualityError) return error;
  throw new Error(`预期教学门禁拒绝，实际：${error instanceof Error ? error.message : String(error)}`);
}

function observationOf(
  request: ChatRequest,
  message: string,
  state: LearningState,
): TurnObservation {
  return {
    request,
    previousState: state,
    response: { message, learningState: state },
  };
}

test("套件种子状态合法，覆盖发布门禁要求的全部场景", () => {
  for (const item of suite.cases) {
    const seed = item.seed;
    if (!seed) continue;
    const state = buildSeedState(seed);
    assert.ok(state.steps.length >= 3, `${item.id} 的种子路线过短`);
    assert.ok(state.revision >= 1, `${item.id} 的种子轮次无效`);
  }
  const covers = new Set(suite.cases.flatMap((item) => item.covers));
  for (const required of REQUIRED_COVERAGE) {
    assert.ok(covers.has(required), `套件缺少覆盖：${required}`);
  }
});

test("跨学科套件保持多主题和多动作覆盖", () => {
  const broad = loadSuite("eval/teaching-suite-broad.json");
  const topics = new Set(broad.cases.map((item) => item.topic).filter(Boolean));
  assert.ok(topics.size >= 7, `跨学科主题不足：${[...topics].join("、")}`);
  assert.ok(broad.cases.length >= 8, "跨学科用例不足");
  const actions = new Set(broad.cases.flatMap((item) => item.turns.map((turn) => turn.action)));
  for (const action of ["start", "message", "summary", "resume"]) {
    assert.ok(actions.has(action as ChatRequest["action"]), `跨学科套件缺少动作：${action}`);
  }
  assert.ok(
    broad.cases.some((item) => item.covers.includes("detour_return")),
    "跨学科套件缺少多回合插问/恢复覆盖",
  );
  for (const item of broad.cases) {
    if (item.seed) buildSeedState(item.seed);
  }
});

test("结构检查接受带单位的私有数值答案", () => {
  const item = caseById("numeric-error");
  const seed = seedOf(item);
  const active = {
    ...seed.pendingQuestion!,
    protectedAnswers: ["1.05 元", "1.10 元"],
  };
  const next = { ...seed, pendingQuestion: active };
  const request = requestFor(item, "单位净值 1.05 元，累计净值 1.10 元。");
  const check = evaluateTurnChecks(
    ["question_identity"],
    {
      request,
      previousState: seed,
      response: { message: "先核对关系，再检查单位。", learningState: next },
    },
    { learnerText: "单位净值 1.05 元，累计净值 1.10 元。" },
  ).find((item) => item.id === "question_identity");
  assert.ok(check);
  assert.equal(check.passed, true, check.detail);
});

test("未运行任何用例时只能是跳过，不能报告通过", () => {
  const skipped = summarizeRun([]);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.exitCode, 2);

  const base = { id: "case", title: "用例", covers: [], durationMs: 0, turns: [] };
  const passed: CaseReport = { ...base, status: "passed" };
  const failed: CaseReport = { ...base, status: "failed" };
  const errored: CaseReport = { ...base, status: "error" };
  assert.equal(summarizeRun([passed]).exitCode, 0);
  assert.equal(summarizeRun([failed]).exitCode, 1);
  assert.equal(summarizeRun([errored]).exitCode, 3);
  assert.equal(summarizeRun([failed, errored]).exitCode, 3);
});

test("数值与证据正确时通过全部结构断言", async () => {
  const item = caseById("numeric-error");
  const seed = seedOf(item);
  const learner = "单位净值1.05，累计净值还是1.10；这0.05从产品资产池转到客户现金账户。";
  const request = requestFor(item, learner);
  const draft = JSON.stringify({
    message: "对。分红只是把产品里的现金交给持有人：产品资产减少，客户现金等额增加。",
    question: null,
    sources: [],
    assumptions: [],
  });
  const response = await runTeachingTurn(
    request,
    controlledInvoker(
      draft,
      reviewOf({
        intent: "answer",
        move: "explain",
        navigation: { kind: "stay" },
        assessment: {
          verdict: "correct",
          demonstrated: "reasoning",
          evidenceQuote: learner,
          feedback: "资金方向与两种净值的处理都正确。",
        },
      }),
    ),
    { timeoutMs: 5_000 },
  );
  const checks = evaluateTurnChecks(
    ["question_identity", "evidence_verbatim", "no_answer_leak", "numeric_gate"],
    { request, response, previousState: seed },
    { learnerText: learner, groundTruthNumbers: item.groundTruth?.numbers },
  );
  assert.deepEqual(failedChecks(checks), []);
  const state = response.learningState;
  assert.ok(state);
  assert.equal(state.revision, seed.revision + 1);
  assert.equal(state.steps[0].mastery, "understood");
  assert.equal(state.steps[0].evidence.at(-1)?.quote, learner);
  assert.equal(state.pendingQuestion, null);
});

test("讲解泄露未解出的数值会被断言捕获并被管线拦下", async () => {
  const item = caseById("numeric-error");
  const seed = seedOf(item);
  const learner = "单位净值=1.10−0.05=1.02，累计净值=1.10+0.05=1.15。";
  const request = requestFor(item, learner);

  const leakedObservation = observationOf(request, "正确答案是单位净值1.05。", seed);
  const leakCheck = evaluateTurnChecks(["no_answer_leak"], leakedObservation, {
    learnerText: learner,
    groundTruthNumbers: item.groundTruth?.numbers,
  }).find((check) => check.id === "no_answer_leak");
  assert.ok(leakCheck);
  assert.equal(leakCheck.passed, false);
  assert.match(leakCheck.detail, /1\.05/);

  const draft = JSON.stringify({
    message: "你算的1.02不对：单位净值应为1.05，因为0.05从资产池转出。",
    question: {
      prompt: "如果每份分红变成0.08，分红前单位净值1.20，单位净值会怎样变化？",
      kind: "reasoning",
      options: [],
      successCriteria: ["说明单位净值扣除0.08后的变化方向"],
    },
    sources: [],
    assumptions: [],
  });
  await assert.rejects(
    runTeachingTurn(
      request,
      controlledInvoker(
        draft,
        reviewOf({
          intent: "answer",
          move: "repair",
          navigation: { kind: "stay" },
          assessment: {
            verdict: "partial",
            demonstrated: "recognition",
            evidenceQuote: learner,
            feedback: "方向对，数值需要再核对。",
          },
          misconception: "把现金分红当成净值增加，未扣除已转出的现金",
        }),
      ),
      { timeoutMs: 5_000 },
    ),
    (error: unknown) => {
      const rejection = qualityRejection(error);
      assert.ok(
        rejection.issues.some((issue) => issue.code === "answer_revealed"),
        JSON.stringify(rejection.issues),
      );
      return true;
    },
  );
});

test("复盘声称已核验但没有任何证据时失败，诚实复盘通过", async () => {
  const item = caseById("recap-separation");
  const seed = seedOf(item);
  const request = requestFor(item, "", "summary");
  const overclaim = "本次已经核验你已掌握现金分红和净值机制，下次从数值核对继续。";

  await assert.rejects(
    runTeachingTurn(
      request,
      controlledInvoker(JSON.stringify({ message: overclaim, sources: [] }), reviewOf()),
      { timeoutMs: 5_000 },
    ),
    (error: unknown) => {
      const rejection = qualityRejection(error);
      assert.ok(
        rejection.issues.some((issue) => issue.code === "unverified_summary_claim"),
        JSON.stringify(rejection.issues),
      );
      return true;
    },
  );

  const rejectedProbe = evaluateTurnChecks(
    ["recap_separation"],
    observationOf(request, overclaim, seed),
    { learnerText: "" },
  ).find((check) => check.id === "recap_separation");
  assert.ok(rejectedProbe);
  assert.equal(rejectedProbe.passed, false);

  const honest =
    "本次讲过了现金分红为什么让单位净值下降，也解释了累计净值把历史现金加回。这部分你还没有独立作答核验，下次先从单位净值的变化说清楚。";
  const acceptedProbe = evaluateTurnChecks(
    ["recap_separation"],
    observationOf(request, honest, seed),
    { learnerText: "" },
  ).find((check) => check.id === "recap_separation");
  assert.ok(acceptedProbe);
  assert.equal(acceptedProbe.passed, true, acceptedProbe.detail);

  const honestWithHeading =
    "**本次讲过**：现金分红为什么让单位净值下降，以及累计净值把历史现金加回。\n**已核验的内容**：目前没有独立证据，仍需你用自己的话核验；下次从单位净值的变化开始。";
  const headingProbe = evaluateTurnChecks(
    ["recap_separation"],
    observationOf(request, honestWithHeading, seed),
    { learnerText: "" },
  ).find((check) => check.id === "recap_separation");
  assert.ok(headingProbe);
  assert.equal(headingProbe.passed, true, headingProbe.detail);

  const questionHeading =
    "**本次讲过**：现金分红为什么让单位净值下降，以及累计净值把历史现金加回。\n**已核验什么**：目前没有独立证据，仍需你用自己的话核验；下次从单位净值的变化开始。";
  const questionProbe = evaluateTurnChecks(
    ["recap_separation"],
    observationOf(request, questionHeading, seed),
    { learnerText: "" },
  ).find((check) => check.id === "recap_separation");
  assert.ok(questionProbe);
  assert.equal(questionProbe.passed, true, questionProbe.detail);
});

test("模型把算错的数值判为正确时，发布前被数值闸门拒绝，独立核算也能识别", async () => {
  const item = caseById("numeric-error");
  const seed = seedOf(item);
  const learner = "单位净值=1.10−0.05=1.02，累计净值=1.10+0.05=1.15。";
  const request = requestFor(item, learner);
  const draft = JSON.stringify({
    message: "你抓住了现金从资产池转出的方向，再核对一下加减关系。",
    question: {
      prompt: "如果每份分红是0.08，分红前单位净值1.20，单位净值会变成多少？",
      kind: "calculation",
      options: [],
      successCriteria: ["单位净值1.12"],
      protectedAnswers: ["1.12"],
    },
    sources: [],
    assumptions: [],
  });
  await assert.rejects(
    runTeachingTurn(
      request,
      controlledInvoker(
        draft,
        reviewOf({
          intent: "answer",
          move: "repair",
          navigation: { kind: "stay" },
          assessment: {
            verdict: "correct",
            demonstrated: "reasoning",
            evidenceQuote: learner,
            feedback: "方向与运算都正确。",
          },
        }),
      ),
      { timeoutMs: 5_000 },
    ),
    (error: unknown) =>
      error instanceof TeachingQualityError &&
      error.issues.some((item) => item.code === "numeric_mismatch"),
  );
  const forged = structuredClone(seed);
  forged.revision += 1;
  forged.lastAssessment = {
    verdict: "correct",
    evidenceQuote: learner,
    questionId: seed.pendingQuestion!.id,
    demonstrated: "reasoning",
    feedback: "方向与运算都正确。",
  };
  forged.steps[0].evidence.push({
    quote: learner,
    questionId: seed.pendingQuestion!.id,
    question: seed.pendingQuestion!.prompt,
    kind: "reasoning",
    turn: forged.revision,
  });
  const numeric = evaluateTurnChecks(
    ["numeric_gate"],
    { request, response: { message: "伪造的正确判定", learningState: forged }, previousState: seed },
    { learnerText: learner, groundTruthNumbers: item.groundTruth?.numbers },
  ).find((check) => check.id === "numeric_gate");
  assert.ok(numeric);
  assert.equal(numeric.passed, false);
  assert.match(numeric.detail, /数值/);
});

test("同题换编号冒充迁移被编排拒绝，伪造迁移状态被断言捕获", async () => {
  const item = caseById("same-prompt-new-id");
  const seed = seedOf(item);
  const learner = "单位净值1.05，累计净值1.10，因为0.05从产品资产池转成了客户现金。";
  const request = requestFor(item, learner);
  const draft = JSON.stringify({
    message: "你这次的数值和上次一样，说明已经能在新情境中迁移了。",
    question: null,
    sources: [],
    assumptions: [],
  });
  await assert.rejects(
    runTeachingTurn(
      request,
      controlledInvoker(
        draft,
        reviewOf({
          intent: "answer",
          move: "explain",
          navigation: { kind: "stay" },
          assessment: {
            verdict: "correct",
            demonstrated: "transfer",
            evidenceQuote: learner,
            feedback: "同题复核通过。",
          },
        }),
      ),
      { timeoutMs: 5_000 },
    ),
    (error: unknown) => {
      const rejection = qualityRejection(error);
      assert.ok(
        rejection.issues.some((issue) => issue.code === "not_a_transfer_probe"),
        JSON.stringify(rejection.issues),
      );
      return true;
    },
  );

  const prior = seed.steps[0].evidence[0];
  const forged = structuredClone(seed);
  forged.steps[0].evidence.push({
    quote: learner,
    questionId: "q-calc-2",
    question: prior.question,
    kind: "transfer",
    turn: seed.revision,
  });
  const forgedCheck = evaluateTurnChecks(
    ["no_forged_transfer"],
    observationOf(request, "迁移通过。", forged),
    { learnerText: learner },
  ).find((check) => check.id === "no_forged_transfer");
  assert.ok(forgedCheck);
  assert.equal(forgedCheck.passed, false);

  const applied = structuredClone(forged);
  applied.steps[0].mastery = "applied";
  const appliedChecks = evaluateTurnChecks(
    ["no_forged_transfer"],
    observationOf(request, "已应用。", applied),
    { learnerText: learner },
  );
  assert.equal(
    appliedChecks.find((check) => check.id === "structured_state")?.passed,
    false,
    "同题证据不能满足 applied 的结构校验",
  );
});

test("选择题只能留下辨认证据，冒充推理会被拒绝", async () => {
  const item = caseById("choice-is-not-reasoning");
  const seed = seedOf(item);
  const request = requestFor(item, "1");
  const draft = JSON.stringify({
    message: "对，现金来自产品资产池里已实现的收益。",
    question: null,
    sources: [],
    assumptions: [],
  });

  await assert.rejects(
    runTeachingTurn(
      request,
      controlledInvoker(
        draft,
        reviewOf({
          intent: "answer",
          move: "explain",
          navigation: { kind: "stay" },
          assessment: {
            verdict: "correct",
            demonstrated: "reasoning",
            evidenceQuote: "1",
            feedback: "能解释来源。",
          },
        }),
      ),
      { timeoutMs: 5_000 },
    ),
    (error: unknown) => {
      const rejection = qualityRejection(error);
      assert.ok(
        rejection.issues.some((issue) => issue.code === "choice_is_not_reasoning"),
        JSON.stringify(rejection.issues),
      );
      return true;
    },
  );

  const accepted = await runTeachingTurn(
    request,
    controlledInvoker(
      draft,
      reviewOf({
        intent: "answer",
        move: "explain",
        navigation: { kind: "stay" },
        assessment: {
          verdict: "correct",
          demonstrated: "recognition",
          evidenceQuote: "1",
          feedback: "辨认正确，还没有解释机制。",
        },
      }),
    ),
    { timeoutMs: 5_000 },
  );
  const checks = evaluateTurnChecks(
    ["choice_not_reasoning", "evidence_verbatim"],
    { request, response: accepted, previousState: seed },
    { learnerText: "1" },
  );
  assert.deepEqual(failedChecks(checks), []);
  assert.equal(accepted.learningState?.steps[0].mastery, "learning");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ChatRequest,
  ChatResponse,
  LearningState,
  TeachingReceipt,
} from "../src/types";
import { propositionId } from "../src/lib/knowledgeGraph";
import {
  buildBookFixture,
  buildSeedState,
  evaluateOutcomeCase,
  evaluateTurnChecks,
  EVAL_CHECKS,
  loadOutcomeSuite,
  loadSuite,
  missingCoverage,
  REQUIRED_COVERAGE,
  scoreOutcomeTest,
  summarizeAttempts,
  summarizeOutcome,
  summarizeRun,
  wilsonInterval,
  type CaseReport,
  type EvalCase,
  type EvalCheckResult,
  type OutcomeCase,
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

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const EVAL_SCRIPT = path.join(REPO_ROOT, "scripts", "eval-teaching.ts");

function runEvalCli(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [TSX_CLI, EVAL_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

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
  // 去掉新增的独立推理证据，只保留与伪造迁移同题的旧证据：
  // 同题重答不能单独满足 applied 的结构校验。
  applied.steps[0].evidence = applied.steps[0].evidence.filter(
    (entry) => entry.questionId !== "q-reason-2",
  );
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

function receiptWithSources(sources: TeachingReceipt["sources"]): TeachingReceipt {
  return {
    intent: "continue",
    move: "explain",
    focusTitle: "复利",
    assessment: {
      verdict: "not_assessed",
      evidenceQuote: "",
      questionId: null,
      demonstrated: "none",
      feedback: "仅讲解，不认证掌握。",
    },
    navigation: { kind: "stay" },
    assumptions: [],
    sources,
  };
}

test("新增夹具字段与程序断言可被套件解析", () => {
  for (const id of [
    "known_proposition_used",
    "graph_dependency_returned",
    "graph_review_generated",
    "book_quote_bound",
    "web_claim_matched",
  ] as const) {
    assert.ok(EVAL_CHECKS.includes(id), `缺少检查 ${id}`);
  }
  const graphCase = caseById("graph-known-continuity");
  assert.equal(graphCase.knowledgeGraph?.propositions[0]?.strength, "applied");
  const bookCase = caseById("book-source-binding");
  assert.ok(bookCase.bookFixture);
  const material = buildBookFixture(bookCase.bookFixture);
  assert.deepEqual(material.bookContext.suppliedBlockIds, ["b1", "b2"]);
  assert.equal(material.references[1].location?.blockId, "b2");
  assert.ok(material.references.every((reference) => reference.text.trim()));
  const webCase = caseById("web-claim-binding");
  assert.equal(webCase.webSearch, true);
  assert.equal(webCase.references?.[0]?.verification, "claim_matched");
  assert.ok(webCase.references?.[0]?.verifiedQuote);
  assert.deepEqual(missingCoverage(suite), []);
  const broad = loadSuite("eval/teaching-suite-broad.json");
  assert.equal(broad.requiredCoverage, false);
  assert.ok(missingCoverage(broad).length > 0, "泛化套件应显式豁免发布必需覆盖");
});

test("已掌握命题被忽略时 known_proposition_used 失败", () => {
  const item = caseById("graph-known-continuity");
  const request: ChatRequest = {
    ...requestFor(item, "我已经会用复利公式，想理解连续复利。", "start"),
    knowledgeGraph: item.knowledgeGraph,
  };
  const good = evaluateTurnChecks(
    ["known_proposition_used"],
    {
      request,
      response: {
        message: "你已经掌握的前提是：复利是本金和已产生的利息一起计息。今天只补连续复利。",
        plan: ["从复利到连续复利", "解释极限形式", "用新情境核对"],
      },
    },
    { learnerText: "我已经会用复利公式，想理解连续复利。" },
  ).find((check) => check.id === "known_proposition_used");
  assert.ok(good);
  assert.equal(good.passed, true, good.detail);

  const ignored = evaluateTurnChecks(
    ["known_proposition_used"],
    {
      request,
      response: {
        message: "我们从零开始学复利。",
        plan: ["复利定义", "单利与复利对比", "练习"],
      },
    },
    { learnerText: "我已经会用复利公式，想理解连续复利。" },
  ).find((check) => check.id === "known_proposition_used");
  assert.ok(ignored);
  assert.equal(ignored.passed, false);
  assert.match(ignored.detail, /没有体现/);
});

test("路线依赖必须回传且可追溯，缺图或悬空边失败", () => {
  const item = caseById("graph-known-continuity");
  const request = requestFor(item, "开始", "start");
  const plan = ["复利是本金和利息一起计息", "连续复利是计息间隔趋近零的极限", "用极限表示连续增长"];
  const graph = {
    propositions: [],
    dependencies: [
      { fromId: propositionId(plan[0]), toId: propositionId(plan[1]), createdAt: 1 },
    ],
  };
  const good = evaluateTurnChecks(
    ["graph_dependency_returned"],
    { request, response: { message: "先接上已有基础。", plan, knowledgeGraph: graph } },
    { learnerText: "开始" },
  ).find((check) => check.id === "graph_dependency_returned");
  assert.ok(good);
  assert.equal(good.passed, true, good.detail);

  const missing = evaluateTurnChecks(
    ["graph_dependency_returned"],
    { request, response: { message: "先接上已有基础。", plan } },
    { learnerText: "开始" },
  ).find((check) => check.id === "graph_dependency_returned");
  assert.ok(missing);
  assert.equal(missing.passed, false);

  const dangling = evaluateTurnChecks(
    ["graph_dependency_returned"],
    {
      request,
      response: {
        message: "先接上已有基础。",
        plan,
        knowledgeGraph: {
          propositions: [],
          dependencies: [{ fromId: "kp_missing", toId: propositionId(plan[1]), createdAt: 1 }],
        },
      },
    },
    { learnerText: "开始" },
  ).find((check) => check.id === "graph_dependency_returned");
  assert.ok(dangling);
  assert.equal(dangling.passed, false);
  assert.match(dangling.detail, /路线和图谱之外/);
});

test("已理解命题能生成主动回忆复习项，无 understood 命题失败", () => {
  const item = caseById("graph-review-ready");
  const seed = seedOf(item);
  const request = requestFor(item, "", "continue");
  const generated = evaluateTurnChecks(
    ["graph_review_generated"],
    observationOf(request, "继续讲解复利。", seed),
    { learnerText: "" },
  ).find((check) => check.id === "graph_review_generated");
  assert.ok(generated);
  assert.equal(generated.passed, true, generated.detail);
  assert.match(generated.detail, /kp_/);

  const downgraded = structuredClone(seed);
  downgraded.steps[0].mastery = "learning";
  const none = evaluateTurnChecks(
    ["graph_review_generated"],
    observationOf(request, "继续讲解复利。", downgraded),
    { learnerText: "" },
  ).find((check) => check.id === "graph_review_generated");
  assert.ok(none);
  assert.equal(none.passed, false);
  assert.match(none.detail, /understood/);
});

test("书籍引文必须逐字绑定本轮原文", () => {
  const item = caseById("book-source-binding");
  assert.ok(item.bookFixture);
  const material = buildBookFixture(item.bookFixture);
  const request: ChatRequest = {
    ...requestFor(item, "请只根据这一章带我理解复利。", "start"),
    bookContext: material.bookContext,
    references: material.references,
  };
  const [first, second] = material.references;
  const good = evaluateTurnChecks(
    ["book_quote_bound"],
    {
      request,
      response: {
        message: "本章先给出分界。",
        teaching: receiptWithSources([
          { name: first.name, quote: first.text },
          { name: second.name, quote: second.text, location: second.location },
        ]),
      },
    },
    { learnerText: "请只根据这一章带我理解复利。" },
  ).find((check) => check.id === "book_quote_bound");
  assert.ok(good);
  assert.equal(good.passed, true, good.detail);

  const fabricated = evaluateTurnChecks(
    ["book_quote_bound"],
    {
      request,
      response: {
        message: "本章说复利就是利滚利。",
        teaching: receiptWithSources([{ name: first.name, quote: "复利就是利滚利" }]),
      },
    },
    { learnerText: "请只根据这一章带我理解复利。" },
  ).find((check) => check.id === "book_quote_bound");
  assert.ok(fabricated);
  assert.equal(fabricated.passed, false);
  assert.match(fabricated.detail, /逐字片段/);
});

test("网页引文必须逐字命中 verifiedQuote 并回传核验状态", () => {
  const item = caseById("web-claim-binding");
  const reference = item.references?.[0];
  assert.ok(reference && reference.verifiedQuote);
  const request: ChatRequest = {
    ...requestFor(item, "请结合这份网页资料讲讲复利。", "start"),
    references: item.references,
    webSearch: true,
  };
  const good = evaluateTurnChecks(
    ["web_claim_matched"],
    {
      request,
      response: {
        message: "资料给出的定义是复利在每个计息期把利息计入本金。",
        teaching: receiptWithSources([
          {
            name: reference.name,
            quote: reference.verifiedQuote,
            url: reference.url,
            retrievedAt: reference.retrievedAt,
            verification: "claim_matched",
            sourceTier: reference.sourceTier,
          },
        ]),
      },
    },
    { learnerText: "请结合这份网页资料讲讲复利。" },
  ).find((check) => check.id === "web_claim_matched");
  assert.ok(good);
  assert.equal(good.passed, true, good.detail);

  const paraphrase = evaluateTurnChecks(
    ["web_claim_matched"],
    {
      request,
      response: {
        message: "网页说复利就是利滚利。",
        teaching: receiptWithSources([
          { name: reference.name, quote: "复利就是利滚利", verification: "claim_matched" },
        ]),
      },
    },
    { learnerText: "请结合这份网页资料讲讲复利。" },
  ).find((check) => check.id === "web_claim_matched");
  assert.ok(paraphrase);
  assert.equal(paraphrase.passed, false);
  assert.match(paraphrase.detail, /没有逐字命中/);
});

test("outcome 指标：模拟数据只走流程，真实记录才 measured", () => {
  const outcomeSuite = loadOutcomeSuite("eval/outcome-suite.example.json");
  const outcomeCase: OutcomeCase = outcomeSuite.cases[0];
  assert.ok(outcomeSuite.simulatedResponses);
  const responses = outcomeSuite.simulatedResponses.cases[outcomeCase.id];
  const now = Date.parse("2026-05-01T00:00:00.000Z");

  const preScore = scoreOutcomeTest(outcomeCase.preTest, responses.preTest?.responses);
  assert.deepEqual(preScore, { correct: 1, total: 2, answered: 2, missing: [], score: 0.5 });

  const simulated = evaluateOutcomeCase(outcomeCase, {
    responses,
    source: "simulated",
    now,
  });
  assert.equal(simulated.status, "simulated");
  assert.equal(simulated.effect, "pending");
  assert.deepEqual(simulated.scores, { pre: 0.5, post: 1, delayed: 0.5, transfer: 1 });
  const gain = simulated.metrics.find((metric) => metric.id === "normalized_gain");
  const retention = simulated.metrics.find((metric) => metric.id === "retention_rate");
  const transfer = simulated.metrics.find((metric) => metric.id === "transfer_rate");
  assert.equal(gain?.status, "simulated");
  assert.equal(gain?.value, 1);
  assert.equal(retention?.status, "simulated");
  assert.equal(retention?.value, 0.5);
  assert.equal(transfer?.status, "simulated");
  assert.equal(transfer?.value, 1);
  assert.equal(simulated.metrics.some((metric) => metric.status === "measured"), false);
  assert.equal(simulated.scheduledAt, new Date(now + 86_400_000).toISOString());
  assert.equal(simulated.delayedCompletedAt, simulated.scheduledAt);
  assert.equal(summarizeOutcome([simulated]).exitCode, 2);
  assert.equal(summarizeOutcome([simulated]).status, "simulated");

  const recorded = evaluateOutcomeCase(outcomeCase, {
    responses,
    source: "recorded-human",
    now,
  });
  assert.equal(recorded.status, "measured");
  assert.equal(recorded.effect, "measured");
  assert.ok(recorded.metrics.every((metric) => metric.status === "measured"));
  assert.equal(summarizeOutcome([recorded]).exitCode, 0);

  const skipped = evaluateOutcomeCase(outcomeCase, { source: "none", now });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.effect, "pending");
  assert.ok(skipped.metrics.every((metric) => metric.status === "skipped"));
  assert.ok(skipped.metrics.every((metric) => metric.value === null));
  assert.equal(summarizeOutcome([skipped]).exitCode, 2);

  const early = evaluateOutcomeCase(outcomeCase, {
    responses: {
      ...responses,
      delayedTest: { ...responses.delayedTest!, completedAtOffsetMs: 1000 },
    },
    source: "recorded-human",
    now,
  });
  const earlyRetention = early.metrics.find((metric) => metric.id === "retention_rate");
  assert.equal(earlyRetention?.status, "skipped");
  assert.match(earlyRetention?.detail ?? "", /早于计划时间/);
});

test("--runs 统计只来自实际样本，CI 与 flaky 不伪造", () => {
  const base = { id: "case", title: "用例", covers: [], durationMs: 0, turns: [] };
  const passed: CaseReport = { ...base, status: "passed" };
  const failed: CaseReport = { ...base, status: "failed" };
  const errored: CaseReport = { ...base, id: "other", status: "error" };
  const attempts = summarizeAttempts([passed, failed, passed, errored]);
  assert.equal(attempts.attempts, 4);
  assert.equal(attempts.passed, 2);
  assert.equal(attempts.passRate, 0.5);
  assert.ok(attempts.confidenceInterval);
  assert.ok(attempts.confidenceInterval.low < 0.5 && attempts.confidenceInterval.high > 0.5);
  assert.deepEqual(attempts.flakyCases, ["case"]);
  assert.equal(attempts.cases.find((item) => item.id === "case")?.flaky, true);
  assert.equal(attempts.cases.find((item) => item.id === "other")?.flaky, false);

  assert.equal(wilsonInterval(0, 0), null);
  assert.equal(wilsonInterval(5, 5)?.high, 1);
  assert.equal(wilsonInterval(0, 5)?.low, 0);
  assert.equal(summarizeAttempts([]).confidenceInterval, null);
  assert.equal(summarizeAttempts([]).passRate, null);
});

test("CLI --list 列出新增夹具用例；缺失必需覆盖与模拟效果都退出非零", () => {
  const list = runEvalCli(["--list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /graph-known-continuity/);
  assert.match(list.stdout, /book-source-binding/);
  assert.match(list.stdout, /web-claim-binding/);
  assert.match(list.stdout, /graph-review-ready/);

  const outcomeList = runEvalCli(["--outcome", "--list"]);
  assert.equal(outcomeList.status, 0, outcomeList.stderr);
  assert.match(outcomeList.stdout, /net-value-outcome/);

  const noKey = runEvalCli(["--case", "opening-route", "--json"], {
    GEMINI_API_KEY: "",
    OPENAI_API_KEY: "",
  });
  assert.equal(noKey.status, 2, noKey.stderr);
  const noKeyPayload = JSON.parse(noKey.stdout) as {
    status: string;
    live: boolean;
    exitCode: number;
  };
  assert.equal(noKeyPayload.status, "skipped");
  assert.equal(noKeyPayload.live, false);
  assert.equal(noKeyPayload.exitCode, 2);

  const offline = runEvalCli(["--outcome", "--offline", "--json"]);
  assert.equal(offline.status, 2, offline.stderr);
  const payload = JSON.parse(offline.stdout) as {
    status: string;
    completed: boolean;
    summary: { effect: string };
    cases: { status: string; effect: string; metrics: { status: string }[] }[];
  };
  assert.equal(payload.status, "simulated");
  assert.equal(payload.completed, false);
  assert.equal(payload.summary.effect, "pending");
  assert.ok(payload.cases.every((item) => item.status === "simulated"));
  assert.ok(payload.cases.every((item) => item.effect === "pending"));
  assert.ok(payload.cases.every((item) => item.metrics.every((metric) => metric.status === "simulated")));

  const temp = mkdtempSync(path.join(os.tmpdir(), "zhixu-eval-coverage-"));
  try {
    const suitePath = path.join(temp, "coverage-missing.json");
    writeFileSync(
      suitePath,
      JSON.stringify({
        version: 1,
        name: "缺少必需覆盖",
        defaults: { topic: "测试", level: "从零开始", goal: "测试覆盖门禁" },
        cases: [
          {
            id: "only",
            title: "只有开场",
            covers: [],
            turns: [{ action: "start", learner: "", expect: ["route"] }],
          },
        ],
      }),
    );
    const missing = runEvalCli(["--suite", suitePath]);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /缺少发布门禁必需覆盖/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { applyTutorDraft, LearningProtocolError } from "../server/learning";
import { compileLessonReview, parseLessonContent } from "../server/protocol";
import { passingReview, requestFor, stateWithQuestion } from "./fixtures";

const question = {
  prompt: "现金离开产品资产池后，剩在产品里的价值会怎样变化？请说明原因。",
  kind: "reasoning",
  options: [],
  successCriteria: ["说明现金转出减少产品资产，而不是凭空新增收益"],
};
function lesson(overrides: Record<string, unknown> = {}) {
  return parseLessonContent({
    message: "现金分红是把产品资产中的一部分付到持有人的现金账户；先追踪这笔资金从哪里来，再推导剩余资产的变化。",
    question,
    sources: [],
    assumptions: [],
    ...overrides,
  }, "message");
}
function review(decision?: Record<string, unknown>) {
  return { ...JSON.parse(passingReview), ...(decision ? { decision } : {}) };
}
const partial = {
  intent: "answer",
  move: "repair",
  assessment: { verdict: "partial", demonstrated: "recognition", feedback: "已想到现金流动，还需区分产品资产与持有人现金。" },
  misconception: "把付到持有人账户的现金仍算在产品资产中",
};
const ungraded = { intent: "request_explanation", move: "explain" };

function commit(request: ReturnType<typeof requestFor>, content: ReturnType<typeof lesson>, decision: Record<string, unknown>) {
  const outcome = compileLessonReview(request, content, review(decision));
  assert.equal(outcome.pass, true, JSON.stringify(outcome.issues));
  return applyTutorDraft(request, outcome.draft!, { repaired: false, modelCalls: 2 });
}

test("计算题必须带可核算数值答案，非数值说明不能冒充", () => {
  const base = {
    message: "先判断应该用哪个关系，再代入数值。",
    sources: [],
    assumptions: [],
  };
  assert.throws(
    () => parseLessonContent({
      ...base,
      question: {
        prompt: "这辆车的速度是多少？",
        kind: "calculation",
        options: [],
        successCriteria: ["说明速度与路程、时间的关系"],
      },
    }, "message"),
    (error: unknown) =>
      error instanceof LearningProtocolError &&
      error.issues.some((issue) => issue.code === "missing_answer_key"),
  );
  assert.throws(
    () => parseLessonContent({
      ...base,
      question: {
        prompt: "这辆车的速度是多少？",
        kind: "calculation",
        options: [],
        successCriteria: ["结果为 12.5 米/秒"],
        protectedAnswers: ["注意单位"],
      },
    }, "message"),
    (error: unknown) =>
      error instanceof LearningProtocolError &&
      error.issues.some((issue) => issue.code === "missing_answer_key"),
  );
  const valid = parseLessonContent({
    ...base,
    question: {
      prompt: "这辆车的速度是多少？",
      kind: "calculation",
      options: [],
      successCriteria: ["使用速度=路程÷时间"],
      protectedAnswers: ["12.5"],
    },
  }, "message");
  assert.deepEqual(valid.question?.protectedAnswers, ["12.5"]);
});

test("两处公开内容冲突时拒绝，不能自行选一套路线", () => {
  assert.throws(() => parseLessonContent({
    message: "先区分产品和账户。", question,
    title: "理解净值", plan: ["资产", "分红", "交易"],
    teaching: { title: "理解额度", plan: ["本地", "报盘", "确认"] },
  }, "start"), (error: unknown) => error instanceof LearningProtocolError && error.issues.some(issue => issue.code === "conflicting_fields"));
});

test("唯一误区说明可进入待修复记录，冲突说明不发布", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "现金发给我了，但我认为它仍留在产品资产中。");
  const content = lesson();
  const result = commit(request, content, { ...partial, misconception: { description: partial.misconception } });
  assert.equal(result.learningState!.misconceptions[0].status, "repairing");
  assert.equal(result.learningState!.misconceptions[0].questionId, state.pendingQuestion!.id);
  assert.equal(result.learningState!.steps[0].mastery, "learning");
  const conflicting = compileLessonReview(request, content, review({ ...partial, misconception: { description: "现金仍在产品中", statement: "现金已经转出产品" } }));
  assert.equal(conflicting.pass, false);
  assert.equal(conflicting.protocolFailure, true);
  assert.equal(conflicting.draft, undefined);
});

test("正文尾部的同一追问只向学习者发布一次，不机械删除正文中的引用", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "请解释资金流");
  const content = lesson({ message: `先看现金从产品转到客户账户。\n\n${question.prompt}` });
  const result = commit(request, content, ungraded);
  assert.equal(result.message.split(question.prompt).length - 1, 1);
  const middle = lesson({ message: `我们刚才的问题是：${question.prompt}\n这里还需要核对资金实际流向。` });
  const outcome = compileLessonReview(request, middle, review(ungraded));
  assert.equal(outcome.pass, false);
  assert.ok(outcome.issues.some(issue => issue.code === "duplicated_question"));
});

test("不完整或自相矛盾的评审不发布，内容拒绝与评审格式错误分开", () => {
  const request = requestFor(stateWithQuestion(), "请解释资金流");
  const complete = review(ungraded);
  const { issues: _issues, ...noIssues } = complete;
  const { checks: _checks, ...noChecks } = complete;
  const invalid = [noIssues, noChecks, review(), { ...complete, checks: { ...complete.checks, calibration: false } }];
  for (const raw of invalid) {
    const result = compileLessonReview(request, lesson(), raw);
    assert.equal(result.pass, false);
    assert.equal(result.protocolFailure, true);
    assert.equal(result.draft, undefined);
  }
  const rejected = compileLessonReview(request, lesson(), {
    ...complete, verdict: "revise", checks: { ...complete.checks, scaffolding: false },
    issues: [{ code: "too_many_tasks", detail: "本轮同时要求计算多个新指标" }],
  });
  assert.equal(rejected.pass, false);
  assert.equal(rejected.protocolFailure, false);
  assert.equal(rejected.draft, undefined);
});

test("评审不能偷换讲解或问题身份，证据必须绑定当前真实原话", () => {
  const state = stateWithQuestion();
  const text = "单位净值1.05，累计净值仍1.10，因为现金从产品资产中转出且累计值计入已分红。";
  const request = requestFor(state, text);
  const decision = { intent: "answer", move: "explain", assessment: { verdict: "correct", demonstrated: "reasoning", feedback: "已将产品资产的变化与累计口径分开。" } };
  const result = commit(request, lesson(), decision);
  assert.equal(result.learningState!.steps[0].mastery, "understood");
  assert.equal(result.learningState!.steps[0].evidence[0].questionId, state.pendingQuestion!.id);
  assert.equal(result.learningState!.steps[0].evidence[0].quote, text);
  for (const bad of [
    { ...decision, focusStepId: "step-2" },
    { ...decision, assessment: { ...decision.assessment, questionId: "another-question" } },
    { ...decision, assessment: { ...decision.assessment, evidenceQuote: "旧聊天里曾经答对" } },
    { ...decision, message: "评审替换过的讲解" },
  ]) {
    const outcome = compileLessonReview(request, lesson(), review(bad));
    assert.equal(outcome.pass, false);
    assert.equal(outcome.protocolFailure, true);
    assert.equal(outcome.draft, undefined);
  }
});

test("评审给空证据片段时绑定本轮真实回答", () => {
  const state = stateWithQuestion();
  const text = "单位净值降到1.05，累计净值仍为1.10，因为现金从产品资产池转出。";
  const request = requestFor(state, text);
  const outcome = compileLessonReview(request, lesson(), review({
    intent: "answer",
    move: "explain",
    assessment: { verdict: "correct", demonstrated: "reasoning", evidenceQuote: "", feedback: "已解释资金流。" },
  }));
  assert.equal(outcome.pass, true, JSON.stringify(outcome.issues));
  const result = applyTutorDraft(request, outcome.draft!, { repaired: false, modelCalls: 2 });
  assert.equal(result.learningState!.steps[0].evidence[0].quote, text);
});

test("首错的结果不能经正文、下一问、反馈或误区泄露，包含数字格式变体", () => {
  const state = stateWithQuestion();
  const snapshot = structuredClone(state);
  const request = requestFor(state, "我知道有现金转出，但认为产品资产没有减少。");
  for (const answer of ["1.0500", "１．０５"]) {
    const leaks = [
      { content: lesson({ message: `分红后单位净值是${answer}。` }), decision: partial, metadata: false },
      { content: lesson({ question: { ...question, prompt: `分红后单位净值是${answer}吗？` } }), decision: partial, metadata: false },
      { content: lesson(), decision: { ...partial, assessment: { ...partial.assessment, feedback: `正确结果是${answer}。` } }, metadata: true },
      { content: lesson(), decision: { ...partial, misconception: `还没算出${answer}` }, metadata: true },
    ];
    for (const entry of leaks) {
      const outcome = compileLessonReview(request, entry.content, review(entry.decision));
      assert.equal(outcome.pass, false);
      assert.equal(outcome.protocolFailure, entry.metadata);
      assert.ok(outcome.issues.some(issue => issue.code.endsWith("answer_revealed")));
      assert.equal(outcome.draft, undefined);
    }
  }
  assert.deepEqual(state, snapshot);
});

test("允许明确索要完整讲解，但请求答案不能被认证为独立掌握", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "直接告诉我最终答案是多少。");
  const content = lesson({ message: "产品每份资产减少0.05，单位净值为1.05；无其它变动且累计口径计入现金分红，累计净值仍为1.10。", question: null });
  const result = commit(request, content, ungraded);
  assert.equal(result.learningState!.steps[0].mastery, "learning");
  assert.deepEqual(result.learningState!.steps[0].evidence, []);
  const dishonest = compileLessonReview(request, content, review({
    intent: "answer", move: "explain",
    assessment: { verdict: "correct", demonstrated: "reasoning", feedback: "把索要答案当作已经会解释。" },
  }));
  assert.equal(dishonest.pass, false);
  assert.ok(dishonest.issues.some(issue => issue.code === "requested_solution_not_evidence"));
});

test("方向选择不评知识，正确知识选项可以前进但不能冒充推理", () => {
  const state = stateWithQuestion();
  state.pendingQuestion = { ...state.pendingQuestion!, kind: "choice", options: ["现金从产品转出", "现金是额外收益"], protectedAnswers: undefined };
  const request = requestFor(state, "1");
  const content = lesson({ message: "现金从产品资产转出，所以单位价值下降。接下来区分银行受理与登记机构确认：前者收到申请，后者按产品规则确认成交。", question: { ...question, prompt: "银行已受理，是否意味着登记机构已确认成交？为什么？", successCriteria: ["区分受理与外部确认"] } });
  const recognition = { intent: "answer", move: "explain", navigation: { kind: "advance", targetStepId: "step-2" }, assessment: { verdict: "correct", demonstrated: "recognition", feedback: "选对了资金流向，但尚未独立解释。" } };
  const result = commit(request, content, recognition);
  assert.equal(result.learningState!.currentStepId, "step-2");
  assert.equal(result.learningState!.steps[0].mastery, "learning");
  assert.equal(result.learningState!.steps[0].evidence[0].kind, "recognition");
  const inflated = compileLessonReview(request, content, review({ ...recognition, assessment: { ...recognition.assessment, demonstrated: "reasoning" } }));
  assert.equal(inflated.pass, false);
  assert.ok(inflated.issues.some(issue => issue.code === "choice_is_not_reasoning"));
  state.pendingQuestion.kind = "orientation";
  const preference = compileLessonReview(request, content, review(recognition));
  assert.equal(preference.pass, false);
  assert.ok(preference.issues.some(issue => issue.code === "preference_is_not_knowledge"));
});

test("明确先继续只移动授课位置，不自动获得前一概念的理解证据", () => {
  const state = stateWithQuestion();
  const result = commit(requestFor(state, "先继续下一节，前面待核验的内容保留。"), lesson(), {
    intent: "continue", move: "explain", navigation: { kind: "advance", targetStepId: "step-2" },
  });
  assert.equal(result.learningState!.currentStepId, "step-2");
  assert.equal(result.learningState!.steps[0].mastery, "learning");
  assert.deepEqual(result.learningState!.steps[0].evidence, []);
});

test("轻量回主线恢复保存原题的身份与私有判定，不把插问当作主线作答", () => {
  const state = stateWithQuestion();
  const originalQuestion = structuredClone(state.pendingQuestion!);
  state.detours.push({ topic: "份额是什么", returnStepId: state.currentStepId, returnQuestion: originalQuestion, mastery: "learning", evidence: [] });
  state.pendingQuestion = { ...originalQuestion, id: "detour-question", kind: "reasoning", prompt: "份额代表什么？", successCriteria: ["描述持有单位"], scope: "detour" };
  const content = parseLessonContent({ message: "份额是持有单位；回到之前保存的现金分红问题。", question: null }, "resume");
  const request = requestFor(state, "回到主线", "resume");
  const outcome = compileLessonReview(request, content, review());
  assert.equal(outcome.pass, true, JSON.stringify(outcome.issues));
  const result = applyTutorDraft(request, outcome.draft!, { repaired: false, modelCalls: 2 });
  assert.deepEqual(result.learningState!.detours, []);
  assert.deepEqual(result.learningState!.pendingQuestion, originalQuestion);
  assert.ok(result.message.includes(originalQuestion.prompt));
  assert.equal(result.learningState!.steps[0].mastery, "learning");
  assert.deepEqual(result.learningState!.steps[0].evidence, []);
});

test("前提对象含其它事实字段时不能只取content而丢掉冲突状态", () => {
  assert.throws(() => lesson({ assumptions: [{ role: "本地订单", content: "仅已受理", externalStatus: "TA已确认" }] }),
    (error: unknown) => error instanceof LearningProtocolError && error.issues.some(issue => issue.code === "invalid_protocol"));
});

test("正文末尾的独立提问段只保留结构化问题", () => {
  const parsed = lesson({ message: "现金已经从产品转到客户账户。\n\n**想一想**\n\n产品的价值为什么会变化？" });
  assert.equal(parsed.message, "现金已经从产品转到客户账户。");
  assert.ok(parsed.formatRepairs.includes("去除正文末尾重复提问段"));
});

test("正文末尾带冒号的想一想标题只保留结构化题面", () => {
  const parsed = parseLessonContent({
    message: `现金已经从产品转到客户账户。\n\n**想一想**：${question.prompt}`,
    question,
    sources: [],
    assumptions: [],
  }, "message");
  assert.equal(parsed.message, "现金已经从产品转到客户账户。");
  assert.ok(parsed.formatRepairs.includes("去除正文末尾完全重复的题面"));
});

test("正文中的独立题面段落只保留结构化题面", () => {
  const parsed = parseLessonContent({
    message: `现金已经从产品转到客户账户。\n\n请回答：\n\n${question.prompt}\n\n`,
    question,
    sources: [],
    assumptions: [],
  }, "message");
  assert.equal(parsed.message, "现金已经从产品转到客户账户。");
  assert.ok(parsed.formatRepairs.some((repair) => repair.includes("去除正文")));
});

test("没有结构化证据的复盘不能声称学习者已经核验", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "", "summary");
  const overclaim = parseLessonContent({
    message: "本次讲过核心机制；学习者已独立完成并已核验。",
    sources: [],
    assumptions: [],
  }, "summary");
  const rejected = compileLessonReview(request, overclaim, review());
  assert.equal(rejected.pass, false);
  assert.ok(rejected.issues.some((issue) => issue.code === "unverified_summary_claim"));

  const honest = parseLessonContent({
    message: "本次讲过核心机制；已核验的部分：暂无。没有收到独立作答，因此能力仍未核验。之前的讲解不代表已掌握。",
    sources: [],
    assumptions: [],
  }, "summary");
  const accepted = compileLessonReview(request, honest, review());
  assert.equal(accepted.pass, true, JSON.stringify(accepted.issues));
  const response = applyTutorDraft(request, accepted.draft!, { repaired: false, modelCalls: 2 });
  assert.deepEqual(response.learningState, state);
});

test("复盘按步骤证据区分已核验与未核验", () => {
  const state = stateWithQuestion(true);
  const request = requestFor(state, "", "summary");
  const unverifiedTitle = state.steps[1].title;
  const overclaim = parseLessonContent({
    message: `${unverifiedTitle} 已掌握。`,
    sources: [],
    assumptions: [],
  }, "summary");
  const rejected = compileLessonReview(request, overclaim, review());
  assert.equal(rejected.pass, false);
  assert.ok(rejected.issues.some((issue) => issue.code === "unverified_summary_claim"));

  const honest = parseLessonContent({
    message: `${state.steps[0].title} 已核验；${unverifiedTitle} 尚未核验。下一步将继续讲这个概念。`,
    sources: [],
    assumptions: [],
  }, "summary");
  const accepted = compileLessonReview(request, honest, review());
  assert.equal(accepted.pass, true, JSON.stringify(accepted.issues));
});

test("导师安排下一步可推进相邻授课，但旧回答不变成新的掌握证据", () => {
  const state = stateWithQuestion();
  const before = structuredClone(state);
  const request = requestFor(state, "以前说过：现金从资产池转出进入客户账户。", "continue");
  const result = commit(request, lesson({ question: null }), {
    intent: "continue", move: "explain", navigation: { kind: "advance", targetStepId: "step-2" },
  });
  assert.equal(result.learningState!.currentStepId, "step-2");
  assert.equal(result.learningState!.steps[1].mastery, "learning");
  assert.deepEqual(result.learningState!.steps[0], before.steps[0]);
  assert.deepEqual(result.learningState!.steps.map(step => step.evidence), [[], [], []]);
  assert.equal(result.teaching!.assessment.verdict, "not_assessed");
  assert.equal(result.learningState!.pendingQuestion, null);
  assert.deepEqual(state, before);
});

test("继续听当前讲解可以不出新题，也不丢失原待核验问题", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "以前的聊天内容，不是本轮作答。", "continue");
  const outcome = compileLessonReview(request, lesson({ question: null }), review());
  assert.equal(outcome.pass, true, JSON.stringify(outcome.issues));
  const result = applyTutorDraft(request, outcome.draft!, { repaired: false, modelCalls: 2 });
  assert.equal(result.learningState!.currentStepId, state.currentStepId);
  assert.deepEqual(result.learningState!.pendingQuestion, state.pendingQuestion);
  assert.deepEqual(result.learningState!.steps[0].evidence, []);
  assert.equal(result.learningState!.steps[0].mastery, "learning");
});

test("领学按钮不能认证聊天中旧的正确解释", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "现金从产品资产中转出，进入客户现金账户。", "continue");
  const outcome = compileLessonReview(request, lesson(), review({
    intent: "answer", move: "explain",
    assessment: { verdict: "correct", demonstrated: "reasoning", evidenceQuote: request.messages.at(-1)!.content, feedback: "已解释机制。" },
  }));
  assert.equal(outcome.pass, false);
  assert.equal(outcome.draft, undefined);
  assert.ok(outcome.issues.some(issue => issue.code === "tool_is_not_evidence"));
  assert.deepEqual(state.steps[0].evidence, []);
});

test("领学讲解保留未修复误区，不靠操作清除", () => {
  const state = stateWithQuestion();
  state.misconceptions.push({
    id: "cash-misconception", stepId: state.currentStepId, topic: state.steps[0].title,
    questionId: state.pendingQuestion!.id, scope: "main", description: "将转出的现金仍算入产品资产",
    evidenceQuote: "现金仍在产品资产中", status: "repairing",
  });
  const request = requestFor(state, "旧聊天记录", "continue");
  const result = commit(request, lesson({ question: null }), { intent: "continue", move: "explain" });
  assert.deepEqual(result.learningState!.misconceptions, state.misconceptions);
  const rejected = compileLessonReview(request, lesson({ question: null }), review({
    intent: "continue", move: "explain", resolvedMisconceptionIds: ["cash-misconception"],
  }));
  assert.equal(rejected.pass, false);
  assert.equal(rejected.draft, undefined);
  assert.ok(rejected.issues.some(issue => issue.code === "unverified_repair"));
});

test("自动领学不跨步、不跳过当前困难，也不丢弃插问返回点", () => {
  const ordinary = stateWithQuestion();
  const struggling = stateWithQuestion();
  struggling.lastAssessment = { verdict: "uncertain", evidenceQuote: "我不会", questionId: struggling.pendingQuestion!.id, demonstrated: "none", feedback: "先补必要基础。" };
  const detouring = stateWithQuestion();
  detouring.detours.push({ topic: "份额是什么", returnStepId: detouring.currentStepId, returnQuestion: structuredClone(detouring.pendingQuestion), mastery: "learning", evidence: [] });
  detouring.pendingQuestion = { ...detouring.pendingQuestion!, id: "detour-question", scope: "detour" };
  for (const { state, target, code } of [
    { state: ordinary, target: "step-3", code: "advance_skipped_step" },
    { state: struggling, target: "step-2", code: "premature_advance" },
    { state: detouring, target: "step-2", code: "premature_advance" },
  ]) {
    const before = structuredClone(state);
    const outcome = compileLessonReview(requestFor(state, "旧聊天", "continue"), lesson({ question: null }), review({
      intent: "continue", move: "explain", navigation: { kind: "advance", targetStepId: target },
    }));
    assert.equal(outcome.pass, false);
    assert.equal(outcome.draft, undefined);
    assert.ok(outcome.issues.some(issue => issue.code === code), JSON.stringify(outcome.issues));
    assert.deepEqual(state, before);
  }
});

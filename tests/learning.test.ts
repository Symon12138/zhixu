import assert from "node:assert/strict";
import test from "node:test";
import type { ChatRequest, LearningState } from "../src/types";
import {
  applyTutorDraft,
  checkTutorDraft,
  LearningProtocolError,
  parseTutorDraft,
  resolveLearnerTurn,
  type TutorDraft,
} from "../server/learning";
import {
  answerFor,
  draftFor,
  openingDraft,
  questionFor,
  requestFor,
  stateWithQuestion,
} from "./fixtures";

const reviewed = { repaired: false, modelCalls: 2 };

function commit(request: ChatRequest, draft: TutorDraft): LearningState {
  return applyTutorDraft(request, draft, reviewed).learningState!;
}

test("选择方向不是知识题，单纯选中知识选项也不能当作解释或迁移", () => {
  const state = stateWithQuestion();
  state.pendingQuestion = {
    ...state.pendingQuestion!,
    kind: "choice",
    options: ["资产不变", "从资产池转出"],
  };
  const request = requestFor(state, "2");
  assert.equal(resolveLearnerTurn(request).choiceText, "从资产池转出");
  const next = commit(
    request,
    draftFor(state, {
      intent: "answer",
      assessment: answerFor(state, "2", "correct", "recognition"),
    }),
  );
  assert.equal(next.steps[0].mastery, "learning");
  assert.equal(next.steps[0].evidence[0].kind, "recognition");
  assert.ok(
    checkTutorDraft(
      request,
      draftFor(state, {
        intent: "answer",
        assessment: answerFor(state, "2", "correct", "reasoning"),
      }),
    ).some((issue) => issue.code === "choice_is_not_reasoning"),
  );
  state.pendingQuestion.kind = "orientation";
  assert.ok(
    checkTutorDraft(
      requestFor(state, "2"),
      draftFor(state, {
        intent: "answer",
        assessment: answerFor(state, "2", "correct", "recognition"),
      }),
    ).some((issue) => issue.code === "preference_is_not_knowledge"),
  );
});

test("明确不会时回到补课，历史上解释过也不能成为跳过本轮疑问的理由", () => {
  const state = stateWithQuestion(true);
  const request = requestFor(state, "私募的概念我不了解");
  const directive = draftFor(state, {
    intent: "uncertain",
    move: "explain",
    assessment: {
      verdict: "uncertain",
      evidenceQuote: "概念我不了解",
      questionId: state.pendingQuestion!.id,
      demonstrated: "none",
      feedback: "先补概念，不评价为已理解。",
    },
  });
  const next = commit(request, directive);
  assert.equal(next.currentStepId, state.currentStepId);
  assert.equal(next.steps[0].mastery, "learning");
  assert.deepEqual(next.steps[0].evidence, state.steps[0].evidence);
  const skipping = draftFor(state, {
    ...directive.teaching!,
    focusStepId: "step-2",
    navigation: { kind: "advance", targetStepId: "step-2" },
    question: { ...directive.teaching!.question!, stepId: "step-2" },
  });
  assert.ok(
    checkTutorDraft(request, skipping).some(
      (issue) => issue.code === "uncertainty_misgraded",
    ),
  );
});

test("理解证据只能来自本轮用户回答，不能拿旧回答、模型解释或其它问题作证", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "我还没理解现金从哪来");
  request.messages.unshift({ role: "user", content: "分红从资产池转出" });
  const fabricated = draftFor(state, {
    intent: "answer",
    assessment: answerFor(state, "分红从资产池转出"),
  });
  assert.ok(
    checkTutorDraft(request, fabricated).some(
      (issue) => issue.code === "fabricated_evidence",
    ),
  );
  const wrongQuestion = draftFor(state, {
    intent: "answer",
    assessment: {
      ...answerFor(state, "我还没理解现金从哪来"),
      questionId: "not-the-pending-question",
    },
  });
  assert.ok(
    checkTutorDraft(request, wrongQuestion).some(
      (issue) => issue.code === "ungrounded_assessment",
    ),
  );
  const oldOnly = requestFor(state, "分红从资产池转出");
  oldOnly.messages.push({ role: "assistant", content: "已经讲过了，继续。" });
  assert.equal(resolveLearnerTurn(oldOnly).text, "");
  assert.throws(
    () => applyTutorDraft(oldOnly, fabricated, reviewed),
    LearningProtocolError,
  );
  assert.equal(state.steps[0].evidence.length, 0);
});

test("计算题最终数值不符时不能判正确或记推理证据，命中私有数值才放行", () => {
  const state = stateWithQuestion();
  const wrong = "单位净值=1.10−0.05=1.02，累计净值=1.10+0.05=1.15。";
  const wrongRequest = requestFor(state, wrong);
  const overclaimed = draftFor(state, {
    intent: "answer",
    move: "repair",
    assessment: answerFor(state, wrong, "partial", "reasoning"),
    misconception: "累计净值方向写反，且减法算错",
  });
  assert.ok(
    checkTutorDraft(wrongRequest, overclaimed).some(
      (issue) => issue.code === "numeric_mismatch",
    ),
  );
  const markedCorrect = draftFor(state, {
    intent: "answer",
    assessment: answerFor(state, wrong, "correct", "recognition"),
  });
  assert.ok(
    checkTutorDraft(wrongRequest, markedCorrect).some(
      (issue) => issue.code === "numeric_mismatch",
    ),
  );
  const recognitionOnly = draftFor(state, {
    intent: "answer",
    move: "repair",
    assessment: answerFor(state, wrong, "partial", "recognition"),
    misconception: "累计净值方向写反，且减法算错",
  });
  assert.ok(
    !checkTutorDraft(wrongRequest, recognitionOnly).some(
      (issue) => issue.code === "numeric_mismatch",
    ),
  );
  const correct = "单位净值1.05，累计净值1.10，这笔现金从产品资产池转出。";
  const correctDraft = draftFor(state, {
    intent: "answer",
    assessment: answerFor(state, correct, "correct", "reasoning"),
  });
  assert.ok(
    !checkTutorDraft(requestFor(state, correct), correctDraft).some(
      (issue) => issue.code === "numeric_mismatch",
    ),
  );
});

test("分红的局部错误保留为误区，解释后答对原理仍需另一道迁移题才解除", () => {
  const state = stateWithQuestion();
  const wrong = "1.1和1.15，累计净值要加历史分红";
  const repaired = commit(
    requestFor(state, wrong),
    draftFor(state, {
      intent: "answer",
      move: "repair",
      assessment: answerFor(state, wrong, "partial", "recognition"),
      misconception: "记住了累计关系，但忽略现金分红从产品净资产中转出",
      question: questionFor(
        state,
        "reasoning",
        "现金从产品资产池转给持有人后，产品内还剩下什么？请说明资金流。",
      ),
    }),
  );
  assert.equal(repaired.steps[0].mastery, "learning");
  assert.equal(repaired.misconceptions[0].evidenceQuote, wrong);
  assert.equal(repaired.misconceptions[0].status, "repairing");
  const explanation =
    "现金从产品已有资产转出，单位净值应扣除分红，累计值加回这笔历史现金。";
  const understood = commit(
    requestFor(repaired, explanation),
    draftFor(repaired, {
      intent: "answer",
      assessment: answerFor(repaired, explanation),
      question: questionFor(
        repaired,
        "transfer",
        "另一产品分红前两种净值均1.40，每份发0.10且无其它变化，分红后分别是多少？为什么？",
      ),
    }),
  );
  assert.equal(understood.steps[0].mastery, "understood");
  assert.equal(understood.misconceptions[0].status, "repairing");
  const appliedAnswer =
    "单位1.30，累计1.40；0.10从产品资产转到现金，累计将该现金加回。";
  const applied = commit(
    requestFor(understood, appliedAnswer),
    draftFor(understood, {
      intent: "answer",
      move: "explain",
      assessment: answerFor(understood, appliedAnswer, "correct", "transfer"),
      resolvedMisconceptionIds: [understood.misconceptions[0].id],
      question: null,
    }),
  );
  assert.equal(applied.steps[0].mastery, "applied");
  assert.equal(applied.misconceptions[0].status, "resolved");
  assert.equal(
    applied.steps[0].evidence[0].question,
    repaired.pendingQuestion!.prompt,
  );
  assert.equal(applied.pendingQuestion, null);
  assert.equal(state.misconceptions.length, 0);
});

test("把原题换一个ID再答不能冒充迁移，即使已有其它原理解释证据", () => {
  const state = stateWithQuestion(true);
  const wrong = "单位1.1，累计1.15";
  const retrying = commit(
    requestFor(state, wrong),
    draftFor(state, {
      intent: "answer",
      move: "repair",
      assessment: answerFor(state, wrong, "partial", "recognition"),
      misconception: "忽略分红导致的资产转出",
      question: {
        ...questionFor(state, "transfer", state.pendingQuestion!.prompt),
      },
    }),
  );
  assert.notEqual(retrying.pendingQuestion!.id, state.pendingQuestion!.id);
  const repeatedAnswer = "单位1.05，累计1.10，因为分红从资产池扣除。";
  const pretendTransfer = draftFor(retrying, {
    intent: "answer",
    assessment: answerFor(retrying, repeatedAnswer, "correct", "transfer"),
    question: null,
  });
  assert.ok(
    checkTutorDraft(requestFor(retrying, repeatedAnswer), pretendTransfer).some(
      (issue) => issue.code === "not_a_transfer_probe",
    ),
  );
});

test("TA批量交互质疑不能被夸为答对，撤回错误前提后重新核验旧证据", () => {
  const state = stateWithQuestion(true);
  const old = "每笔申购都同步调用外部TA扣减全网额度";
  state.assumptions = [old];
  const quote = "我们与TA只有日启和日终文件，没法每笔实时同步";
  const request = requestFor(state, quote);
  const next = commit(
    request,
    draftFor(state, {
      intent: "challenge",
      move: "clarify",
      retractedAssumptions: [old],
      assumptions: ["本例外部TA只做批量交互，日间本地控制与最终确认分开"],
    }),
  );
  assert.ok(!next.assumptions.includes(old));
  assert.equal(next.steps[0].mastery, "learning");
  assert.deepEqual(next.steps[0].evidence, []);
  assert.equal(next.lastAssessment!.verdict, "not_assessed");
  assert.ok(
    checkTutorDraft(
      request,
      draftFor(state, {
        intent: "challenge",
        move: "clarify",
        assessment: answerFor(state, quote),
      }),
    ).some((issue) => issue.code === "challenge_ignored"),
  );
  assert.equal(state.steps[0].mastery, "understood");
});

test("插问的回答不提升主线，返回时恢复原问题的ID、选项与检查目标", () => {
  const state = stateWithQuestion();
  const original = structuredClone(state.pendingQuestion);
  const detour = commit(
    requestFor(state, "我先临时问一下份额精度"),
    draftFor(state, {
      intent: "side_question",
      navigation: { kind: "detour", topic: "份额精度" },
      question: questionFor(
        state,
        "reasoning",
        "为什么账务系统需要约定有限精度？",
      ),
    }),
  );
  assert.equal(detour.pendingQuestion!.scope, "detour");
  assert.equal(detour.detours[0].returnQuestion!.id, original!.id);
  const answer =
    "金额和份额必须使用有限表示，舍入方式与尾差处理要由本产品规则约定。";
  const resumed = commit(
    requestFor(detour, answer),
    draftFor(detour, {
      intent: "answer",
      move: "return",
      assessment: answerFor(detour, answer),
      navigation: { kind: "resume" },
      question: null,
    }),
  );
  assert.deepEqual(resumed.pendingQuestion, original);
  assert.equal(resumed.detours.length, 0);
  assert.equal(resumed.steps[0].mastery, "learning");
  assert.deepEqual(resumed.steps[0].evidence, []);
});

test("明确说顺便问一下必须保存返回点，不能当普通主线回答", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "顺便问一下，为什么这里的单位要用小数？");
  const issues = checkTutorDraft(
    request,
    draftFor(state, {
      intent: "answer",
      assessment: answerFor(state, "顺便问一下，为什么这里的单位要用小数？"),
    }),
  );
  assert.ok(issues.some((issue) => issue.code === "side_question_required"));
});

test("恢复原题时同时保护插问题和原题答案", () => {
  const state = stateWithQuestion();
  const detour = commit(
    requestFor(state, "临时问一下份额精度"),
    draftFor(state, {
      intent: "side_question",
      navigation: { kind: "detour", topic: "份额精度" },
      question: questionFor(state, "reasoning", "为什么账务系统需要约定有限精度？"),
    }),
  );
  const request = requestFor(detour, "回到刚才的净值题", "resume");
  const draft = draftFor(detour, {
    move: "return",
    navigation: { kind: "resume" },
    question: null,
  });
  draft.message = "回到原来那道题：单位净值就是 1.05。";
  const issues = checkTutorDraft(request, draft);
  assert.ok(issues.some((issue) => issue.code === "answer_revealed"), JSON.stringify(issues));
});

test("resume 时服务端用保存的原题覆盖模型新题", () => {
  const state = stateWithQuestion();
  const detour = commit(
    requestFor(state, "临时问一下份额精度"),
    draftFor(state, {
      intent: "side_question",
      navigation: { kind: "detour", topic: "份额精度" },
      question: questionFor(state, "reasoning", "为什么账务系统需要约定有限精度？"),
    }),
  );
  const original = detour.detours.at(-1)!.returnQuestion!;
  const resumed = commit(
    requestFor(detour, "回到刚才的净值题", "resume"),
    draftFor(detour, {
      move: "return",
      navigation: { kind: "resume" },
      question: questionFor(detour, "reasoning", "模型另出的新问题"),
    }),
  );
  assert.equal(resumed.pendingQuestion?.id, original.id);
  assert.equal(resumed.detours.length, 0);
});

test("嵌套插问按后进先出恢复，不用新问题覆盖原返回点", () => {
  const state = stateWithQuestion();
  const first = commit(
    requestFor(state, "临时问估值"),
    draftFor(state, {
      intent: "side_question",
      navigation: { kind: "detour", topic: "估值" },
      question: questionFor(state, "reasoning", "为什么资产估值需要明确时点？"),
    }),
  );
  const inner = commit(
    requestFor(first, "再临时问一下时区"),
    draftFor(first, {
      intent: "side_question",
      navigation: { kind: "detour", topic: "时区" },
      question: questionFor(
        first,
        "reasoning",
        "同一个市场收盘时刻怎样换算成本地日期？",
      ),
    }),
  );
  const oneBack = commit(
    requestFor(inner, "", "resume"),
    draftFor(inner, {
      move: "return",
      navigation: { kind: "resume" },
      question: null,
    }),
  );
  assert.equal(oneBack.pendingQuestion!.id, first.pendingQuestion!.id);
  assert.equal(oneBack.pendingQuestion!.scope, "detour");
  assert.equal(oneBack.detours.length, 1);
  const main = commit(
    requestFor(oneBack, "", "resume"),
    draftFor(oneBack, {
      move: "return",
      navigation: { kind: "resume" },
      question: null,
    }),
  );
  assert.equal(main.pendingQuestion!.id, state.pendingQuestion!.id);
  assert.equal(main.pendingQuestion!.scope, "main");
});

test("先学QDII后回原主题，保留完整暂停状态、误区与当前问题", () => {
  const state = stateWithQuestion(true);
  const oldGoal = state.goal;
  const wrong = "单位不变，分红是额外给的钱";
  const learning = commit(
    requestFor(state, wrong),
    draftFor(state, {
      intent: "answer",
      move: "repair",
      assessment: answerFor(state, wrong, "incorrect", "none"),
      misconception: "把分红当作额外创造收益",
    }),
  );
  const switchedDraft = draftFor(learning, {
    intent: "topic_switch",
    move: "orient",
    navigation: { kind: "switch", topic: "QDII" },
    question: questionFor(
      learning,
      "reasoning",
      "机构投资境外资产与客户直接跨境投资有什么区别？",
    ),
  });
  switchedDraft.plan = [
    "机构额度与个人购汇的区别",
    "按产品约定理解双边日历",
    "币种份额与结算参数的边界",
  ];
  const switched = commit(
    requestFor(learning, "最近要做QDII，先学这个，原来的留着"),
    switchedDraft,
  );
  assert.equal(switched.goal, "QDII");
  assert.equal(switched.savedTracks[0].goal, oldGoal);
  assert.deepEqual(
    switched.savedTracks[0].misconceptions,
    learning.misconceptions,
  );
  const restored = commit(
    requestFor(switched, `回到${oldGoal}继续`),
    draftFor(switched, {
      intent: "topic_switch",
      move: "return",
      navigation: { kind: "switch", topic: oldGoal },
      question: null,
    }),
  );
  assert.equal(restored.goal, oldGoal);
  assert.deepEqual(restored.steps, learning.steps);
  assert.deepEqual(restored.pendingQuestion, learning.pendingQuestion);
  assert.deepEqual(restored.misconceptions, learning.misconceptions);
  assert.deepEqual(restored.assumptions, learning.assumptions);
  assert.ok(restored.savedTracks.some((track) => track.goal === "QDII"));
});

test("提示保留原问题，工具生成与复盘不凭空增加理解或消除误区", () => {
  const state = stateWithQuestion(true);
  const hint = commit(
    requestFor(state, "", "hint"),
    draftFor(state, { move: "hint", question: null }),
  );
  assert.equal(hint.pendingQuestion!.id, state.pendingQuestion!.id);
  assert.deepEqual(hint.steps, state.steps);
  const response = applyTutorDraft(
    requestFor(state, "", "summary"),
    { message: "目前只有已记录的解释证据，迁移尚未核验。", sources: [] },
    reviewed,
  );
  assert.deepEqual(response.learningState, state);
  const fake = draftFor(state, {
    intent: "answer",
    assessment: answerFor(state, "旧答案"),
    question: null,
  });
  assert.ok(
    checkTutorDraft(requestFor(state, "", "summary"), fake).some(
      (issue) => issue.code === "tool_changed_progress",
    ),
  );
});

test("材料引文必须真实，练习空选项和错索引必须拒绝而非过滤重排", () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "看看材料");
  request.references = [
    { name: "产品资料", text: "交易参数以本产品约定为准。" },
  ];
  const forged = {
    ...draftFor(state),
    sources: [{ name: "产品资料", quote: "所有理财一律T+1确认" }],
  };
  assert.ok(
    checkTutorDraft(request, forged).some(
      (issue) => issue.code === "fabricated_source",
    ),
  );
  const question = {
    question: "不同产品的到账日期是否一定相同？",
    options: ["总是相同", "", "依约定确定"],
    correctIndex: 2,
    explanation: "需要核对本产品条款。",
    hint: "区分机制与参数。",
  };
  assert.throws(
    () => parseTutorDraft({ quiz: [question, question, question] }, "quiz"),
    LearningProtocolError,
  );
  const outOfRange = {
    ...question,
    options: ["相同", "依约定"],
    correctIndex: 2,
  };
  assert.throws(
    () =>
      parseTutorDraft({ quiz: [outOfRange, outOfRange, outOfRange] }, "quiz"),
    LearningProtocolError,
  );
});

test("首次学习与旧会话重建只建立路线，不把聊过当作学会", () => {
  const request: ChatRequest = {
    topic: "净值",
    level: "从零开始",
    goal: "理解机制",
    action: "start",
    messages: [{ role: "user", content: "我想学习净值" }],
  };
  const response = applyTutorDraft(request, openingDraft(), reviewed);
  assert.equal(response.learningState!.steps[0].mastery, "learning");
  assert.ok(
    response.learningState!.steps.every(
      (step) =>
        step.evidence.length === 0 &&
        step.mastery !== "understood" &&
        step.mastery !== "applied",
    ),
  );
  assert.equal(response.learningState!.pendingQuestion!.scope, "main");
});

test("历史以助手结尾时，没有新的继续指令也不能推进已解释的概念", () => {
  const state = stateWithQuestion(true);
  const request = requestFor(state, "先解释当前问题");
  request.messages.push({ role: "assistant", content: "解释已经给出。" });
  const skipping = draftFor(state, {
    intent: "continue",
    focusStepId: "step-2",
    navigation: { kind: "advance", targetStepId: "step-2" },
    question: {
      ...questionFor(state, "reasoning", "下一步如何处理？"),
      stepId: "step-2",
    },
  });
  assert.ok(
    checkTutorDraft(request, skipping).some(
      (issue) => issue.code === "premature_advance",
    ),
  );
});

test("空泛的听懂了吗不能代替实质理解检查", () => {
  const state = stateWithQuestion();
  const vague = draftFor(state, {
    question: questionFor(state, "reasoning", "你明白了吗？"),
  });
  assert.ok(
    checkTutorDraft(requestFor(state, "请继续引导"), vague).some(
      (issue) => issue.code === "generic_probe",
    ),
  );
});

test("模型把完整答案放进建议回复也必须拒绝，不能点击回填后冒充学习者理解", () => {
  const state = stateWithQuestion();
  const leaked = {
    ...draftFor(state),
    suggestedReplies: ["单位净值1.05，累计1.10，因为现金从产品资产转出。"],
  };
  assert.throws(
    () => parseTutorDraft(leaked, "message"),
    (error: unknown) =>
      error instanceof LearningProtocolError &&
      error.issues.some((issue) => issue.code === "answer_in_suggestions"),
  );
});

test("同题同类型证据更新不重复；推理升级迁移后保留两类证据且不被弱回答覆盖", () => {
  const state = stateWithQuestion(true);
  state.pendingQuestion = {
    ...state.pendingQuestion!,
    id: "transfer-current",
    kind: "transfer",
    prompt: "把净值机制用于另一产品的客户投诉。",
  };
  const firstAnswer = "先按资产流出解释客户的疑问。";
  const first = commit(
    requestFor(state, firstAnswer),
    draftFor(state, {
      intent: "answer",
      assessment: answerFor(state, firstAnswer, "correct", "reasoning"),
      question: null,
    }),
  );
  assert.equal(first.steps[0].evidence.at(-1)?.kind, "reasoning");

  // 用同一待答题与已有证据模拟协议允许的同题再次核验。
  const retry = { ...state, steps: first.steps, revision: first.revision };
  const betterAnswer = "分红是把产品资产转为现金，不是额外收益，所以总资产不增加。";
  const improved = commit(
    requestFor(retry, betterAnswer),
    draftFor(retry, {
      intent: "answer",
      assessment: answerFor(retry, betterAnswer, "correct", "transfer"),
      question: null,
    }),
  );
  const evidence = improved.steps[0].evidence;
  assert.equal(evidence.filter(item => item.questionId === "transfer-current" && item.kind === "reasoning").length, 1);
  assert.equal(evidence.filter(item => item.questionId === "transfer-current" && item.kind === "transfer").length, 1);
  assert.equal(evidence.at(-1)?.quote, betterAnswer);
  assert.equal(evidence.at(-1)?.kind, "transfer");

  const weakerAnswer = "这是一次较弱的概括。";
  const retryAfterImprovement = { ...improved, pendingQuestion: state.pendingQuestion };
  const afterWeaker = commit(
    requestFor(retryAfterImprovement, weakerAnswer),
    draftFor(retryAfterImprovement, {
      intent: "answer",
      assessment: answerFor(retryAfterImprovement, weakerAnswer, "correct", "recognition"),
      question: null,
    }),
  );
  assert.equal(afterWeaker.steps[0].evidence.at(-1)?.kind, "transfer");
  assert.equal(afterWeaker.steps[0].mastery, "applied");
});

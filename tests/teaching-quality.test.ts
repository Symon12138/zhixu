import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ChatRequest } from "../src/types";
import { ApiError } from "../server/ai";
import { runTeachingTurn, TeachingQualityError } from "../server/tutor";
import { LearningProtocolError, type TutorDraft } from "../server/learning";
import {
  draftFor,
  openingDraft,
  passingReview,
  rejectingReview,
  requestFor,
  stateWithQuestion,
} from "./fixtures";

function lessonFor(draft: TutorDraft) {
  const { teaching, ...content } = draft;
  const question = teaching?.question;
  return {
    ...content,
    question: question ? { prompt: question.prompt, kind: question.kind, options: question.options, successCriteria: question.successCriteria, protectedAnswers: question.protectedAnswers } : null,
    assumptions: teaching?.assumptions ?? [],
  };
}

const ungradedReview = JSON.stringify({
  ...JSON.parse(passingReview),
  decision: { intent: "request_explanation", move: "explain" },
});

function initialRequest(): ChatRequest {
  return {
    topic: "净值与分红",
    level: "从零开始",
    goal: "能解释资金变化",
    action: "start",
    messages: [{ role: "user", content: "我想理解净值" }],
  };
}

test("结构不合格草稿不送评也不发布，只允许修订一次且修订后必须评审", async () => {
  const request = initialRequest();
  const phases: string[] = [];
  const unapproved = "UNAPPROVED_DRAFT_DO_NOT_PUBLISH";
  const result = await runTeachingTurn(request, async (input) => {
    phases.push(input.purpose);
    if (input.purpose === "draft")
      return JSON.stringify({ message: unapproved });
    if (input.purpose === "repair") return JSON.stringify(lessonFor(openingDraft()));
    return passingReview;
  });
  assert.deepEqual(phases, ["draft", "repair", "review"]);
  assert.equal(result.quality!.repaired, true);
  assert.equal(result.quality!.modelCalls, 3);
  assert.ok(!result.message.includes(unapproved));
  assert.ok(
    result.learningState!.steps.every((step) => step.evidence.length === 0),
  );
});

test("语义评审拒绝的内容不能先提交，修订通过后才原子增加一轮状态", async () => {
  const state = stateWithQuestion();
  const snapshot = structuredClone(state);
  const request = requestFor(state, "请重新解释资金流，不要直接给数字");
  const marker = "DO_NOT_PUBLISH_THIS_ANSWER";
  let reviews = 0;
  const phases: string[] = [];
  const result = await runTeachingTurn(request, async (input) => {
    phases.push(input.purpose);
    if (input.purpose === "review")
      return ++reviews === 1 ? rejectingReview : ungradedReview;
    return JSON.stringify({
      ...lessonFor(draftFor(state)),
      message:
        input.purpose === "draft"
          ? marker
          : "现金从资产池流向持有人；先追踪这笔资金，再重新计算。",
    });
  });
  assert.deepEqual(phases, ["draft", "review", "repair", "review"]);
  assert.ok(!result.message.includes(marker));
  assert.equal(result.learningState!.revision, state.revision + 1);
  assert.deepEqual(state, snapshot);
  assert.equal(result.quality!.modelCalls, 4);
});

test("修订后仍不合格时拒绝发布，不无限重试，也不提交任何学习进度", async () => {
  const state = stateWithQuestion();
  const snapshot = structuredClone(state);
  let calls = 0;
  await assert.rejects(
    runTeachingTurn(requestFor(state, "我还没明白"), async (input) => {
      calls += 1;
      return input.purpose === "review"
        ? rejectingReview
        : JSON.stringify(lessonFor(draftFor(state)));
    }),
    (error: unknown) =>
      error instanceof TeachingQualityError &&
      error.status === 422 &&
      error.code === "TEACHING_QUALITY",
  );
  assert.equal(calls, 4);
  assert.deepEqual(state, snapshot);
});

test("评审没有issues字段不能被当成通过，即使其余检查全部自称true", async () => {
  const incomplete = JSON.parse(passingReview) as Record<string, unknown>;
  delete incomplete.issues;
  let calls = 0;
  await assert.rejects(
    runTeachingTurn(initialRequest(), async (input) => {
      calls += 1;
      return input.purpose === "review"
        ? JSON.stringify(incomplete)
        : JSON.stringify(lessonFor(openingDraft()));
    }),
    (error: unknown) =>
      error instanceof TeachingQualityError &&
      error.issues.some((issue) => issue.code === "review_invalid"),
  );
  assert.equal(calls, 4);
});

test("pass与未通过检查或非空问题清单矛盾时不能发布", async () => {
  const inconsistent = JSON.parse(passingReview);
  inconsistent.checks.calibration = false;
  inconsistent.issues = [
    { code: "unsupported_rule", detail: "将具体产品约定误说成普遍规则" },
  ];
  await assert.rejects(
    runTeachingTurn(initialRequest(), async (input) =>
      input.purpose === "review"
        ? JSON.stringify(inconsistent)
        : JSON.stringify(lessonFor(openingDraft())),
    ),
    (error: unknown) =>
      error instanceof TeachingQualityError &&
      error.issues.some((issue) => issue.code === "review_inconsistent"),
  );
});

test("密钥只属于供应商传输层，不得进入生成或独立评审的模型内容", async () => {
  const request = initialRequest();
  const secret = "test-only-private-provider-credential";
  request.settings = {
    provider: "openai",
    apiKey: secret,
    model: "local-contract",
    baseUrl: "http://localhost:9999/v1",
  };
  await runTeachingTurn(request, async (input) => {
    assert.ok(!input.system.includes(secret));
    assert.ok(!JSON.stringify(input.messages).includes(secret));
    return input.purpose === "review"
      ? passingReview
      : JSON.stringify(lessonFor(openingDraft()));
  });
});

test("认证或网络失败不能被包装成内容修订而继续产生调用费用", async () => {
  const error = new ApiError(401, "认证失败");
  let calls = 0;
  await assert.rejects(
    runTeachingTurn(initialRequest(), async () => {
      calls += 1;
      throw error;
    }),
    (candidate) => candidate === error,
  );
  assert.equal(calls, 1);
});

test("预先取消的学习回合不启动模型，也不提交状态", async () => {
  const controller = new AbortController();
  const reason = new DOMException("用户停止", "AbortError");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    runTeachingTurn(
      initialRequest(),
      async () => {
        calls += 1;
        return JSON.stringify(lessonFor(openingDraft()));
      },
      { signal: controller.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});

test(
  "供应商忽略中止信号时，客户端取消仍须立即结束，晚到草稿不得提交",
  { timeout: 2000 },
  async () => {
    const state = stateWithQuestion();
    const snapshot = structuredClone(state);
    const controller = new AbortController();
    const late = Promise.withResolvers<string>();
    const reason = new DOMException("学习者取消", "AbortError");
    let calls = 0;
    const pending = runTeachingTurn(
      requestFor(state, "暂停一下"),
      async () => {
        calls += 1;
        queueMicrotask(() => controller.abort(reason));
        return late.promise;
      },
      { signal: controller.signal },
    );
    await assert.rejects(pending, (error) => error === reason);
    late.resolve(JSON.stringify(lessonFor(draftFor(state))));
    assert.equal(calls, 1);
    assert.deepEqual(state, snapshot);
  },
);

test(
  "即使供应商永远不响应且不监听signal，整轮预算仍能超时拒绝",
  { timeout: 2000 },
  async () => {
    const state = stateWithQuestion();
    const snapshot = structuredClone(state);
    const never = Promise.withResolvers<string>();
    await assert.rejects(
      runTeachingTurn(
        requestFor(state, "解释一下"),
        async () => never.promise,
        { timeoutMs: 20 },
      ),
      (error: unknown) =>
        error instanceof TeachingQualityError &&
        error.status === 504 &&
        error.code === "TURN_TIMEOUT",
    );
    assert.deepEqual(state, snapshot);
  },
);

test("复检返回有效内容的同时发生取消，也不能越过最终提交边界", async () => {
  const state = stateWithQuestion();
  const snapshot = structuredClone(state);
  const controller = new AbortController();
  const reason = new DOMException("不再提交", "AbortError");
  await assert.rejects(
    runTeachingTurn(
      requestFor(state, "先别继续"),
      async (input) => {
        if (input.purpose === "review") {
          controller.abort(reason);
          return passingReview;
        }
        return JSON.stringify(lessonFor(draftFor(state)));
      },
      { signal: controller.signal },
    ),
    (error) => error === reason,
  );
  assert.deepEqual(state, snapshot);
});

test("无效持久化学习状态在请求模型之前拒绝，不能因输入坏数据产生多次付费修订", async () => {
  const state = stateWithQuestion();
  state.currentStepId = "missing-step";
  let calls = 0;
  await assert.rejects(
    runTeachingTurn(requestFor(state, "继续"), async () => {
      calls += 1;
      return JSON.stringify(lessonFor(openingDraft()));
    }),
    LearningProtocolError,
  );
  assert.equal(calls, 0);
});

test("无歧义层级与前提对象由程序整理，首轮两次调用即发布而不全文重写", async () => {
  const content = lessonFor(openingDraft());
  const phases: string[] = [];
  const result = await runTeachingTurn(initialRequest(), async input => {
    phases.push(input.purpose);
    if (input.purpose === "review") return passingReview;
    return JSON.stringify({ message: content.message, teaching: { title: content.title, plan: content.plan, question: content.question, assumptions: [{ role: "本例立场", content: "银行代销理财公司产品" }] } });
  });
  assert.deepEqual(phases, ["draft", "review"]);
  assert.equal(result.quality!.modelCalls, 2);
  assert.equal(result.quality!.repaired, false);
  assert.equal(result.learningState!.steps.length, content.plan!.length);
  assert.deepEqual(result.learningState!.assumptions, ["本例立场：银行代销理财公司产品"]);
  assert.ok(result.learningState!.steps.every(step => step.mastery !== "understood" && step.mastery !== "applied" && step.evidence.length === 0));
});

test("只有评审格式错时补小评审，原稿不改写且只提交一轮状态", async () => {
  const state = stateWithQuestion();
  const snapshot = structuredClone(state);
  const phases: string[] = [];
  let reviews = 0;
  const result = await runTeachingTurn(requestFor(state, "请解释资金流"), async input => {
    phases.push(input.purpose);
    if (input.purpose === "review") return ++reviews === 1 ? "not json" : ungradedReview;
    return JSON.stringify(lessonFor(draftFor(state)));
  });
  assert.deepEqual(phases, ["draft", "review", "review"]);
  assert.equal(result.quality!.modelCalls, 3);
  assert.equal(result.quality!.reviewAttempts, 2);
  assert.equal(result.quality!.repaired, false);
  assert.equal(result.learningState!.revision, state.revision + 1);
  assert.deepEqual(state, snapshot);
});

test("评审连续两次格式错误时在总预算内继续修正，第三次合格才发布", async () => {
  const state = stateWithQuestion();
  const phases: string[] = [];
  let reviews = 0;
  const result = await runTeachingTurn(requestFor(state, "请解释资金流"), async input => {
    phases.push(input.purpose);
    if (input.purpose === "review") return ++reviews < 3 ? "not json" : ungradedReview;
    return JSON.stringify(lessonFor(draftFor(state)));
  });
  assert.deepEqual(phases, ["draft", "review", "review", "review"]);
  assert.equal(result.quality!.modelCalls, 4);
  assert.equal(result.quality!.reviewAttempts, 3);
  assert.equal(result.quality!.repaired, false);
});

test("反馈抢答只重做评审，不浪费整篇重写，也不将整理算作模型修订", async () => {
  const state = stateWithQuestion();
  const phases: string[] = [];
  let reviews = 0;
  const result = await runTeachingTurn(requestFor(state, "我知道有现金转出，但以为产品资产不变。"), async input => {
    phases.push(input.purpose);
    if (input.purpose !== "review") return JSON.stringify(lessonFor(draftFor(state)));
    reviews += 1;
    return JSON.stringify({ ...JSON.parse(passingReview), decision: {
      intent: "answer", move: "repair",
      assessment: { verdict: "partial", demonstrated: "recognition", feedback: reviews === 1 ? "最终结果是1.0500。" : "现金来源已想到，还需要核对转出后产品资产的变化。" },
      misconception: { statement: "把转出现金仍计入产品资产" },
    } });
  });
  assert.deepEqual(phases, ["draft", "review", "review"]);
  assert.equal(result.quality!.modelCalls, 3);
  assert.equal(result.quality!.repaired, false);
  assert.equal(result.quality!.reviewAttempts, 2);
  assert.ok(!result.message.includes("1.05"));
  assert.equal(result.learningState!.misconceptions[0].status, "repairing");
  assert.equal(result.learningState!.steps[0].mastery, "learning");
});

test("旧聊天初始化缺路线且数值题误标reasoning时，一次修订处理全部已知问题", async () => {
  const phases: string[] = [];
  const request: ChatRequest = { ...initialRequest(), action: "message", messages: [{ role: "assistant", content: "原值1.10，分红0.05，无其它变动，分红后净值是多少？" }, { role: "user", content: "1.10和1.15" }] };
  const result = await runTeachingTurn(request, async input => {
    phases.push(input.purpose);
    if (input.purpose === "review") return passingReview;
    const content = lessonFor(openingDraft());
    return JSON.stringify(input.purpose === "draft" ? {
      ...content,
      plan: undefined,
      message: "产品原值1.10，分红0.05后单位净值是1.0500，再把它算一遍。",
      question: { prompt: "原值1.10，每份分红0.05，无其它变动，剩在产品里的价值是多少？", kind: "reasoning", options: [], successCriteria: ["1.10减去0.05得到1.05，说明现金转出产品"] },
    } : content);
  });
  assert.deepEqual(phases, ["draft", "repair", "review"]);
  assert.equal(result.quality!.modelCalls, 3);
  assert.equal(result.quality!.reviewAttempts, 1);
  assert.ok(!result.message.includes("1.05"));
  assert.deepEqual(result.learningState!.steps[0].evidence, []);
  assert.equal(result.learningState!.lastAssessment!.verdict, "not_assessed");
});

test("改写重发时旧的未回复输入只作为历史，当前回答仍是唯一作答", async () => {
  const state = stateWithQuestion();
  const request = requestFor(state, "第一次回答");
  request.messages.push({ role: "user", content: "第二次改写回答" });
  let writerHistory: Pick<ChatMessage, "role" | "content">[] = [];
  await runTeachingTurn(request, async (input) => {
    if (input.purpose === "draft") writerHistory = input.messages;
    return input.purpose === "review"
      ? ungradedReview
      : JSON.stringify(lessonFor(draftFor(state)));
  });
  const stale = writerHistory.find((message) => message.content.includes("第一次回答"));
  const current = writerHistory.find((message) => message.content === "第二次改写回答");
  assert.ok(stale?.content.startsWith("（此前已发送但未获得导师回复的旧学习者输入"));
  assert.equal(current?.content, "第二次改写回答");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { LearningEvidence } from "../src/types";
import {
  createTransferTrack,
  isTrackComplete,
  recordTransferAnswer,
  requiredEvidenceForLevel,
  TransferTrackError,
  type TransferStepSpec,
} from "../src/lib/transfer";

const NOW = 1_700_000_000_000;

const specs: TransferStepSpec[] = [
  {
    id: "t-variant",
    title: "同概念变式：换一组数字重算分红后的净值",
    scenario: "原净值1.20，每份分红0.08",
    prompt: "分红后单位净值与累计净值各是多少？请解释资金从哪来。",
    expectedFocus: "现金从资产池转出，单位净值下降，累计净值不变",
    questionId: "q-variant-1",
  },
  {
    id: "t-context",
    title: "新情境：把机制搬到客户投诉场景",
    scenario: "客户坚持分红当日总资产应增加",
    prompt: "用净值机制解释客户哪里理解错了？",
    expectedFocus: "价值从产品资产转入现金账户，总额不变",
    questionId: "q-context-1",
  },
  {
    id: "t-mixed",
    title: "综合边界：分红叠加申购赎回",
    scenario: "分红当日还有大额申购",
    prompt: "此时单位净值与份额如何联动？边界条件是什么？",
    expectedFocus: "分红影响净值，申购影响份额，两者机制独立",
    questionId: "q-mixed-1",
  },
];

function evidence(
  questionId: string,
  kind: LearningEvidence["kind"],
  quote = "资金从产品资产池转出到客户现金账户，所以单位净值下降但累计净值不变。",
): LearningEvidence {
  return { quote, questionId, kind, turn: 3 };
}

function track() {
  return createTransferTrack({ id: "track-1", sessionId: "s-1", steps: specs, now: NOW });
}

test("轨道按 变式→新情境→综合边界 建立层级，题目 id 原样保留", () => {
  const t = track();
  assert.deepEqual(
    t.steps.map((s) => s.level),
    ["variant", "context", "mixed"],
  );
  assert.deepEqual(
    t.steps.map((s) => s.questionId),
    ["q-variant-1", "q-context-1", "q-mixed-1"],
  );
  assert.deepEqual(
    t.steps.map((s) => s.status),
    ["current", "available", "available"],
  );
  assert.equal(t.currentStepId, "t-variant");
  assert.equal(t.createdAt, NOW);
  assert.equal(t.updatedAt, NOW);
});

test("完整轨道拒绝首步非变式、层级倒退与空轨道，显式层级保持不变", () => {
  const custom = createTransferTrack({
    id: "track-2",
    sessionId: "s-1",
    steps: specs.map((s, i) => ({
      ...s,
      id: `c-${i}`,
      level: (["variant", "variant", "context"] as const)[i],
    })),
    now: NOW,
  });
  assert.deepEqual(
    custom.steps.map((s) => s.level),
    ["variant", "variant", "context"],
  );

  assert.throws(
    () =>
      createTransferTrack({
        id: "bad-1",
        sessionId: "s-1",
        steps: [{ ...specs[0], level: "context" }, specs[1], specs[2]],
        now: NOW,
      }),
    (err: unknown) => err instanceof TransferTrackError && err.code === "bad_level_order",
  );
  assert.throws(
    () =>
      createTransferTrack({
        id: "bad-2",
        sessionId: "s-1",
        steps: [specs[0], specs[1], { ...specs[2], level: "variant" }],
        now: NOW,
      }),
    (err: unknown) => err instanceof TransferTrackError && err.code === "bad_level_order",
  );
  assert.throws(
    () => createTransferTrack({ id: "bad-3", sessionId: "s-1", steps: [], now: NOW }),
    (err: unknown) => err instanceof TransferTrackError && err.code === "empty_track",
  );
});

test("导师当前真实迁移题可以直接作为首关：单题 context 轨道以它作为 current", () => {
  const t = createTransferTrack({
    id: "track-real",
    sessionId: "s-1",
    steps: [
      {
        id: "transfer-q-real",
        title: "导师当前给出的新情境迁移题",
        scenario: "客户在分红当日核对总资产",
        prompt: "用净值机制说明客户哪里理解错了。",
        expectedFocus: "价值从资产转入现金账户，总额不变",
        questionId: "q-real",
        level: "context",
      },
    ],
    now: NOW,
  });
  assert.equal(t.currentStepId, "transfer-q-real");
  assert.deepEqual(t.steps.map((s) => s.level), ["context"]);
  assert.deepEqual(t.steps.map((s) => s.status), ["current"]);
  assert.deepEqual(t.steps.map((s) => s.questionId), ["q-real"]);
  assert.equal(t.createdAt, NOW);
  assert.equal(t.updatedAt, NOW);
});

test("首关 context 仍按迁移证据门槛核验：答错、类型不足、题号不符都不推进", () => {
  const t = createTransferTrack({
    id: "track-real-2",
    sessionId: "s-1",
    steps: [
      {
        id: "transfer-q-real-2",
        title: "导师当前给出的新情境迁移题",
        scenario: "客户在分红当日核对总资产",
        prompt: "用净值机制说明客户哪里理解错了。",
        expectedFocus: "价值从资产转入现金账户，总额不变",
        questionId: "q-real-2",
        level: "context",
      },
    ],
    now: NOW,
  });
  const stepId = t.currentStepId;

  let result = recordTransferAnswer(
    t,
    { stepId, verdict: "incorrect", evidence: evidence("q-real-2", "transfer") },
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "verdict_not_correct");
  assert.deepEqual(result.track.steps, t.steps);

  result = recordTransferAnswer(
    t,
    { stepId, verdict: "correct", evidence: evidence("q-real-2", "reasoning") },
    NOW + 2,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");
  assert.equal(result.requiredEvidence, "transfer");
  assert.equal(result.track.steps[0].status, "current");

  result = recordTransferAnswer(
    t,
    { stepId, verdict: "correct", evidence: evidence("q-other", "transfer") },
    NOW + 3,
  );
  assert.equal(result.reason, "question_mismatch");
  assert.equal(result.track.steps[0].status, "current");

  result = recordTransferAnswer(
    t,
    { stepId, verdict: "correct", evidence: evidence("q-real-2", "recognition") },
    NOW + 4,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");

  result = recordTransferAnswer(
    t,
    { stepId, verdict: "correct", evidence: evidence("q-real-2", "transfer") },
    NOW + 5,
  );
  assert.equal(result.outcome, "passed");
  assert.equal(result.track.steps[0].status, "done");
  assert.ok(isTrackComplete(result.track));
});

test("startIndex 从当前真实题起轨：起点前步骤已完成且不能被作答伪造", () => {
  const t = createTransferTrack({
    id: "track-resume",
    sessionId: "s-1",
    steps: specs,
    now: NOW,
    startIndex: 1,
  });
  assert.equal(t.currentStepId, "t-context");
  assert.deepEqual(
    t.steps.map((s) => s.status),
    ["done", "current", "available"],
  );

  // 起点之前已完成的步骤不是当前关卡：补答不能推进任何东西。
  let result = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-variant-1", "reasoning") },
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "not_current_step");
  assert.equal(result.requiredEvidence, "transfer");
  assert.deepEqual(result.track.steps, t.steps);
  assert.equal(result.track.updatedAt, NOW);

  // 当前 context 关卡仍只接受迁移证据。
  result = recordTransferAnswer(
    t,
    { stepId: "t-context", verdict: "correct", evidence: evidence("q-context-1", "reasoning") },
    NOW + 2,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");

  result = recordTransferAnswer(
    t,
    { stepId: "t-context", verdict: "correct", evidence: evidence("q-context-1", "transfer") },
    NOW + 3,
  );
  assert.equal(result.outcome, "passed");
  assert.equal(result.track.currentStepId, "t-mixed");
  assert.deepEqual(
    result.track.steps.map((s) => s.status),
    ["done", "done", "current"],
  );
});

test("非法 startIndex 被拒绝，不会凭空构造 current", () => {
  for (const startIndex of [-1, 3, 1.5]) {
    assert.throws(
      () =>
        createTransferTrack({
          id: "bad-start",
          sessionId: "s-1",
          steps: specs,
          now: NOW,
          startIndex,
        }),
      (err: unknown) =>
        err instanceof TransferTrackError && err.code === "bad_start_index",
    );
  }
});

test("层级证据门槛：变式要推理，新情境与综合要迁移，识别永远不够", () => {
  assert.equal(requiredEvidenceForLevel("variant"), "reasoning");
  assert.equal(requiredEvidenceForLevel("context"), "transfer");
  assert.equal(requiredEvidenceForLevel("mixed"), "transfer");
});

test("只接受当前步骤的作答，证据必须对应本题的 questionId", () => {
  const t = track();
  // 答的是后面的步骤：轨道原样返回
  let result = recordTransferAnswer(
    t,
    { stepId: "t-context", verdict: "correct", evidence: evidence("q-context-1", "transfer") },
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "not_current_step");
  assert.equal(result.track.updatedAt, NOW);
  assert.deepEqual(result.track.steps, t.steps);

  // 题目 id 对不上：换一道题的作答不能冒充本题证据
  result = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-other", "reasoning") },
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "question_mismatch");
  assert.equal(result.track.currentStepId, "t-variant");
});

test("答错/模糊/部分正确时停留在原步骤，可原地重试，题目不变", () => {
  for (const verdict of ["incorrect", "partial", "uncertain"] as const) {
    const t = track();
    const result = recordTransferAnswer(
      t,
      { stepId: "t-variant", verdict, evidence: evidence("q-variant-1", "reasoning") },
      NOW + 5,
    );
    assert.equal(result.outcome, "retry");
    assert.equal(result.reason, "verdict_not_correct");
    assert.equal(result.track.currentStepId, "t-variant");
    assert.equal(result.track.steps[0].status, "current");
    assert.equal(result.track.steps[0].questionId, "q-variant-1");
    assert.equal(result.track.updatedAt, NOW);
  }
});

test("识别证据即使答对也不能推进任何层级", () => {
  const t = track();
  const result = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-variant-1", "recognition") },
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "evidence_kind_mismatch");
  assert.equal(result.requiredEvidence, "reasoning");
  assert.equal(result.track.steps[0].status, "current");
});

test("变式层需要推理证据；新情境层推理不够，必须迁移证据", () => {
  const t = track();
  // 变式层：迁移证据类型不符（需要 reasoning）
  let result = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-variant-1", "transfer") },
    NOW + 1,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");

  const afterVariant = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-variant-1", "reasoning") },
    NOW + 2,
  );
  assert.equal(afterVariant.outcome, "passed");
  assert.equal(afterVariant.track.currentStepId, "t-context");
  assert.deepEqual(
    afterVariant.track.steps.map((s) => s.status),
    ["done", "current", "available"],
  );

  // 新情境层：推理证据不足以证明迁移
  result = recordTransferAnswer(
    afterVariant.track,
    { stepId: "t-context", verdict: "correct", evidence: evidence("q-context-1", "reasoning") },
    NOW + 3,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");
  assert.equal(result.requiredEvidence, "transfer");
  assert.equal(result.track.currentStepId, "t-context");
});

test("空引语不算证据，已完成的步骤不接受重复作答", () => {
  const t = track();
  let result = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-variant-1", "reasoning", "   ") },
    NOW + 1,
  );
  assert.equal(result.reason, "empty_quote");

  // 通过最后一题后 current 仍停在最后一步，重复作答同一题被拒
  const passed = recordTransferAnswer(
    t,
    { stepId: "t-mixed", verdict: "correct", evidence: evidence("q-mixed-1", "transfer") },
    NOW + 2,
  );
  assert.equal(passed.outcome, "retry"); // 前面的步骤还没通过，末题不是当前题

  const afterVariant = recordTransferAnswer(
    t,
    { stepId: "t-variant", verdict: "correct", evidence: evidence("q-variant-1", "reasoning") },
    NOW + 2,
  );
  const finished = recordTransferAnswer(
    afterVariant.track,
    { stepId: "t-context", verdict: "correct", evidence: evidence("q-context-1", "transfer") },
    NOW + 3,
  );
  const lastPass = recordTransferAnswer(
    finished.track,
    { stepId: "t-mixed", verdict: "correct", evidence: evidence("q-mixed-1", "transfer") },
    NOW + 4,
  );
  assert.equal(lastPass.outcome, "passed");
  const retake = recordTransferAnswer(
    lastPass.track,
    { stepId: "t-mixed", verdict: "correct", evidence: evidence("q-mixed-1", "transfer") },
    NOW + 5,
  );
  assert.equal(retake.reason, "already_done");
  assert.equal(retake.track.updatedAt, NOW + 4);
});

test("逐层独立作答通过后轨道完成；未完成时 isTrackComplete 为 false", () => {
  let t = track();
  assert.equal(isTrackComplete(t), false);
  const answers = [
    { stepId: "t-variant", quoteQ: "q-variant-1", kind: "reasoning" as const },
    { stepId: "t-context", quoteQ: "q-context-1", kind: "transfer" as const },
    { stepId: "t-mixed", quoteQ: "q-mixed-1", kind: "transfer" as const },
  ];
  let time = NOW;
  for (const a of answers) {
    const result = recordTransferAnswer(
      t,
      { stepId: a.stepId, verdict: "correct", evidence: evidence(a.quoteQ, a.kind) },
      (time += 100),
    );
    assert.equal(result.outcome, "passed");
    t = result.track;
  }
  assert.ok(isTrackComplete(t));
  assert.deepEqual(
    t.steps.map((s) => s.status),
    ["done", "done", "done"],
  );
  // 末步通过后 current 停在最后一步，不指向不存在的步骤
  assert.equal(t.currentStepId, "t-mixed");
  assert.equal(t.updatedAt, NOW + 300);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { LearningEvidence, LearningQuestion } from "../src/types";
import {
  createTransferTrack,
  isTrackComplete,
  recordTransferAnswer,
  syncTransferQuestion,
  type TransferAnswer,
  type TransferStepSpec,
} from "../src/lib/transfer";

const NOW = 1_700_000_000_000;

/** 导师实际给出的迁移题（不是选择题，也没有预生成选项）。 */
function liveQuestion(id: string, prompt: string): LearningQuestion {
  return {
    id,
    stepId: "step-live",
    prompt,
    kind: "transfer",
    options: [],
    successCriteria: ["把机制应用到新情境并说明边界"],
    scope: "main",
  };
}

/** 学习者真实作答里能逐字找到的原话，作为独立证据交给轨道核验。 */
function evidenceFor(
  questionId: string,
  kind: LearningEvidence["kind"],
  quote = "分红只是把价值从产品资产转入客户现金账户，客户总资产不变。",
): LearningEvidence {
  return { quote, questionId, kind, turn: 5 };
}

function stepFromQuestion(
  question: LearningQuestion,
  level: TransferStepSpec["level"],
): TransferStepSpec {
  return {
    id: `transfer-${question.id}`,
    title: question.prompt.slice(0, 60),
    scenario: question.prompt,
    prompt: question.prompt,
    expectedFocus: question.successCriteria[0] ?? "在新情境解释机制",
    questionId: question.id,
    level,
  };
}

function answer(
  stepId: string,
  verdict: TransferAnswer["verdict"],
  evidence: LearningEvidence,
): TransferAnswer {
  return { stepId, verdict, evidence };
}

test("从导师当前迁移题建立首关：错误/推理证据/错题号都不推进，真实迁移证据才完成轨道", () => {
  const question = liveQuestion(
    "q-live-1",
    "客户认为分红当日总资产应增加。请用净值机制说明他错在哪，并指出总额是否变化。",
  );

  // 与 App 相同的真实调用：当前没有轨道时，用导师刚给出的题建立单题轨道。
  let track = createTransferTrack({
    id: "track-live",
    sessionId: "session-1",
    now: NOW,
    steps: [stepFromQuestion(question, "context")],
  });
  const stepId = track.currentStepId;
  assert.equal(stepId, `transfer-${question.id}`);
  assert.equal(track.steps[0].questionId, question.id);
  assert.equal(track.steps[0].status, "current");

  // 1. 导师判定本次回答不成立：轨道原样保留，学习者原地重试。
  let result = recordTransferAnswer(
    track,
    answer(stepId, "incorrect", evidenceFor(question.id, "transfer")),
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "verdict_not_correct");
  assert.deepEqual(result.track.steps, track.steps);
  assert.equal(result.track.updatedAt, NOW);

  // 2. 只给出推理过程：新情境关卡要求迁移证据。
  result = recordTransferAnswer(
    track,
    answer(
      stepId,
      "correct",
      evidenceFor(question.id, "reasoning", "分红就是把资产池的价值分配出去。"),
    ),
    NOW + 2,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");
  assert.equal(result.requiredEvidence, "transfer");
  assert.equal(result.track.steps[0].status, "current");

  // 3. 引用另一道题的证据：题号不匹配，不能冒充本题迁移。
  result = recordTransferAnswer(
    track,
    answer(stepId, "correct", evidenceFor("q-somewhere-else", "transfer")),
    NOW + 3,
  );
  assert.equal(result.reason, "question_mismatch");
  assert.deepEqual(result.track.steps, track.steps);

  // 4. 真实迁移证据：通过并完成。
  result = recordTransferAnswer(
    track,
    answer(stepId, "correct", evidenceFor(question.id, "transfer")),
    NOW + 4,
  );
  assert.equal(result.outcome, "passed");
  assert.equal(result.reason, "passed");
  assert.equal(result.requiredEvidence, "transfer");
  assert.equal(result.track.steps[0].status, "done");
  assert.equal(result.track.updatedAt, NOW + 4);
  assert.ok(isTrackComplete(result.track));

  // 5. 同一题再次"通过"不能重复推进或刷新时间。
  track = result.track;
  result = recordTransferAnswer(
    track,
    answer(stepId, "correct", evidenceFor(question.id, "transfer", "再写一次机制。")),
    NOW + 5,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "already_done");
  assert.equal(result.track.updatedAt, NOW + 4);
});

test("从第二题起轨：起点之前不能被作答伪造，当前题仍要真实迁移证据", () => {
  const first = liveQuestion("q-live-a", "换一组数字重算分红后的单位净值与累计净值。");
  const second = liveQuestion(
    "q-live-b",
    "客户坚持分红当日总资产应增加。请把净值机制迁移到这个投诉场景。",
  );

  const track = createTransferTrack({
    id: "track-resume",
    sessionId: "session-1",
    now: NOW,
    startIndex: 1,
    steps: [stepFromQuestion(first, "variant"), stepFromQuestion(second, "context")],
  });
  assert.equal(track.currentStepId, `transfer-${second.id}`);
  assert.deepEqual(
    track.steps.map((step) => step.status),
    ["done", "current"],
  );

  // 起点之前的题已经是历史关卡，补答不会让它重新变成 current。
  let result = recordTransferAnswer(
    track,
    answer(`transfer-${first.id}`, "correct", evidenceFor(first.id, "reasoning")),
    NOW + 1,
  );
  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "not_current_step");
  assert.equal(result.requiredEvidence, "transfer");
  assert.deepEqual(result.track.steps, track.steps);

  // 当前题先给出推理证据仍不够。
  result = recordTransferAnswer(
    track,
    answer(`transfer-${second.id}`, "correct", evidenceFor(second.id, "reasoning")),
    NOW + 2,
  );
  assert.equal(result.reason, "evidence_kind_mismatch");

  // 真正的迁移证据才推进到下一关。
  result = recordTransferAnswer(
    track,
    answer(`transfer-${second.id}`, "correct", evidenceFor(second.id, "transfer")),
    NOW + 3,
  );
  assert.equal(result.outcome, "passed");
  assert.equal(result.track.currentStepId, `transfer-${second.id}`);
  assert.deepEqual(
    result.track.steps.map((step) => step.status),
    ["done", "done"],
  );
  assert.ok(isTrackComplete(result.track));
});

test("错答后导师换新题：未通过的旧关卡不会被关闭，新题独立通过才完成", () => {
  const first = liveQuestion("q-retry-a", "第一次迁移应用。");
  const second = liveQuestion("q-retry-b", "修复误区后的另一情境。");
  const initial = createTransferTrack({
    id: "track-retry", sessionId: "session-retry", now: NOW,
    steps: [stepFromQuestion(first, "context")],
  });
  const failed = recordTransferAnswer(
    initial,
    answer(initial.currentStepId, "partial", evidenceFor(first.id, "reasoning")),
    NOW + 1,
  );
  assert.equal(failed.outcome, "retry");

  // App 在下一题作答时使用同一个同步函数，不再用 startIndex 把旧题置为 done。
  const replaced = syncTransferQuestion({
    track: failed.track, question: second, sessionId: "session-retry",
    now: NOW + 2, newId: () => "unused",
  });
  assert.equal(replaced.steps.length, 1);
  assert.equal(replaced.currentStepId, `transfer-${second.id}`);
  assert.equal(replaced.steps[0].questionId, second.id);
  assert.equal(replaced.steps[0].status, "current");
  assert.ok(!isTrackComplete(replaced));

  const passed = recordTransferAnswer(
    replaced,
    answer(replaced.currentStepId, "correct", evidenceFor(second.id, "transfer", "这是新题的真实迁移解释。")),
    NOW + 3,
  );
  assert.equal(passed.outcome, "passed");
  assert.equal(passed.track.steps[0].status, "done");
  assert.equal(passed.track.steps[0].questionId, second.id);
});

test("已完成轨道可以追加导师新题，但已有失败关卡不会被追加操作补成完成", () => {
  const first = liveQuestion("q-history-done", "已经完成的真实迁移题。");
  const second = liveQuestion("q-history-new", "下一道新情境题。");
  const initial = createTransferTrack({
    id: "track-history", sessionId: "session-history", now: NOW,
    steps: [stepFromQuestion(first, "context")],
  });
  const completed = recordTransferAnswer(
    initial,
    answer(initial.currentStepId, "correct", evidenceFor(first.id, "transfer")),
    NOW + 1,
  ).track;
  const appended = syncTransferQuestion({
    track: completed, question: second, sessionId: "session-history",
    now: NOW + 2, newId: () => "unused",
  });
  assert.deepEqual(appended.steps.map(step => step.status), ["done", "current"]);
  assert.equal(appended.currentStepId, `transfer-${second.id}`);
  assert.ok(!isTrackComplete(appended));
});

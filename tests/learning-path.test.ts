import assert from "node:assert/strict";
import test from "node:test";
import type { PathStep } from "../src/types";
import {
  computePathProgress,
  describePathProgress,
  LearningPathError,
  parsePathStepStatus,
  selectResumeStepId,
  validatePathDependencies,
} from "../src/lib/learningPath";

function step(overrides: Partial<PathStep> & Pick<PathStep, "id" | "title">): PathStep {
  return {
    goal: "",
    dependencyIds: [],
    estimatedMinutes: 10,
    status: "locked",
    ...overrides,
  };
}

const linear: PathStep[] = [
  step({ id: "p1", title: "分红与两种净值", goal: "解释现金分红的资金流" }),
  step({ id: "p2", title: "本地额度与外部确认", goal: "划清额度边界", dependencyIds: ["p1"], estimatedMinutes: 25 }),
  step({ id: "p3", title: "综合投诉分析", goal: "在新情境应用机制", dependencyIds: ["p2"], estimatedMinutes: 15 }),
];

test("初始路径：第一步 current，依赖未满足的后续保持 locked", () => {
  const progress = computePathProgress(linear, []);
  assert.equal(progress.currentStepId, "p1");
  assert.deepEqual(
    progress.steps.map((s) => s.status),
    ["current", "locked", "locked"],
  );
  assert.deepEqual(progress.doneStepIds, []);
  assert.deepEqual(progress.lockedStepIds, ["p2", "p3"]);
  assert.equal(progress.remainingMinutes, 50);
});

test("完成前置后解锁后续：done 保持，current 前移，剩余分钟递减", () => {
  const progress = computePathProgress(linear, ["p1"]);
  assert.equal(progress.currentStepId, "p2");
  assert.deepEqual(progress.steps.map((s) => s.status), ["done", "current", "locked"]);
  assert.deepEqual(progress.doneStepIds, ["p1"]);
  assert.deepEqual(progress.availableStepIds, []);
  assert.equal(progress.remainingMinutes, 40);

  const more = computePathProgress(linear, ["p1", "p2"]);
  assert.equal(more.currentStepId, "p3");
  assert.deepEqual(more.steps.map((s) => s.status), ["done", "done", "current"]);
  assert.equal(more.remainingMinutes, 15);
});

test("依赖未满足的步骤保持 locked，即使它在数组中排前面", () => {
  const graph: PathStep[] = [
    step({ id: "a", title: "后置步骤", dependencyIds: ["c"] }),
    step({ id: "b", title: "入口步骤" }),
    step({ id: "c", title: "中间步骤", dependencyIds: ["b"] }),
  ];
  const progress = computePathProgress(graph, ["b"]);
  assert.equal(progress.currentStepId, "c");
  assert.deepEqual(progress.steps.map((s) => s.status), ["locked", "done", "current"]);
  assert.deepEqual(progress.lockedStepIds, ["a"]);
  assert.deepEqual(progress.availableStepIds, []);
});

test("菱形依赖：两条前置都完成后才解锁汇聚步骤", () => {
  const graph: PathStep[] = [
    step({ id: "root", title: "起点" }),
    step({ id: "left", title: "左支", dependencyIds: ["root"], estimatedMinutes: 20 }),
    step({ id: "right", title: "右支", dependencyIds: ["root"], estimatedMinutes: 30 }),
    step({ id: "join", title: "汇聚", dependencyIds: ["left", "right"] }),
  ];
  const half = computePathProgress(graph, ["root", "left"]);
  assert.deepEqual(half.steps.map((s) => s.status), ["done", "done", "current", "locked"]);
  assert.deepEqual(half.availableStepIds, []);
  assert.equal(half.remainingMinutes, 40); // right 30 + join 默认 10

  const both = computePathProgress(graph, ["root", "left", "right"]);
  assert.equal(both.currentStepId, "join");
  assert.equal(both.remainingMinutes, 10); // join 用默认 10 分钟
});

test("全部完成时没有 current，剩余分钟为 0", () => {
  const progress = computePathProgress(linear, ["p1", "p2", "p3"]);
  assert.equal(progress.currentStepId, null);
  assert.deepEqual(progress.steps.map((s) => s.status), ["done", "done", "done"]);
  assert.equal(progress.remainingMinutes, 0);
});

test("拒绝环依赖与未知依赖", () => {
  const cycle: PathStep[] = [
    step({ id: "x", title: "X", dependencyIds: ["y"] }),
    step({ id: "y", title: "Y", dependencyIds: ["z"] }),
    step({ id: "z", title: "Z", dependencyIds: ["x"] }),
  ];
  assert.throws(
    () => computePathProgress(cycle, []),
    (err: unknown) => err instanceof LearningPathError && err.code === "dependency_cycle",
  );
  assert.throws(
    () => validatePathDependencies([{ id: "self", dependencyIds: ["self"] }]),
    (err: unknown) => err instanceof LearningPathError && err.code === "dependency_cycle",
  );
  assert.throws(
    () => validatePathDependencies([{ id: "dangling", dependencyIds: ["nope"] }]),
    (err: unknown) => err instanceof LearningPathError && err.code === "unknown_dependency",
  );
  // 合法图不抛错
  assert.doesNotThrow(() => validatePathDependencies(linear));
});

test("断点续学：保留真实 current；前置未核验时也不回写掌握证据", () => {
  // 记录的是已解锁但不是首个可学步骤：尊重返回记录
  const diamond: PathStep[] = [
    step({ id: "root", title: "起点" }),
    step({ id: "left", title: "左支", dependencyIds: ["root"] }),
    step({ id: "right", title: "右支", dependencyIds: ["root"] }),
  ];
  const resume = computePathProgress(diamond, ["root", "left"], "right");
  assert.equal(selectResumeStepId(resume), "right");

  // 记录的步骤已 done：回退到第一个可学步骤
  const stale = computePathProgress(diamond, ["root", "left"], "left");
  assert.equal(selectResumeStepId(stale), "right");

  // 已听后续但前置未核验：保留授课位置；前置仍可学，全部保持未完成。
  const locked = computePathProgress(diamond, [], "right");
  assert.equal(selectResumeStepId(locked), "right");
  assert.equal(locked.steps.find(step => step.id === "right")?.status, "current");
  assert.equal(locked.steps.find(step => step.id === "root")?.status, "available");
  assert.deepEqual(locked.doneStepIds, []);

  // 没有记录：按顺序第一个可学步骤
  const fresh = computePathProgress(linear, []);
  assert.equal(selectResumeStepId(fresh), "p1");

  // 全部完成：返回 null
  const done = computePathProgress(linear, ["p1", "p2", "p3"]);
  assert.equal(selectResumeStepId(done), null);
});

test("待答提示保留在步骤上，出现在进度描述里", () => {
  const withPending: PathStep[] = [
    step({ id: "p1", title: "分红与两种净值", pendingPrompt: "分红后单位净值是多少？" }),
    step({ id: "p2", title: "额度边界", dependencyIds: ["p1"] }),
  ];
  const progress = computePathProgress(withPending, []);
  const current = progress.steps.find((s) => s.id === "p1")!;
  assert.equal(current.pendingPrompt, "分红后单位净值是多少？");
  const description = describePathProgress(progress);
  assert.ok(description.includes("分红与两种净值"));
  assert.ok(description.includes("20")); // 10 + 默认 10
  assert.ok(description.includes("待答：分红后单位净值是多少？"));
});

test("路径描述区分完成、进行中与无可用下一步", () => {
  assert.equal(
    describePathProgress(computePathProgress(linear, ["p1", "p2", "p3"])),
    "学习路径已全部完成",
  );
  const blocked: PathStep[] = [
    step({ id: "a", title: "A" }),
    step({ id: "b", title: "B", dependencyIds: ["a"] }),
  ];
  // 全 done 但 remainingMinutes 为 0，视为完成
  assert.equal(describePathProgress(computePathProgress(blocked, ["a", "b"])), "学习路径已全部完成");
  // 构造 current 为 null 但仍有剩余分钟的进度（不可达图被校验拒绝，直接给对象）
  const manual = {
    steps: [step({ id: "a", title: "A", dependencyIds: ["b"] }), step({ id: "b", title: "B" })],
    currentStepId: null,
    availableStepIds: [],
    doneStepIds: [],
    lockedStepIds: ["a"],
    remainingMinutes: 10,
  };
  assert.equal(describePathProgress(manual), "没有可学的下一步，先完成前面的步骤");
});

test("parsePathStepStatus 拒绝未知状态回退到 locked", () => {
  assert.equal(parsePathStepStatus("current"), "current");
  assert.equal(parsePathStepStatus("done"), "done");
  assert.equal(parsePathStepStatus("available"), "available");
  assert.equal(parsePathStepStatus("locked"), "locked");
  assert.equal(parsePathStepStatus("done "), "locked");
  assert.equal(parsePathStepStatus(42), "locked");
  assert.equal(parsePathStepStatus(undefined), "locked");
});

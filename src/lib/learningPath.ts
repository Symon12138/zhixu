import type { PathStep } from "../types";

export type PathStepStatus = PathStep["status"];

export class LearningPathError extends Error {
  code: "unknown_dependency" | "dependency_cycle";

  constructor(code: "unknown_dependency" | "dependency_cycle", message: string) {
    super(message);
    this.name = "LearningPathError";
    this.code = code;
  }
}

export interface PathProgress {
  steps: PathStep[];
  /** 当前待学步骤 id，全部完成时为 null。 */
  currentStepId: string | null;
  /** 未完成且依赖已满足的可学步骤 id 列表。 */
  availableStepIds: string[];
  doneStepIds: string[];
  lockedStepIds: string[];
  /** 所有未完成步骤的预计分钟之和。 */
  remainingMinutes: number;
}

export function parsePathStepStatus(value: unknown): PathStepStatus {
  return value === "locked" || value === "available" || value === "current" || value === "done"
    ? value
    : "locked";
}

/** 校验依赖图：依赖必须指向已知步骤、不允许自依赖，且用 Kahn 算法拒绝环。 */
export function validatePathDependencies(
  steps: Pick<PathStep, "id" | "dependencyIds">[],
): void {
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dep of step.dependencyIds) {
      if (!ids.has(dep)) {
        throw new LearningPathError(
          "unknown_dependency",
          `步骤 ${step.id} 依赖了不存在的步骤 ${dep}`,
        );
      }
      if (dep === step.id) {
        throw new LearningPathError(
          "dependency_cycle",
          `步骤 ${step.id} 依赖自身，形成环`,
        );
      }
    }
  }

  const remaining = new Map<string, number>(
    steps.map((step) => [step.id, step.dependencyIds.length]),
  );
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependencyIds) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), step.id]);
    }
  }

  const queue = steps.filter((step) => step.dependencyIds.length === 0).map((step) => step.id);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }
  if (ordered.length !== steps.length) {
    const cycleNode = steps.find((step) => (remaining.get(step.id) ?? 0) > 0)!;
    throw new LearningPathError(
      "dependency_cycle",
      `学习路径存在依赖环，涉及步骤 ${cycleNode.id}`,
    );
  }
}

/**
 * 根据已核验步骤重算路径，并单独保留真实授课位置：
 * - done 只来自已核验证据；依赖未满足的其他步骤是 locked，其余是 available；
 * - 未完成的 requestedCurrentId 是当前授课位置，即使前置尚未核验也不会被改写；
 * - 没有有效授课位置时，选择第一个依赖已满足的未完成步骤；全部完成后没有 current；
 * - 授课位置不等于掌握，不因正在学某一步而把它或其前置标为完成。
 */
export function computePathProgress(
  steps: PathStep[],
  doneIds: string[],
  requestedCurrentId?: string | null,
): PathProgress {
  validatePathDependencies(steps);
  const done = new Set(doneIds.filter((id) => steps.some((step) => step.id === id)));
  const unlocked = (step: PathStep) => step.dependencyIds.every((dep) => done.has(dep));
  const notDone = (step: PathStep) => !done.has(step.id);

  const requested = requestedCurrentId
    ? steps.find((step) => step.id === requestedCurrentId && notDone(step))
    : undefined;
  const fallback = steps.find((step) => notDone(step) && unlocked(step));
  const currentId = requested ? requested.id : fallback ? fallback.id : null;

  const out = steps.map((step): PathStep => {
    if (done.has(step.id)) return { ...step, status: "done" as const };
    if (step.id === currentId) return { ...step, status: "current" as const };
    if (!unlocked(step)) return { ...step, status: "locked" as const };
    return { ...step, status: "available" as const };
  });

  return {
    steps: out,
    currentStepId: currentId,
    availableStepIds: out.filter((step) => step.status === "available").map((step) => step.id),
    doneStepIds: out.filter((step) => step.status === "done").map((step) => step.id),
    lockedStepIds: out.filter((step) => step.status === "locked").map((step) => step.id),
    remainingMinutes: out
      .filter((step) => step.status !== "done")
      .reduce((sum, step) => sum + step.estimatedMinutes, 0),
  };
}

/**
 * 断点续学：返回真实授课位置；没有位置时返回首个可学步骤。
 * 全部完成时返回 null，表示路径已走完，没有可续学的内容。
 */
export function selectResumeStepId(progress: PathProgress): string | null {
  return progress.currentStepId;
}

/** 面向学习者的路径状态一句话描述：当前步骤、预计剩余分钟与待答问题。 */
export function describePathProgress(progress: PathProgress, suggested = false): string {
  if (progress.currentStepId === null) {
    return progress.remainingMinutes === 0
      ? "学习路径已全部完成"
      : "没有可学的下一步，先完成前面的步骤";
  }
  const current = progress.steps.find((step) => step.id === progress.currentStepId);
  if (!current) return "学习路径已全部完成";
  const pending = current.pendingPrompt ? `，待答：${current.pendingPrompt}` : "";
  return `${suggested ? "建议下一步" : "当前步骤"}「${current.title}」，预计剩余 ${progress.remainingMinutes} 分钟${pending}`;
}

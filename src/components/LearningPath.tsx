import { useState } from "react";
import {
  ArrowRight,
  CircleDot,
  CornerUpLeft,
  Link2,
  Lock,
  Play,
  RotateCcw,
  Timer,
} from "lucide-react";
import type { PathStep } from "../types";
import { RichText } from "./RichText";
import "./LearningWorkspace.css";

export interface LearningPathProps {
  /** 已计算好的路径状态；current 可能只是建议的下一步，不等于掌握。 */
  steps: PathStep[];
  /** 区分实际授课位置与完成当前位置后推荐的下一步。 */
  suggestedStepId?: string | null;
  /** 每个步骤对应的实际学习进度（如已完成讲解的分钟数）；没有则按 0 处理。 */
  completedMinutesByStep?: Record<string, number>;
  busy?: boolean;
  /** 进入某个可用/当前步骤继续学习。 */
  onEnterStep?: (stepId: string) => void;
  /** 回到主线被搁置的问题（pendingPrompt 存在时显示）。 */
  onResumePending?: (stepId: string) => void;
  /** 展开一个锁定步骤时提示缺哪些依赖，无操作含义。 */
  onLockedStepInfo?: (stepId: string, missingDependencyIds: string[]) => void;
}

function findMissingDependencies(
  steps: PathStep[],
  step: PathStep,
): PathStep[] {
  return step.dependencyIds
    .map((id) => steps.find((s) => s.id === id))
    .filter((s): s is PathStep => !!s && s.status !== "done");
}

function formatRemaining(
  estimatedMinutes: number,
  completedMinutes: number,
): string | null {
  const remaining = Math.max(0, estimatedMinutes - completedMinutes);
  if (remaining <= 0) return null;
  return `预计剩余 ${remaining} 分钟`;
}

function StatusPill({ step, suggested }: { step: PathStep; suggested: boolean }) {
  const map = {
    done: { label: "已完成", className: "done" },
    current: { label: suggested ? "建议下一步" : "正在学", className: "current" },
    available: { label: "可开始", className: "available" },
    locked: { label: "有依赖未完成", className: "locked" },
  } as const;
  const { label, className } = map[step.status];
  return <span className={`lpath-status ${className}`}>{label}</span>;
}

export function LearningPath({
  steps,
  completedMinutesByStep = {},
  busy = false,
  onEnterStep,
  onResumePending,
  onLockedStepInfo,
  suggestedStepId = null,
}: LearningPathProps) {
  const [openStep, setOpenStep] = useState<string | null>(null);
  const totalRemaining = steps.reduce(
    (sum, step) =>
      sum +
      (step.status === "done"
        ? 0
        : Math.max(
            0,
            step.estimatedMinutes - (completedMinutesByStep[step.id] ?? 0),
          )),
    0,
  );
  const pendingSteps = steps.filter((step) => step.pendingPrompt);

  return (
    <section className="lpath-root" aria-label="学习路径">
      <header className="lpath-head">
        <span className="eyebrow">LEARNING PATH</span>
        <h2>
          <Link2 size={18} aria-hidden="true" />
          学习路径
        </h2>
        <p>
          「正在学」是当前授课位置；没有当前位置时显示建议的下一步。它们都不代表掌握，完成只依据真实核验证据。
        </p>
        <div className="lpath-meta">
          <span>
            <Timer size={13} aria-hidden="true" />
            剩余约 {totalRemaining} 分钟
          </span>
          <span>
            <CircleDot size={13} aria-hidden="true" />
            已完成 {steps.filter((s) => s.status === "done").length} /{" "}
            {steps.length}
          </span>
          {pendingSteps.length > 0 && (
            <span className="pending">
              <CornerUpLeft size={13} aria-hidden="true" />
              {pendingSteps.length} 个待答问题
            </span>
          )}
        </div>
      </header>

      <ol className="lpath-steps">
        {steps.map((step, index) => {
          const missing = findMissingDependencies(steps, step);
          const completedMinutes = completedMinutesByStep[step.id] ?? 0;
          const remainingLabel =
            step.status === "done"
              ? null
              : formatRemaining(step.estimatedMinutes, completedMinutes);
          const open = openStep === step.id;
          const enterable =
            (step.status === "available" || step.status === "current") &&
            !busy;
          return (
            <li
              key={step.id}
              className={`${step.status} ${open ? "open" : ""}`}
            >
              <button
                type="button"
                className="lpath-row"
                aria-expanded={open}
                onClick={() => {
                  const next = open ? null : step.id;
                  setOpenStep(next);
                  if (!open && step.status === "locked") {
                    onLockedStepInfo?.(
                      step.id,
                      missing.map((m) => m.id),
                    );
                  }
                }}
              >
                <span className="lpath-index" aria-hidden="true">
                  {step.status === "done" ? (
                    <ArrowRight size={13} />
                  ) : step.status === "locked" ? (
                    <Lock size={13} />
                  ) : step.status === "current" ? (
                    <Play size={13} />
                  ) : (
                    String(index + 1)
                  )}
                </span>
                <span className="lpath-title">
                  <RichText inline>{step.title}</RichText>
                  {step.pendingPrompt && <em>有待答问题</em>}
                </span>
                <span className="lpath-right">
                  {remainingLabel && <small>{remainingLabel}</small>}
                  <StatusPill step={step} suggested={step.id === suggestedStepId} />
                </span>
              </button>
              {open && (
                <div className="lpath-body">
                  <div className="lpath-goal"><RichText>{step.goal}</RichText></div>
                  {missing.length > 0 && (
                    <p className="lpath-deps">
                      <Lock size={12} aria-hidden="true" />
                      还需完成：
                      {missing.map((m, mIndex) => (
                        <span key={m.id}>
                          {mIndex > 0 && "、"}
                          {m.title}
                        </span>
                      ))}
                    </p>
                  )}
                  {step.pendingPrompt && (
                    <div className="lpath-pending">
                      <RichText>{step.pendingPrompt}</RichText>
                      {onResumePending && (
                        <button
                          type="button"
                          className="lpath-resume"
                          disabled={busy}
                          onClick={() => onResumePending(step.id)}
                        >
                          <RotateCcw size={13} aria-hidden="true" />
                          回答这个问题
                        </button>
                      )}
                    </div>
                  )}
                  {enterable && (
                    <button
                      type="button"
                      className="lpath-enter"
                      onClick={() => onEnterStep?.(step.id)}
                    >
                      {step.id === suggestedStepId ? "学习建议的下一步" : step.status === "current" ? "继续这一步" : "开始这一步"}
                    </button>
                  )}
                  {step.status === "locked" && (
                    <p className="lpath-locked-note">
                      前置尚未核验。请先补学列出的依赖；正在学习后续内容不会自动完成它们。
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

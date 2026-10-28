import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  ChevronDown,
  CircleHelp,
  Clock,
  Flag,
  ListChecks,
  Quote,
  RotateCcw,
  Route,
  SearchCheck,
  Sparkles,
  Timer,
} from "lucide-react";
import type {
  DiagnosticProfile,
  LearningState,
  LearningStep,
  ReviewItem,
} from "../types";
import { evidenceKindLabels, masteryLabels } from "./LearningProgress";
import "./LearningWorkspace.css";

export interface LearningReportProps {
  /** 当前会话的学习状态：证据、误区、假设、待答问题都来自这里，不虚构。 */
  state: LearningState;
  /** 该主题下的复习项，用于统计到期与即将到期。 */
  reviews: ReviewItem[];
  /** 学习前诊断画像（可选）：只作为识别起点展示，不当作掌握证明。 */
  diagnostic?: DiagnosticProfile | null;
  /** 可注入的当前时间（毫秒），便于测试到期计算；默认取当下。 */
  now?: number;
  /** 打开复习工作台（误区/到期复习的下一步入口）。 */
  onOpenReviews?: () => void;
  /** 回到对话回答导师提出的问题。 */
  onResumeQuestion?: () => void;
  /** 跳到学习路径中的某个步骤。 */
  onJumpToStep?: (stepId: string) => void;
  busy?: boolean;
}

interface StepAudit {
  step: LearningStep;
  recognition: number;
  reasoning: number;
  transfer: number;
  /** 有推理或迁移证据才算核验过。 */
  verified: boolean;
}

interface UnverifiedEntry {
  id: string;
  title: string;
  detail: string;
  whatWouldVerify: string;
}

interface NextAction {
  id: string;
  icon: typeof Flag;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

function auditSteps(state: LearningState): StepAudit[] {
  return state.steps.map((step) => {
    const recognition = step.evidence.filter((e) => e.kind === "recognition")
      .length;
    const reasoning = step.evidence.filter((e) => e.kind === "reasoning")
      .length;
    const transfer = step.evidence.filter((e) => e.kind === "transfer").length;
    return {
      step,
      recognition,
      reasoning,
      transfer,
      verified: reasoning + transfer > 0,
    };
  });
}

function buildUnverified(
  state: LearningState,
  audits: StepAudit[],
  diagnostic: DiagnosticProfile | null | undefined,
): UnverifiedEntry[] {
  const entries: UnverifiedEntry[] = [];
  for (const audit of audits) {
    const { step } = audit;
    if (step.mastery === "new") continue;
    if (step.evidence.length === 0) {
      entries.push({
        id: `step-${step.id}`,
        title: step.title,
        detail: `当前标记「${masteryLabels[step.mastery]}」，但没有保存任何你的作答记录。`,
        whatWouldVerify: "回答这一步的问题，留下真实作答后才会积累证据。",
      });
    } else if (!audit.verified) {
      entries.push({
        id: `step-${step.id}`,
        title: step.title,
        detail: `只有 ${audit.recognition} 条辨认类证据（认出、选对），还没有独立推理或迁移的作答。`,
        whatWouldVerify: "独立完成一道推理题或迁移题并答对，才会成为推理证据。",
      });
    }
  }
  if (state.assumptions.length > 0) {
    entries.push({
      id: "assumptions",
      title: "对话中的假设",
      detail: "以下是导师在讲解中采用的、尚未被你的作答核验的假设：",
      whatWouldVerify: state.assumptions.join("；"),
    });
  }
  if (diagnostic && diagnostic.submitted) {
    const weak = diagnostic.weakConcepts.join("、");
    entries.push({
      id: `diagnostic-${diagnostic.id}`,
      title: `诊断画像：${diagnostic.topic}（${diagnostic.level}）`,
      detail:
        "诊断选择题只反映识别起点，答对不等于会推理；它用来决定从哪里开始，不直接证明掌握。",
      whatWouldVerify: weak
        ? `识别出的薄弱概念：${weak}。进入对应微课并通过迁移题后才会核验。`
        : "进入推荐步骤并通过推理或迁移题后才会核验。",
    });
  }
  return entries;
}

function buildNextActions(
  state: LearningState,
  audits: StepAudit[],
  dueReviews: ReviewItem[],
  upcomingReviews: ReviewItem[],
  onOpenReviews?: () => void,
  onResumeQuestion?: () => void,
  onJumpToStep?: (stepId: string) => void,
): NextAction[] {
  const actions: NextAction[] = [];
  const openMisconceptions = state.misconceptions.filter(
    (m) => m.status !== "resolved",
  );
  if (openMisconceptions.length > 0 && onOpenReviews) {
    actions.push({
      id: "misconceptions",
      icon: AlertTriangle,
      title: `先修复 ${openMisconceptions.length} 个误区`,
      detail: `${openMisconceptions[0].topic}${openMisconceptions.length > 1 ? ` 等 ${openMisconceptions.length} 个` : ""} · 误区解除需要另一道同概念迁移题独立答对。`,
      actionLabel: "打开复习",
      onAction: onOpenReviews,
    });
  }
  if (dueReviews.length > 0 && onOpenReviews) {
    actions.push({
      id: "due-reviews",
      icon: RotateCcw,
      title: `${dueReviews.length} 个复习项已到期`,
      detail: `最近的一个：${dueReviews[0].topic}。现在复习记得最牢。`,
      actionLabel: "开始复习",
      onAction: onOpenReviews,
    });
  }
  const pending = state.pendingQuestion;
  if (pending) {
    actions.push({
      id: "pending-question",
      icon: CircleHelp,
      title: "回答导师提出的问题",
      detail: pending.prompt,
      actionLabel: "回到对话作答",
      onAction: onResumeQuestion,
    });
  }
  const currentStep = audits.find((a) => a.step.id === state.currentStepId);
  if (currentStep && onJumpToStep) {
    actions.push({
      id: "current-step",
      icon: Route,
      title: `继续当前步骤「${currentStep.step.title}」`,
      detail: currentStep.verified
        ? "这一步已有推理证据，可以继续往下走。"
        : "这一步还没有推理或迁移证据，继续前建议先完成一道核验题。",
      actionLabel: "查看步骤",
      onAction: () => onJumpToStep(currentStep.step.id),
    });
  }
  if (upcomingReviews.length > 0 && actions.length === 0 && onOpenReviews) {
    actions.push({
      id: "upcoming-reviews",
      icon: Clock,
      title: `还有 ${upcomingReviews.length} 个复习项未到期`,
      detail: `最近的一个 ${upcomingReviews[0].topic} 到期前，可以继续推进新内容。`,
      actionLabel: "查看复习计划",
      onAction: onOpenReviews,
    });
  }
  return actions;
}

function formatDue(now: number, dueAt: number): string {
  const diff = dueAt - now;
  const minutes = Math.round(Math.abs(diff) / 60000);
  let span: string;
  if (minutes < 1) span = "不到 1 分钟";
  else if (minutes < 60) span = `${minutes} 分钟`;
  else if (minutes < 60 * 24) span = `${Math.round(minutes / 60)} 小时`;
  else span = `${Math.round(minutes / (60 * 24))} 天`;
  return diff <= 0 ? `已到期（超过 ${span}）` : `${span} 后`;
}

function ReportChip({
  icon: Icon,
  label,
  value,
  tone = "plain",
}: {
  icon: typeof Flag;
  label: string;
  value: string;
  tone?: "plain" | "warn" | "good";
}) {
  return (
    <span className={`lr-chip ${tone}`}>
      <Icon size={13} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

export function LearningReport({
  state,
  reviews,
  diagnostic,
  now = Date.now(),
  onOpenReviews,
  onResumeQuestion,
  onJumpToStep,
  busy = false,
}: LearningReportProps) {
  const [openUnverified, setOpenUnverified] = useState<string | null>(null);
  const audits = auditSteps(state);
  const dueReviews = reviews
    .filter((item) => item.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
  const upcomingReviews = reviews
    .filter((item) => item.dueAt > now)
    .sort((a, b) => a.dueAt - b.dueAt);
  const openMisconceptions = state.misconceptions.filter(
    (m) => m.status !== "resolved",
  );
  const unverified = buildUnverified(state, audits, diagnostic);
  const nextActions = buildNextActions(
    state,
    audits,
    dueReviews,
    upcomingReviews,
    onOpenReviews,
    onResumeQuestion,
    onJumpToStep,
  );
  const evidenceByKind = {
    recognition: audits.reduce((sum, a) => sum + a.recognition, 0),
    reasoning: audits.reduce((sum, a) => sum + a.reasoning, 0),
    transfer: audits.reduce((sum, a) => sum + a.transfer, 0),
  };
  const totalEvidence =
    evidenceByKind.recognition +
    evidenceByKind.reasoning +
    evidenceByKind.transfer;

  return (
    <section className="lr-report" aria-label="学习报告">
      <header className="lr-head">
        <span className="eyebrow">LEARNING REPORT</span>
        <h2>
          <BookOpenCheck size={18} aria-hidden="true" />
          学习报告
        </h2>
        <p>
          只汇总真实发生过的作答和记录。没有证据的地方，会如实标注「未核验」，不会替你宣布掌握。
        </p>
        <div className="lr-chips">
          <ReportChip
            icon={SearchCheck}
            label="真实证据"
            value={`${totalEvidence} 条`}
            tone={totalEvidence > 0 ? "good" : "plain"}
          />
          {totalEvidence > 0 && (
            <ReportChip
              icon={ListChecks}
              label="辨认 / 推理 / 迁移"
              value={`${evidenceByKind.recognition} / ${evidenceByKind.reasoning} / ${evidenceByKind.transfer}`}
            />
          )}
          {openMisconceptions.length > 0 && (
            <ReportChip
              icon={AlertTriangle}
              label="开放误区"
              value={`${openMisconceptions.length}`}
              tone="warn"
            />
          )}
          {dueReviews.length > 0 && (
            <ReportChip
              icon={Clock}
              label="到期复习"
              value={`${dueReviews.length}`}
              tone="warn"
            />
          )}
        </div>
      </header>

      <div className="lr-section">
        <h3>
          <SearchCheck size={14} aria-hidden="true" />
          真实证据
        </h3>
        {totalEvidence === 0 ? (
          <p className="lr-empty">
            还没有你的作答记录。回答导师的问题、做测验或迁移题后，这里会出现带原话的证据。
          </p>
        ) : (
          <ul className="lr-evidence">
            {audits
              .filter((a) => a.step.evidence.length > 0)
              .map((audit) => (
                <li key={audit.step.id}>
                  <div className="lr-evidence-head">
                    <strong>{audit.step.title}</strong>
                    <small>
                      {audit.step.evidence.length} 条 ·{" "}
                      {audit.verified ? "含推理/迁移核验" : "仅辨认"}
                    </small>
                  </div>
                  <ul>
                    {audit.step.evidence.map((evidence, index) => (
                      <li key={index}>
                        <blockquote>
                          <Quote size={11} aria-hidden="true" />
                          <span>{evidence.quote}</span>
                        </blockquote>
                        <small>
                          {evidenceKindLabels[evidence.kind] ?? "作答"} ·{" "}
                          {evidence.question
                            ? `当时的问题：${evidence.question}`
                            : "来自当时的作答（问题原文未保存）"}
                        </small>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="lr-section lr-unverified">
        <h3>
          <AlertTriangle size={14} aria-hidden="true" />
          未核验 {unverified.length > 0 && `· ${unverified.length}`}
        </h3>
        {unverified.length === 0 ? (
          <p className="lr-empty">
            当前每个进行中的步骤都有推理或迁移证据，也没有未核验的假设。
          </p>
        ) : (
          <ul>
            {unverified.map((entry) => {
              const open = openUnverified === entry.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="lr-unverified-row"
                    aria-expanded={open}
                    onClick={() => setOpenUnverified(open ? null : entry.id)}
                  >
                    <span>{entry.title}</span>
                    <ChevronDown
                      size={13}
                      aria-hidden="true"
                      className={open ? "open" : ""}
                    />
                  </button>
                  {open && (
                    <div className="lr-unverified-body">
                      <p>{entry.detail}</p>
                      <p className="lr-verify-hint">
                        <Flag size={12} aria-hidden="true" />
                        {entry.whatWouldVerify}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {openMisconceptions.length > 0 && (
        <div className="lr-section lr-misconceptions">
          <h3>
            <AlertTriangle size={14} aria-hidden="true" />
            误区 · 待修复 {openMisconceptions.length}
          </h3>
          <ul>
            {openMisconceptions.map((m) => (
              <li key={m.id}>
                <div className="lr-misconception-head">
                  <strong>{m.topic}</strong>
                  <span
                    className={`lr-status ${m.status === "repairing" ? "repairing" : "open"}`}
                  >
                    {m.status === "repairing" ? "修复中" : "待修复"}
                  </span>
                </div>
                <p>{m.description}</p>
                {m.evidenceQuote && (
                  <blockquote>
                    <Quote size={11} aria-hidden="true" />你的原话：「
                    {m.evidenceQuote}」
                  </blockquote>
                )}
                <small>
                  {m.status === "repairing"
                    ? "正在修复 · 需要另一道同概念迁移题答对才会解除"
                    : "待修复 · 先弄清概念，再通过迁移题核验"}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="lr-section">
        <h3>
          <RotateCcw size={14} aria-hidden="true" />
          待复习
        </h3>
        {reviews.length === 0 ? (
          <p className="lr-empty">
            还没有复习项。复习项会在测验答错或发现误区后自动生成，并按间隔安排（忘了立即重学，会了按 1-3-7-14 天递增）。
          </p>
        ) : (
          <div className="lr-review-summary">
            <div className="lr-review-counts">
              <span className={dueReviews.length > 0 ? "due" : ""}>
                <Timer size={13} aria-hidden="true" />
                到期 {dueReviews.length}
              </span>
              <span>
                <Clock size={13} aria-hidden="true" />
                未到期 {upcomingReviews.length}
              </span>
            </div>
            {(dueReviews.length > 0 || upcomingReviews.length > 0) && (
              <ul className="lr-review-next">
                {[...dueReviews, ...upcomingReviews]
                  .slice(0, 3)
                  .map((item) => (
                    <li key={item.id}>
                      <strong>{item.topic}</strong>
                      <small>{formatDue(now, item.dueAt)}</small>
                    </li>
                  ))}
              </ul>
            )}
            {onOpenReviews && (
              <button
                type="button"
                className="button secondary lr-review-open"
                disabled={busy}
                onClick={onOpenReviews}
              >
                {dueReviews.length > 0 ? "开始复习" : "查看复习计划"}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="lr-section lr-next">
        <h3>
          <Sparkles size={14} aria-hidden="true" />
          下一步
        </h3>
        {nextActions.length === 0 ? (
          <p className="lr-empty">
            当前没有到期复习、待答问题或开放误区。可以在对话里继续推进，或请导师出一道迁移题检验理解。
          </p>
        ) : (
          <ul>
            {nextActions.map((action) => (
              <li key={action.id} className="lr-action">
                <span className="lr-action-icon" aria-hidden="true">
                  <action.icon size={15} />
                </span>
                <div>
                  <strong>{action.title}</strong>
                  {action.detail && <p>{action.detail}</p>}
                </div>
                {action.actionLabel && action.onAction && (
                  <button
                    type="button"
                    className="lr-action-button"
                    disabled={busy}
                    onClick={action.onAction}
                  >
                    {action.actionLabel}
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

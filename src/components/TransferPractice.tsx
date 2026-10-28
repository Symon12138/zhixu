import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  FlaskConical,
  LoaderCircle,
  RotateCcw,
  Send,
} from "lucide-react";
import type {
  AssessmentVerdict,
  LearningQuestion,
  LearningState,
  TransferTrack,
} from "../types";
import { RichText } from "./RichText";
import "./LearningWorkspace.css";

/** 迁移练习（TransferPractice）：
 *  - 学习状态只提供当前 pendingQuestion，没有历史题集：本组件只展示当前真实迁移任务，
 *    绝不虚构进度、题数或掌握结论；
 *  - 学习者原样提交 textarea 文本（不包装、不改写），父组件调用 runAI 得到导师评价；
 *  - 结果区显示当前题或父组件记录的 reviewedQuestionId 对应的 lastAssessment.feedback：
 *    导师评分后往往已经换上新题，刚答过那题的反馈不能因此被藏起来，也不能弹出
 *    「对应其他题目」的无关警告；
 *  - pendingQuestion 换题时立即丢弃旧草稿，旧答案不可能投到新题；
 *  - 结果区同时展示真实 track 的 currentStep.status；
 *  - 本组件不调度复习、不推进轨道：推进由父组件经 recordTransferAnswer 完成。 */

export interface TransferPracticeProps {
  state: LearningState;
  track?: TransferTrack;
  busy?: boolean;
  /**
   * 父组件记录的「刚提交并核验过的题」ID。评分后 pendingQuestion 可能已经是
   * 下一道新题，只有靠这个 ID 才能确认 lastAssessment 属于刚答的那道题并展示反馈。
   */
  reviewedQuestionId?: string;
  /** 没有待答迁移题时，请导师出一道新情境题（不算作答，不产生证据）。 */
  onRequestQuestion: () => void;
  /** 提交学习者原话作答；父组件调用 runAI 并核验。 */
  onSubmitAnswer: (answer: string, question: LearningQuestion) => void;
  /** 可选：重置迁移关卡记录（不清学习证据）。 */
  onReset?: () => void;
}

const verdictLabels: Record<AssessmentVerdict, string> = {
  not_assessed: "尚未核验",
  uncertain: "不确定",
  incorrect: "不成立",
  partial: "部分成立",
  correct: "成立",
};

export function TransferPractice({
  state,
  track,
  busy = false,
  reviewedQuestionId,
  onRequestQuestion,
  onSubmitAnswer,
  onReset,
}: TransferPracticeProps) {
  const [draft, setDraft] = useState<{ questionId: string | null; text: string }>({
    questionId: null,
    text: "",
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const pending = state.pendingQuestion;
  const pendingId = pending?.id ?? null;
  const isTransferPending =
    pending !== null && pending.kind === "transfer" && pending.scope === "main";

  // 换题后丢弃旧草稿：旧答案只属于旧题的 questionId，绝不能投给新题。
  // 提交尚未结束时先保留学习者刚写下的话，等本轮核验结束再清空。
  useEffect(() => {
    if (busy) return;
    setDraft((previous) =>
      previous.questionId === pendingId
        ? previous
        : { questionId: pendingId, text: "" },
    );
    setLocalError(null);
  }, [busy, pendingId]);

  // 当前草稿是否属于当前题；不属于时绝不把它当作本题答案提交。
  const draftMatchesPending = draft.questionId === pendingId;
  // 提交中保留刚提交的文字；核验结束后换题则立即显示为空。
  const answer = busy || draftMatchesPending ? draft.text : "";

  // 真实轨道的当前关卡（存在时优先展示）
  const currentStep = track
    ? (track.steps.find((step) => step.id === track.currentStepId) ?? null)
    : null;
  // 当前题对应的学习步骤标题（新情境迁移的情境上下文）
  const pendingStep = pending
    ? (state.steps.find((step) => step.id === pending.stepId) ?? null)
    : null;
  // track 当前关卡确实对应当前题时，才把它的 scenario 当作本题情境
  const stepMatchesPending =
    currentStep !== null && pending !== null && currentStep.questionId === pending.id;

  const trackComplete =
    track !== null && track !== undefined && track.steps.every((step) => step.status === "done");

  const lastAssessment = state.lastAssessment;
  // 父组件记录的刚答题 ID 优先；未传时，用轨道里已通过的步骤作为事实来源。
  const assessedQuestionId = lastAssessment?.questionId ?? null;
  const reviewedFromTrack =
    assessedQuestionId === null
      ? null
      : (track?.steps.find(
          (step) =>
            step.status === "done" && step.questionId === assessedQuestionId,
        )?.questionId ?? null);
  const reviewedId = reviewedQuestionId ?? reviewedFromTrack;
  // 当前题恰好就是被核验的题（答错原地重试等），或父组件明确记录刚答过的题。
  const feedbackMatchesPending =
    lastAssessment !== null &&
    pending !== null &&
    lastAssessment.questionId === pending.id;
  const feedbackMatchesReviewed =
    lastAssessment !== null &&
    reviewedId !== null &&
    lastAssessment.questionId === reviewedId;
  const showFeedback = feedbackMatchesPending || feedbackMatchesReviewed;
  // 只有反馈确实与「当前题 / 刚答过的题」都无关时，才是其他题的结果。
  const showUnrelatedWarning =
    !busy && lastAssessment !== null && !showFeedback;

  const canSubmit = isTransferPending && answer.trim().length >= 1 && !busy;

  function submit() {
    if (!pending || !draftMatchesPending) return;
    if (answer.trim().length < 1) {
      setLocalError("请先写下你自己的解释，再提交。");
      return;
    }
    setLocalError(null);
    onSubmitAnswer(answer, pending);
  }

  return (
    <section className="tp-root" aria-label="迁移练习">
      <header className="tp-head">
        <span className="eyebrow">TRANSFER</span>
        <h2>
          <FlaskConical size={18} aria-hidden="true" />
          迁移练习
        </h2>
        <p>
          把学到的机制用到新问题上：写出你自己的解释，导师据此判断是否真的能迁移。
          点按钮、选对选项都不算迁移证据。
        </p>
      </header>

      {track && track.steps.length > 0 && (
        <ol className="tp-track" aria-label="迁移关卡">
          {track.steps.map((step, index) => (
            <li
              key={step.id}
              className={`${step.status} ${step.id === track.currentStepId ? "now" : ""}`}
            >
              <span className="tp-track-index">
                {step.status === "done" ? <Check size={12} /> : index + 1}
              </span>
              <div>
                <strong>{step.title}</strong>
                <small>
                  {step.status === "done" ? "已通过" : step.status === "current" ? "当前关卡" : "待安排"}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}

      {isTransferPending && pending && (
        <div className="tp-question">
          <div className="tp-question-head">
            <span className="tp-q-kind">迁移题</span>
            <span className="tp-q-level">新情境迁移</span>
            {!track && (
              <span className="tp-q-level">当前 1 个真实迁移任务，后续由导师按表现安排</span>
            )}
          </div>

          <div>
            {pendingStep && <strong>{pendingStep.title}</strong>}
            {stepMatchesPending && currentStep && (
              <div className="tp-q-prompt"><RichText>{currentStep.scenario}</RichText></div>
            )}
            {state.assumptions.length > 0 && (
              <ul>
                {state.assumptions.map((item, index) => (
                  <li key={index}><RichText>{item}</RichText></li>
                ))}
              </ul>
            )}
          </div>

          <div className="tp-q-prompt"><RichText>{pending.prompt}</RichText></div>

          <label>
            用你的话解释如何应用
            <textarea
              value={answer}
              onChange={(event) => {
                setDraft({ questionId: pendingId, text: event.target.value });
                if (localError) setLocalError(null);
              }}
              disabled={busy}
              rows={5}
              placeholder="写出你自己的推理或应用过程，不要只给结论。"
            />
          </label>

          {localError && <p className="tp-error">{localError}</p>}

          <div className="tp-actions">
            <button
              type="button"
              className="tp-submit"
              onClick={submit}
              disabled={!canSubmit}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
              {busy ? "导师核验中" : "提交给导师核验"}
            </button>
            <span className="tp-hint-key">
              至少 1 个字符；答案会原样提交，不会被改写；提交后可修改再次作答。
            </span>
          </div>
        </div>
      )}

      {!isTransferPending && (
        <div className="tp-empty">
          <p>
            {trackComplete
              ? "当前没有待完成的迁移任务。"
              : "当前没有待回答的迁移题。"}
          </p>
          <button
            type="button"
            className="tp-request"
            onClick={onRequestQuestion}
            disabled={busy}
          >
            请导师出一道新情境题
          </button>
        </div>
      )}

      <>
        {busy && isTransferPending && (
          <p className="tp-verdict">
            <LoaderCircle size={15} className="spin" />
            导师正在核验本次作答，结果出来后会显示在这里。
          </p>
        )}

        {showUnrelatedWarning && lastAssessment && (
          <p className="tp-verdict warn">
            <AlertCircle size={15} />
            导师最新的核验结果对应的是其他题目，不计入当前迁移任务。
          </p>
        )}

        {showFeedback && lastAssessment && (
          <div className="tp-feedback">
            <span>
              {feedbackMatchesPending ? "核验结果" : "上一题核验结果"} ·{" "}
              {verdictLabels[lastAssessment.verdict]}
            </span>
            <RichText>{lastAssessment.feedback}</RichText>
          </div>
        )}

        {currentStep && currentStep.status === "done" && (
          <div className="tp-done">
            <Check size={16} />
            <div>
              <strong>已通过当前迁移题：{currentStep.title}</strong>
              <p>导师已确认这次独立作答构成迁移证据。</p>
            </div>
          </div>
        )}

        {trackComplete && (
          <div className="tp-done">
            <Check size={16} />
            <div>
              <strong>迁移轨道全部完成</strong>
              <p>
                你完成了本次安排的所有迁移任务。这只说明这组任务通过，不代表已掌握整个领域。
              </p>
            </div>
          </div>
        )}
      </>

      {onReset && track && (
        <div className="tp-actions">
          <button type="button" className="tp-retry" onClick={onReset} disabled={busy}>
            <RotateCcw size={14} />
            重置迁移记录
          </button>
          <span className="tp-hint-key">只清空迁移关卡记录，学习证据与评价保持不变。</span>
        </div>
      )}
    </section>
  );
}

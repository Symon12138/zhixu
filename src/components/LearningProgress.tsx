import { useState } from "react";
import {
  AlertTriangle,
  BookmarkCheck,
  ChevronDown,
  CornerUpLeft,
  ExternalLink,
  Quote,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type {
  EvidenceKind,
  LearningEvidence,
  LearningState,
  MasteryLevel,
  QuestionKind,
  TeachingQuality,
  TeachingReceipt,
  WebSourceTier,
} from "../types";
import type { BookSourceLocation } from "../bookTypes";
import { RichText } from "./RichText";
import "./LearningProgress.css";

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

const sourceTierLabels: Record<WebSourceTier, string> = {
  official: "官方/教育域名",
  primary: "一手资料",
  secondary: "二手资料",
  unknown: "未分级",
};

export const masteryLabels: Record<MasteryLevel, string> = {
  new: "待探索",
  learning: "学习中",
  understood: "已解释",
  applied: "迁移通过",
};

export const evidenceKindLabels: Record<EvidenceKind, string> = {
  recognition: "辨认",
  reasoning: "推理",
  transfer: "迁移",
};

const questionKindLabels: Record<QuestionKind, string> = {
  orientation: "方向选择",
  diagnostic: "理解诊断",
  reasoning: "推理题",
  calculation: "计算题",
  transfer: "迁移题",
  choice: "选择题",
};

const verdictLabels: Record<TeachingReceipt["assessment"]["verdict"], string> =
  {
    not_assessed: "本轮未作答",
    uncertain: "还不确定",
    incorrect: "发现误解",
    partial: "部分正确",
    correct: "回答正确",
  };

function EvidenceItem({ evidence }: { evidence: LearningEvidence }) {
  return (
    <li className="lp-evidence">
      <blockquote>
        <Quote size={11} aria-hidden="true" />
        <span>{evidence.quote}</span>
      </blockquote>
      <small>
        {evidence.question
          ? `当时的问题：${evidence.question}`
          : "来自当时的作答（问题原文未保存）"}
        {" · "}
        {evidenceKindLabels[evidence.kind] ?? "作答"}
      </small>
    </li>
  );
}

export interface LearningProgressProps {
  state: LearningState;
  busy: boolean;
  pendingPromptInThread?: boolean;
  onAnswer: (text: string) => void;
  onResume: () => void;
  onRestoreTrack: (topic: string) => void;
}

export function MobileLearningProgress(props: LearningProgressProps) {
  return (
    <details className="mobile-progress">
      <summary>
        <BookmarkCheck size={15} aria-hidden="true" />
        学习证据与未完成问题
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="mobile-progress-body">
        <LearningProgress {...props} />
      </div>
    </details>
  );
}

export function LearningProgress({
  state,
  busy,
  pendingPromptInThread = false,
  onAnswer,
  onResume,
  onRestoreTrack,
}: LearningProgressProps) {
  const [openStep, setOpenStep] = useState<string | null>(null);
  const pending = state.pendingQuestion;
  const openMisconceptions = state.misconceptions.filter(
    (m) => m.status !== "resolved",
  );
  const detour = state.detours.at(-1);
  return (
    <div className="lp-root">
      {pending && (
        <div className="lp-pending">
          <div className="lp-pending-head">
            <span
              className={`lp-qkind${pending.kind === "orientation" ? " orientation" : ""}`}
            >
              {questionKindLabels[pending.kind] ?? "问题"}
            </span>
            <small>可现在作答，也可先继续听</small>
          </div>
          {pendingPromptInThread ? (
            <details className="lp-question-recall">
              <summary>回看待答问题</summary>
              <div className="lp-pending-prompt"><RichText>{pending.prompt}</RichText></div>
            </details>
          ) : (
            <div className="lp-pending-prompt"><RichText>{pending.prompt}</RichText></div>
          )}
          {pending.scope === "detour" && (
            <small className="lp-scope">插问中的问题 · 回答后可返回主线</small>
          )}
          {pending.options.length > 0 ? (
            <div
              className={`lp-options ${pendingPromptInThread ? "compact" : ""}`}
            >
              {pending.options.map((option, index) => (
                <button
                  key={index}
                  type="button"
                  disabled={busy}
                  onClick={() => onAnswer(String(index + 1))}
                  aria-label={`选择 ${index + 1}：${option}`}
                >
                  <span>{index + 1}</span>
                  {!pendingPromptInThread && <span>{option}</span>}
                </button>
              ))}
            </div>
          ) : (
            <p className="lp-pending-hint">
              想检验理解时，在下方写自己的解释；也可以先请导师继续讲。
            </p>
          )}
        </div>
      )}
      <ol className="lp-steps">
        {state.steps.map((step) => {
          const open = openStep === step.id;
          return (
            <li
              key={step.id}
              className={step.id === state.currentStepId ? "current" : ""}
            >
              <button
                type="button"
                className="lp-step-row"
                aria-expanded={open}
                onClick={() => setOpenStep(open ? null : step.id)}
              >
                <span className={`lp-mastery ${step.mastery}`}>
                  {masteryLabels[step.mastery]}
                </span>
                <span className="lp-step-title">
                  <RichText inline>{step.title}</RichText>
                  {step.id === state.currentStepId && <em>正在学</em>}
                </span>
                <small>
                  {step.evidence.length
                    ? `${step.evidence.length} 条证据`
                    : "暂无证据"}
                </small>
                <ChevronDown
                  size={13}
                  aria-hidden="true"
                  className={open ? "open" : ""}
                />
              </button>
              {open && (
                <div className="lp-evidence-list">
                  {step.evidence.length ? (
                    <ul>
                      {step.evidence.map((evidence, index) => (
                        <EvidenceItem key={index} evidence={evidence} />
                      ))}
                    </ul>
                  ) : (
                    <p>这一步还没有你的真实作答记录，掌握状态不会凭空升级。</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {openMisconceptions.length > 0 && (
        <div className="lp-misconceptions">
          <h4>
            <AlertTriangle size={13} aria-hidden="true" />
            待巩固的误区
          </h4>
          <ul>
            {openMisconceptions.map((m) => (
              <li key={m.id}>
                <strong>{m.topic}</strong>
                <p>{m.description}</p>
                {m.evidenceQuote && (
                  <blockquote>你的原话：「{m.evidenceQuote}」</blockquote>
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
      {detour && (
        <div className="lp-detour">
          <h4>
            <CornerUpLeft size={13} aria-hidden="true" />
            插问：{detour.topic}
          </h4>
          <p>
            主线问题保存在 「
            {state.steps.find((s) => s.id === detour.returnStepId)?.title ??
              "原步骤"}
            」，补课的理解不会替代主线进度。
          </p>
          <button
            type="button"
            className="lp-resume"
            disabled={busy}
            onClick={onResume}
          >
            <RotateCcw size={13} aria-hidden="true" />
            回到主线问题
          </button>
        </div>
      )}
      {state.savedTracks.length > 0 && (
        <div className="lp-tracks">
          <h4>
            <BookmarkCheck size={13} aria-hidden="true" />
            暂停的主线
          </h4>
          {state.savedTracks.map((track) => (
            <button
              key={track.goal}
              type="button"
              disabled={busy}
              onClick={() => onRestoreTrack(track.goal)}
            >
              <span>{track.goal}</span>
              <small>带着保存的证据和问题继续 →</small>
            </button>
          ))}
        </div>
      )}
      {state.deferredTopics.length > 0 && (
        <details className="lp-deferred">
          <summary>先放一放的主题 · {state.deferredTopics.length}</summary>
          <div className="lp-deferred-chips">
            {state.deferredTopics.map((topic, index) => (
              <span key={index}>{topic}</span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function TeachingReceiptCard({
  teaching,
  quality,
  onOpenSource,
}: {
  teaching?: TeachingReceipt;
  quality?: TeachingQuality;
  onOpenSource?: (location: BookSourceLocation) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!teaching && !quality) return null;
  const assessment = teaching?.assessment;
  const showAssessment =
    assessment &&
    assessment.verdict !== "not_assessed" &&
    (assessment.feedback || assessment.evidenceQuote);
  return (
    <div className="teaching-receipt">
      {showAssessment && (
        <div className={`receipt-verdict ${assessment!.verdict}`}>
          <strong>{verdictLabels[assessment!.verdict]}</strong>
          {assessment!.evidenceQuote && (
            <blockquote>你的原话：「{assessment!.evidenceQuote}」</blockquote>
          )}
          {assessment!.feedback && <p>{assessment!.feedback}</p>}
        </div>
      )}
      {teaching &&
        teaching.retractedAssumptions &&
        teaching.retractedAssumptions.length > 0 && (
          <div className="receipt-retracted" role="note">
            <h5>
              <AlertTriangle size={12} aria-hidden="true" />
              已修正的前提
            </h5>
            <ul>
              {teaching.retractedAssumptions.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
            <p>这些前提不再成立，之前基于它们的讲解和证据需要重新核验。</p>
          </div>
        )}
      {teaching && teaching.assumptions.length > 0 && (
        <div className="receipt-assumptions">
          <h5>本轮采用的前提</h5>
          <ul>
            {teaching.assumptions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {teaching && teaching.sources.length > 0 && (
        <div className="receipt-sources">
          <h5>材料/网页依据（不等于事实核验）</h5>
          {teaching.sources.map((source, index) => {
            const href = safeExternalUrl(source.url);
            return (
            <div className="receipt-source" key={index}>
              <strong>{source.name}</strong>
              <blockquote>{source.quote}</blockquote>
              {href ? (
                <a className="text-button receipt-source-link" href={href} target="_blank" rel="noreferrer noopener">
                  <ExternalLink size={13} aria-hidden="true" /> 打开网页来源
                  {source.verification === "claim_matched"
                    ? " · 引文逐字命中"
                    : source.verification === "search_snippet"
                      ? " · 搜索摘要，未抓取全文"
                      : " · 页面已抓取"}
                </a>
              ) : null}
              {source.sourceTier ? (
                <small className="receipt-source-meta">
                  来源等级：{sourceTierLabels[source.sourceTier]}（仅域名启发式）
                </small>
              ) : null}
              {source.retrievedAt ? (
                <small className="receipt-source-meta">抓取于 {source.retrievedAt.slice(0, 10)}</small>
              ) : null}
              {source.publishedAt ? (
                <small className="receipt-source-meta">页面标注日期：{source.publishedAt}</small>
              ) : null}
              {source.location && onOpenSource && (
                <button type="button" className="text-button" onClick={() => onOpenSource(source.location!)}>
                  <Quote size={13} aria-hidden="true" /> 回看原文 · {source.location.locator}
                </button>
              )}
            </div>
            );
          })}
        </div>
      )}
      {quality && (
        <>
          <button
            type="button"
            className="quality-badge"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ShieldCheck size={13} aria-hidden="true" />
            教学流程已检查{quality.repaired ? " · 经修订后通过" : ""}
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={open ? "open" : ""}
            />
          </button>
          {open && (
            <div className="quality-details">
              <p>
                本轮共 {quality.modelCalls} 次模型调用
                {quality.reviewAttempts !== undefined && `，其中独立评审 ${quality.reviewAttempts} 次`}
                {quality.repaired && "；讲解经修订后发布"}。
              </p>
              <p>
                {quality.grounding === "provided_material"
                  ? "讲解依据来自你上传的材料原文。"
                  : "讲解基于模型自身知识，未引用上传材料；重要事实请核对权威来源。"}
              </p>
              {!!quality.formatRepairs?.length && (
                <div>
                  <p>程序整理（不增加模型调用）：</p>
                  <ul>{quality.formatRepairs.map((repair, index) => <li key={index}>{repair}</li>)}</ul>
                </div>
              )}
              {quality.limitations.length > 0 && (
                <ul>
                  {quality.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              )}
              <p className="quality-limit">
                教学流程检查 ≠
                事实认证：它说明回复通过了教学连续性与一致性检查，
                不保证所有业务与法规断言正确。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

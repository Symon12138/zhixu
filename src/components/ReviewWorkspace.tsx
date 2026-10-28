import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  CircleHelp,
  Eye,
  Lightbulb,
  MessageSquareQuote,
  Quote,
  Timer,
  X,
} from "lucide-react";
import type {
  QuizQuestion,
  ReviewItem,
  ReviewRating,
} from "../types";
import { RichText } from "./RichText";
import "./LearningWorkspace.css";

export interface ReviewWorkspaceProps {
  /** 到期与未到期的复习项列表。 */
  reviews: ReviewItem[];
  /** 复习项可能对应一份原始测验题（提供选项与解析，沿用原题，不另造）。 */
  questionsById?: Record<string, QuizQuestion>;
  /** 可注入的当前时间（毫秒），便于测试到期；默认取当下。 */
  now?: number;
  busy?: boolean;
  /** 自评后回调：again/fuzzy/known 决定间隔调度（立即重学 / 短间隔 / 1-3-7-14 递增）。 */
  onRate: (item: ReviewItem, rating: ReviewRating, selectedIndex?: number) => void;
  /** 查看与该复习项相关的话题/会话。 */
  onOpenTopic?: (item: ReviewItem) => void;
  /** 针对原题与已保存解析请求真实补讲；返回的讲解不写入理解证据。 */
  onExplain?: (item: ReviewItem) => Promise<string>;
}

const ratingLabels: Record<ReviewRating, string> = {
  again: "忘了",
  fuzzy: "模糊",
  known: "会了",
};

const ratingHints: Record<ReviewRating, string> = {
  again: "立即重学，稍后还会再出现",
  fuzzy: "安排短间隔再复习",
  known: "间隔递增（1-3-7-14 天）",
};

const kindLabels: Record<ReviewItem["kind"], string> = {
  quiz: "测验错题",
  misconception: "误区",
  concept: "概念回想",
};

function formatDue(now: number, dueAt: number): string {
  const diff = dueAt - now;
  if (diff <= 0) return "已到期";
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时后`;
  return `${Math.round(minutes / (60 * 24))} 天后`;
}

function ReviewCard({
  item,
  question,
  busy,
  onRate,
  onOpenTopic,
  onExplain,
}: {
  item: ReviewItem;
  question?: QuizQuestion;
  busy: boolean;
  onRate: ReviewWorkspaceProps["onRate"];
  onOpenTopic?: ReviewWorkspaceProps["onOpenTopic"];
  onExplain?: ReviewWorkspaceProps["onExplain"];
}) {
  const [showHint, setShowHint] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explainError, setExplainError] = useState("");
  const [explaining, setExplaining] = useState(false);
  useEffect(() => {
    setShowHint(false);
    setRevealed(false);
    setSelected(null);
    setExplanation("");
    setExplainError("");
  }, [item.id, item.attempts]);

  const hasOptions = question && question.options.length > 0;
  const selectedCorrect = selected !== null && selected === question?.correctIndex;

  function handleRate(rating: ReviewRating) {
    onRate(item, rating, selected ?? undefined);
  }

  return (
    <article
      className={`rws-card ${revealed ? "revealed" : ""}`}
      aria-label={`复习：${item.topic}`}
    >
      <header className="rws-card-head">
        <span className={`rws-kind kind-${item.source}`}>
          {kindLabels[item.kind] ?? "复习"}
        </span>
        <strong>{item.topic}</strong>
        <span className="rws-due">
          <Timer size={12} aria-hidden="true" />
          {item.attempts > 0
            ? `第 ${item.attempts + 1} 次 · ${item.lastOutcome ? ratingLabels[item.lastOutcome] + "过" : ""}`
            : "首次复习"}
        </span>
      </header>

      <div className="rws-prompt"><RichText>{item.prompt}</RichText></div>

      {item.reason && (
        <div className="rws-reason">
          <MessageSquareQuote size={13} aria-hidden="true" />
          <RichText>{`当时的原因：${item.reason}`}</RichText>
        </div>
      )}
      {item.learnerQuote && (
        <blockquote className="rws-quote">
          <Quote size={11} aria-hidden="true" />
          <span>你的原话：「{item.learnerQuote}」</span>
        </blockquote>
      )}

      {hasOptions && (
        <fieldset className="rws-options" disabled={busy}>
          <legend className="sr-only">选择题选项</legend>
          {question!.options.map((option, index) => (
            <label
              key={index}
              className={`rws-option ${
                revealed && question!.correctIndex === index ? "correct" : ""
              } ${
                revealed && selected === index && !selectedCorrect
                  ? "incorrect"
                  : ""
              }`}
            >
              <input
                type="radio"
                name={`review-${item.id}`}
                checked={selected === index}
                onChange={() => setSelected(index)}
              />
              <span className="rws-option-letter">
                {String.fromCharCode(65 + index)}
              </span>
              <RichText>{option}</RichText>
            </label>
          ))}
        </fieldset>
      )}

      <div className="rws-reveal-row">
        <button
          type="button"
          className="text-button"
          aria-expanded={showHint}
          disabled={busy}
          onClick={() => setShowHint(!showHint)}
        >
          <Lightbulb size={15} aria-hidden="true" />
          {showHint ? "收起提示" : "给我一点提示"}
        </button>
        <button
          type="button"
          className="text-button"
          aria-expanded={revealed}
          disabled={busy}
          onClick={() => setRevealed(true)}
        >
          <Eye size={15} aria-hidden="true" />
          显示答案与解析
        </button>
      </div>

      {showHint && (
        <div className="rws-hint">
          <RichHint item={item} question={question} />
        </div>
      )}

      {revealed && (
        <div className={`rws-explanation ${selectedCorrect ? "is-correct" : ""}`}>
          {hasOptions && (
            <strong>
              {selectedCorrect
                ? "你选对了"
                : selected !== null
                  ? `正确答案：${String.fromCharCode(65 + question!.correctIndex)}`
                  : `正确答案：${String.fromCharCode(65 + question!.correctIndex)}（你还没有作答）`}
            </strong>
          )}
          <RichText>{item.correctExplanation}</RichText>
          {hasOptions && (
            <div className="rws-original">
              <RichText>{`原题解析：${question!.explanation}`}</RichText>
            </div>
          )}
          <p className="rws-honest">
            看过解析不等于掌握：请先合上答案，自己复述一遍推理，再在下方自评。
          </p>
        </div>
      )}

      {onOpenTopic && (
        <button
          type="button"
          className="rws-topic-link"
          disabled={busy}
          onClick={() => onOpenTopic(item)}
        >
          <BookOpen size={14} aria-hidden="true" />
          回到「{item.topic}」相关内容
        </button>
      )}

      {onExplain && (
        <div className="rws-explain">
          <button
            type="button"
            className="text-button"
            disabled={busy || explaining}
            onClick={async () => {
              setExplaining(true);
              setExplainError("");
              try { setExplanation(await onExplain(item)); }
              catch (cause) { setExplainError(cause instanceof Error ? cause.message : "补讲未生成，请重试。"); }
              finally { setExplaining(false); }
            }}
          >
            <Lightbulb size={14} aria-hidden="true" />
            {explaining ? "正在针对这个卡点补讲…" : explanation ? "重新补讲" : "针对这个卡点补讲"}
          </button>
          {explainError && <p role="alert">{explainError}</p>}
          {explanation && (
            <section aria-label="本次补讲">
              <RichText>{explanation}</RichText>
              <small>这是针对原题与已保存解析的补讲，不自动增加理解证据。</small>
            </section>
          )}
        </div>
      )}

      <div className="rws-rate" role="group" aria-label="自评掌握程度">
        <span className="rws-rate-label">
          <CircleHelp size={13} aria-hidden="true" />
          现在能独立讲清楚吗？
        </span>
        <div className="rws-rate-buttons">
          {(["again", "fuzzy", "known"] as ReviewRating[]).map((rating) => (
            <button
              key={rating}
              type="button"
              className={`rws-rate-button ${rating}`}
              disabled={busy}
              title={ratingHints[rating]}
              onClick={() => handleRate(rating)}
            >
              {rating === "again" && (
                <X size={14} aria-hidden="true" />
              )}
              {rating === "fuzzy" && (
                <CircleHelp size={14} aria-hidden="true" />
              )}
              {rating === "known" && (
                <Check size={14} aria-hidden="true" />
              )}
              {ratingLabels[rating]}
            </button>
          ))}
        </div>
        <small>自评只决定下次出现的时间，不代表掌握已被证明。</small>
      </div>
    </article>
  );
}

function RichHint({
  item,
  question,
}: {
  item: ReviewItem;
  question?: QuizQuestion;
}) {
  const hint = question?.hint || item.hint;
  if (!hint) {
    return (
      <p className="rws-hint-empty">
        这个复习项没有保存提示。试着先回忆当时错在哪里，再显示答案。
      </p>
    );
  }
  return <RichText>{hint}</RichText>;
}

export function ReviewWorkspace({
  reviews,
  questionsById = {},
  now = Date.now(),
  busy = false,
  onRate,
  onOpenTopic,
  onExplain,
}: ReviewWorkspaceProps) {
  const due = reviews
    .filter((item) => item.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
  const upcoming = reviews
    .filter((item) => item.dueAt > now)
    .sort((a, b) => a.dueAt - b.dueAt);
  const [tab, setTab] = useState<"due" | "upcoming">("due");
  const [earlyReviewId, setEarlyReviewId] = useState<string | null>(null);
  const earlyReview = upcoming.find(item => item.id === earlyReviewId);

  return (
    <section className="rws-root" aria-label="复习工作台">
      <header className="rws-head">
        <span className="eyebrow">REVIEW</span>
        <h2>
          <Timer size={18} aria-hidden="true" />
          复习工作台
        </h2>
        <p>
          复习项来自真实的测验错题和误区。先自己想，再看提示和答案；用「忘了 / 模糊 / 会了」自评来安排下一次。
        </p>
        <div className="rws-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "due"}
            className={tab === "due" ? "active" : ""}
            onClick={() => setTab("due")}
          >
            到期 {due.length}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "upcoming"}
            className={tab === "upcoming" ? "active" : ""}
            onClick={() => setTab("upcoming")}
          >
            未到期 {upcoming.length}
          </button>
        </div>
      </header>

      {tab === "due" &&
        (due.length === 0 ? (
          <div className="rws-empty">
            <Check size={30} aria-hidden="true" />
            <h3>当前没有到期复习</h3>
            <p>到这里说明之前的复习都按计划完成了。</p>
          </div>
        ) : (
          <div className="rws-cards">
            {due.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                question={item.questionId ? questionsById[item.questionId] : undefined}
                busy={busy}
                onRate={onRate}
                onOpenTopic={onOpenTopic}
                onExplain={onExplain}
              />
            ))}
          </div>
        ))}

      {tab === "upcoming" &&
        (upcoming.length === 0 ? (
          <div className="rws-empty">
            <Timer size={30} aria-hidden="true" />
            <h3>还没有安排中的复习</h3>
            <p>在测验中答错或出现误区后，复习项会自动出现。</p>
          </div>
        ) : (
          <ul className="rws-upcoming">
            {upcoming.map((item) => (
              <li key={item.id}>
                <strong>{item.topic}</strong>
                <span>{kindLabels[item.kind] ?? "复习"}</span>
                <small>{formatDue(now, item.dueAt)}</small>
                <time dateTime={new Date(item.dueAt).toISOString()}>{new Date(item.dueAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                <button type="button" className="text-button rws-early-button" disabled={busy} onClick={() => setEarlyReviewId(current => current === item.id ? null : item.id)} aria-expanded={earlyReviewId === item.id}>
                  {earlyReviewId === item.id ? "收起复习" : "提前复习"}
                </button>
                {earlyReview?.id === item.id && (
                  <div className="rws-early-card">
                    <ReviewCard item={item} question={item.questionId ? questionsById[item.questionId] : undefined} busy={busy} onRate={onRate} onOpenTopic={onOpenTopic} onExplain={onExplain} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

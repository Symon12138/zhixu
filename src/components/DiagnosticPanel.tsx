import { Compass, RotateCcw } from "lucide-react";
import type { DiagnosticProfile } from "../types";
import { RichText } from "./RichText";

export function DiagnosticPanel({
  profile,
  busy,
  onChange,
  onSubmit,
  onRestart,
}: {
  profile: DiagnosticProfile;
  busy?: boolean;
  onChange: (answers: Record<string, number>) => void;
  onSubmit: () => void;
  onRestart?: () => void;
}) {
  const questions = profile.questions;
  const answeredCount = questions.filter(
    (question) => profile.answers[question.id] !== undefined,
  ).length;
  const firstUnanswered = questions.find(
    (question) => profile.answers[question.id] === undefined,
  );
  const unansweredCount = questions.length - answeredCount;

  if (profile.submitted) {
    const correctCount = questions.filter(
      (question) => profile.answers[question.id] === question.correctIndex,
    ).length;
    return (
      <section className="diagnostic-panel">
        <div className="section-intro">
          <span className="eyebrow">KNOW WHERE YOU STAND</span>
          <h2>识别起点：建议先处理第 {Math.min(profile.recommendedStepIndex + 1, questions.length)} 个诊断点</h2>
          <p>
            {profile.topic} · {profile.level} · 答对 {correctCount} /{" "}
            {questions.length} 题。这只是识别出的起点，不等于已经掌握。
          </p>
        </div>
        {(profile.weakConcepts.length > 0 ||
          profile.skippedConcepts.length > 0 ||
          profile.evidenceSummary.length > 0) && (
          <div className="diagnostic-insights">
            {profile.weakConcepts.length > 0 && (
              <div className="diagnostic-insight">
                <h3>薄弱概念</h3>
                <ul>
                  {profile.weakConcepts.map((concept) => (
                    <li key={concept}><RichText>{concept}</RichText></li>
                  ))}
                </ul>
              </div>
            )}
            {profile.skippedConcepts.length > 0 && (
              <div className="diagnostic-insight">
                <h3>已识别正确（仍需推理核验）</h3>
                <ul>
                  {profile.skippedConcepts.map((concept) => (
                    <li key={concept}><RichText>{concept}</RichText></li>
                  ))}
                </ul>
              </div>
            )}
            {profile.evidenceSummary.length > 0 && (
              <div className="diagnostic-insight">
                <h3>判定依据</h3>
                <ul>
                  {profile.evidenceSummary.map((item, index) => (
                    <li key={index}>
                      <RichText>{item}</RichText>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="quiz-list">
          {questions.map((question, index) => {
            const selected = profile.answers[question.id];
            const isCorrect = selected === question.correctIndex;
            return (
              <article className="question-card" key={question.id}>
                <div className="question-header">
                  <span className="question-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <RichText>{question.question}</RichText>
                  </div>
                </div>
                <fieldset className="answer-options" disabled>
                  <legend className="sr-only">第 {index + 1} 题选项</legend>
                  {question.options.map((option, optionIndex) => (
                    <label
                      className={`answer-option ${selected === optionIndex ? "selected" : ""} ${question.correctIndex === optionIndex ? "correct" : ""} ${selected === optionIndex && !isCorrect ? "incorrect" : ""}`}
                      key={optionIndex}
                    >
                      <input type="radio" name={question.id} checked={selected === optionIndex} readOnly />
                      <span className="option-letter">
                        {String.fromCharCode(65 + optionIndex)}
                      </span>
                      <RichText>{option}</RichText>
                      {question.correctIndex === optionIndex && "（正确答案）"}
                    </label>
                  ))}
                </fieldset>
                <div
                  className={`answer-explanation ${isCorrect ? "is-correct" : ""}`}
                >
                  <strong>
                    {selected === undefined
                      ? "未作答"
                      : isCorrect
                        ? "回答正确"
                        : `正确答案：${String.fromCharCode(65 + question.correctIndex)}`}
                  </strong>
                  <RichText>{question.explanation}</RichText>
                </div>
              </article>
            );
          })}
        </div>
        {onRestart && (
          <div className="diagnostic-footer">
            <p>将新建一个诊断会话；当前画像保留在原会话中，新题成功生成后才会打开。</p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={onRestart}
            >
              <RotateCcw size={15} />
              生成新画像
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="diagnostic-panel">
      <div className="section-intro">
        <span className="eyebrow">A FEW QUESTIONS FIRST</span>
        <h2>先聊聊 {profile.topic}，看看从哪里开始最合适</h2>
        <p>
          {questions.length} 道题，凭直觉答就好——这不是考试，是用来识别起点的。
        </p>
      </div>
      <div className="quiz-list">
        {questions.map((question, index) => {
          const selected = profile.answers[question.id];
          return (
            <article className="question-card" key={question.id}>
              <div className="question-header">
                <span className="question-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <RichText>{question.question}</RichText>
                </div>
              </div>
              <fieldset className="answer-options">
                <legend className="sr-only">第 {index + 1} 题选项</legend>
                {question.options.map((option, optionIndex) => (
                  <label
                    className={`answer-option ${selected === optionIndex ? "selected" : ""}`}
                    key={optionIndex}
                  >
                    <input
                      type="radio"
                      name={question.id}
                      checked={selected === optionIndex}
                      disabled={busy}
                      onChange={() =>
                        onChange({
                          ...profile.answers,
                          [question.id]: optionIndex,
                        })
                      }
                    />
                    <span className="option-letter">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    <RichText>{option}</RichText>
                  </label>
                ))}
              </fieldset>
              <details className="hint-details">
                <summary>给一点提示</summary>
                <div className="hint-box">
                  <RichText>{question.hint}</RichText>
                </div>
              </details>
            </article>
          );
        })}
      </div>
      <div className="quiz-submit">
        <span>
          已完成 {answeredCount} / {questions.length} 题
        </span>
        {unansweredCount > 0 && (
          <span className="diagnostic-unanswered" role="note">
            还有 {unansweredCount} 题未作答，提交后第{" "}
            {questions.indexOf(firstUnanswered!) + 1} 题会记为无法判断；结果页会单独标出。
          </span>
        )}
        <button className="button primary" disabled={busy} onClick={onSubmit}>
          <Compass size={16} />
          识别我的起点
        </button>
      </div>
    </section>
  );
}

import type { LearningQuestion } from "../src/types";

const numericPattern = /(?<![A-Za-z0-9])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/(?:\d+(?:\.\d+)?|\.\d+))?%?(?!\d)/g;

function normalizeNumber(token: string): string {
  const percent = token.endsWith("%") ? "%" : "";
  const raw = percent ? token.slice(0, -1) : token;
  if (raw.includes("/")) return raw.split("/").map(normalizeNumber).join("/") + percent;
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [integer, fractional = ""] = unsigned.split(".");
  const whole = (integer || "0").replace(/^0+(?=\d)/, "");
  const fraction = fractional.replace(/0+$/, "");
  const normalized = whole + (fraction ? `.${fraction}` : "");
  return (negative && normalized !== "0" ? "-" : "") + normalized + percent;
}

function numberKeys(text: string): Set<string> {
  const withoutListMarkers = text.normalize("NFKC").replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "").replace(/^\s*\d+[.)、]\s+/gm, "");
  return new Set((withoutListMarkers.match(numericPattern) ?? []).map(normalizeNumber));
}

/** Read existing private criteria without inventing a solution or changing old state. */
export function protectedAnswersFor(question: Pick<LearningQuestion, "kind" | "protectedAnswers" | "successCriteria">): string[] {
  if (question.protectedAnswers?.length) return [...question.protectedAnswers];
  if (["orientation", "choice"].includes(question.kind)) return [];
  // Numeric targets also occur in reasoning rubrics; read stated values, never solve the problem.
  return [...new Set(question.successCriteria.flatMap(criterion => criterion.normalize("NFKC").match(numericPattern) ?? []))];
}

function protectedNumberKeys(question: Pick<LearningQuestion, "kind" | "protectedAnswers" | "successCriteria">): Set<string> {
  const keys = new Set<string>();
  for (const answer of protectedAnswersFor(question)) {
    const normalized = answer.normalize("NFKC").trim();
    const exact = normalized.match(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/(?:\d+(?:\.\d+)?|\.\d+))?%?$/);
    if (exact) keys.add(normalizeNumber(exact[0]));
    else if (question.kind === "calculation") for (const token of normalized.match(numericPattern) ?? []) keys.add(normalizeNumber(token));
  }
  return keys;
}

/** 计算题必须能抽取出至少一个数值答案，否则无法防止泄露与独立核算。 */
export function hasNumericProtectedAnswer(question: Pick<LearningQuestion, "kind" | "protectedAnswers" | "successCriteria">): boolean {
  return question.kind === "calculation" && protectedNumberKeys(question).size > 0;
}

/**
 * Deterministic final-number check for calculation questions. Returns undefined when the
 * question has no numeric key, so semantic judgement remains with the reviewer.
 * This is not a symbolic grader: every protected numeric target must appear in the
 * learner's current answer, matching the release-eval numeric gate.
 */
export function matchesProtectedNumbers(
  question: Pick<LearningQuestion, "kind" | "protectedAnswers" | "successCriteria">,
  learnerText: string,
): boolean | undefined {
  if (question.kind !== "calculation") return undefined;
  const expected = protectedNumberKeys(question);
  if (!expected.size) return undefined;
  const given = numberKeys(learnerText);
  return [...expected].every(value => given.has(value));
}

/** Literal leak protection complements semantic review; it is not a symbolic maths grader. */
export function exposesProtectedAnswer(
  question: Pick<LearningQuestion, "prompt" | "kind" | "protectedAnswers" | "successCriteria">,
  learnerText: string,
  publicFields: string[],
): boolean {
  const answers = protectedAnswersFor(question);
  if (!answers.length) return false;
  const given = numberKeys(question.prompt);
  const proposed = numberKeys(learnerText);
  const publicText = publicFields.join("\n");
  const visible = numberKeys(publicText);
  const normalizedPublic = publicText.normalize("NFKC").replace(/\s+/g, "");
  const normalizedInput = (question.prompt + "\n" + learnerText).normalize("NFKC").replace(/\s+/g, "");
  for (const answer of answers) {
    const exactNumber = answer.normalize("NFKC").trim().match(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/(?:\d+(?:\.\d+)?|\.\d+))?%?$/);
    if (exactNumber) {
      const key = normalizeNumber(exactNumber[0]);
      if (!given.has(key) && !proposed.has(key) && visible.has(key)) return true;
    } else {
      const key = answer.normalize("NFKC").replace(/\s+/g, "");
      if (key && !normalizedInput.includes(key) && normalizedPublic.includes(key)) return true;
      // A labelled legacy answer such as “单位净值1.05” still protects its computed value.
      if (question.kind === "calculation") {
        for (const token of answer.match(numericPattern) ?? []) {
          const key = normalizeNumber(token);
          if (!given.has(key) && !proposed.has(key) && visible.has(key)) return true;
        }
      }
    }
  }
  return false;
}

export function explicitlyRequestsSolution(text: string): boolean {
  return /(?:直接|完整|最终).{0,10}(?:答案|解答|结果|计算过程)|(?:给我|告诉我|公布).{0,8}(?:答案|解答|结果)|(?:答案|结果)(?:是|应是|应该是|到底是)?什么|不要提示|不用提示/.test(text);
}

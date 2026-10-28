import assert from "node:assert/strict";
import test from "node:test";
import { BookContextError, parseBookContext, parseBookSourceLocation } from "../server/books";
import { runTeachingTurn, TeachingQualityError } from "../server/tutor";
import { applyTutorDraft } from "../server/learning";
import { compileLessonReview, parseLessonContent } from "../server/protocol";
import { passingReview, requestFor, stateWithQuestion } from "./fixtures";
import type { ChatRequest, Reference } from "../src/types";
import type { BookStudyContext } from "../src/bookTypes";

const location = { bookId: "owned", chapterId: "chapter-1", blockId: "block-1", chapterTitle: "原文与笔记", locator: "第一章 · 第1段" };
const original = "原文是作者写下的内容，个人笔记是读者的理解。两者应分开记录，引用时回到原文。";
const reference: Reference = { name: "原创读本·第一章·第1段", text: original, location };
const context: BookStudyContext = { bookId: "owned", title: "原创读本", author: "测试作者", format: "epub", mode: "chapter", chapterId: "chapter-1", chapterTitle: "原文与笔记", tableOfContents: ["原文与笔记", "独立应用"], totalChapters: 2, totalBlocks: 8, chapterBlocks: 5, suppliedBlockIds: ["block-1"], completeChapter: false, completeBook: false };
function openingRequest(): ChatRequest { return { topic: "原创读本第一章", level: "从零开始", goal: "理解原文与笔记边界", action: "start", messages: [{ role: "user", content: "请讲清已提供的原文。" }], references: [structuredClone(reference)], bookContext: structuredClone(context) }; }
function lesson(sources: unknown[] = [{ name: reference.name, quote: "个人笔记是读者的理解。" }]) { return { title: "原文与理解", plan: ["辨认作者原话", "区分个人解释", "用出处核对"], message: "作者把原文和读者的理解分开。引用别人的观点时，应回到原书，不拿个人猜测冒充作者结论。", question: { prompt: "你希望先看原文和解释的区别，还是练习引用？", kind: "orientation", options: ["先看区别", "练习引用"], successCriteria: ["表达学习方向"] }, sources, assumptions: [] }; }

test("片段数量与身份不符时不能声明完整本章或整书", () => {
  assert.equal(parseBookContext(context, [reference])!.completeBook, false);
  for (const bad of [
    { ...context, completeBook: true }, { ...context, completeChapter: true },
    { ...context, suppliedBlockIds: ["another-block"] },
    { ...context, totalChapters: 3 }, { ...context, chapterId: "another-chapter" },
  ]) assert.throws(() => parseBookContext(bad, [reference]), BookContextError);
  assert.throws(() => parseBookContext(context, [{ ...reference, location: { ...location, bookId: "other-book" } }]), BookContextError);
  assert.throws(() => parseBookContext(undefined, [reference]), BookContextError);
});

test("超限原文、无定位原文与重复来源不能混入本书请求", () => {
  assert.throws(() => parseBookContext(context, [{ ...reference, text: "x".repeat(24_001) }]), BookContextError);
  assert.throws(() => parseBookContext(context, [{ name: reference.name, text: original }]), BookContextError);
  assert.throws(() => parseBookSourceLocation({ ...location, page: 0 }), BookContextError);
  assert.throws(() => parseBookSourceLocation({ ...location, blockId: "" }), BookContextError);
});

test("逐字引文通过后绑定实际段落位置，不信模型给的伪造locator", async () => {
  const request = openingRequest();
  const forged = { name: reference.name, quote: "个人笔记是读者的理解。", location: { ...location, bookId: "forged", blockId: "fake", locator: "编造页码999" } };
  const result = await runTeachingTurn(request, async invocation => invocation.purpose === "review" ? passingReview : JSON.stringify(lesson([forged])));
  assert.deepEqual(result.teaching!.sources[0].location, location);
  assert.equal(result.teaching!.sources[0].quote, forged.quote);
  assert.ok(result.learningState!.steps.every(step => step.evidence.length === 0 && step.mastery !== "understood"));
});

test("没有实际原文引文不能发布书籍讲解，格式修订后仍须独立评审", async () => {
  const phases: string[] = [];
  const result = await runTeachingTurn(openingRequest(), async invocation => {
    phases.push(invocation.purpose);
    return invocation.purpose === "review" ? passingReview : JSON.stringify(lesson(invocation.purpose === "draft" ? [] : undefined));
  });
  assert.deepEqual(phases, ["draft", "repair", "review"]);
  assert.equal(result.quality!.modelCalls, 3);
  assert.deepEqual(result.teaching!.sources[0].location, location);
});

test("编造或改写原文的引文被拒绝，不能靠同名书籍获得通过", async () => {
  const request = openingRequest();
  await assert.rejects(runTeachingTurn(request, async invocation => invocation.purpose === "review" ? passingReview : JSON.stringify(lesson([{ name: reference.name, quote: "作者认为看过就算掌握。" }]))),
    (error: unknown) => error instanceof TeachingQualityError && error.issues.some(issue => issue.code === "fabricated_source"));
});

test("书籍复盘与卡片工具仍保留出处回执，不改主线证据与问题", () => {
  const state = stateWithQuestion();
  const request = { ...requestFor(state, "", "summary"), references: [reference], bookContext: context };
  const content = parseLessonContent({ message: "本次只复盘已提供的原文：作者原话与个人理解应分开；还没有独立验证掌握。", sources: [{ name: reference.name, quote: "两者应分开记录，引用时回到原文。" }] }, "summary");
  const outcome = compileLessonReview(request, content, JSON.parse(passingReview));
  assert.equal(outcome.pass, true, JSON.stringify(outcome.issues));
  const response = applyTutorDraft(request, outcome.draft!, { repaired: false, modelCalls: 2 });
  assert.deepEqual(response.learningState, state);
  assert.equal(response.teaching!.assessment.verdict, "not_assessed");
  assert.deepEqual(response.teaching!.sources[0].location, location);
});

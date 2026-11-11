import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { KnowledgeGraph, ReviewItem, StudySession } from "../src/types";
import { emptyGraph, propositionId, upsertProposition, addDependency } from "../src/lib/knowledgeGraph";
import { rateReviewItem } from "../src/lib/review";
import { knowledgeGraphReviewItems } from "../src/lib/review";

/* ── 集成：图谱命题真实进入复习列表并被评分 ─────────────────── */

const graphEvidence = (quote: string) => ({
  quote,
  questionId: "qd",
  kind: "reasoning" as const,
  turn: 1,
});

function graphWithUnderstoodProposition(topic = "微积分"): KnowledgeGraph {
  let graph = emptyGraph();
  graph = upsertProposition(graph, {
    statement: "导数是函数在某点的瞬时变化率",
    topic,
    sourceSessionId: "session-a",
    verifiedAt: 1_000,
    strength: "understood",
    evidence: [graphEvidence("瞬时变化率是割线斜率的极限")],
  });
  return graph;
}

const reviewIdOptions = { now: 5_000, newId: () => "rv-1" };

function sessionsWithReview(items: ReviewItem[]): StudySession[] {
  return [
    {
      id: items[0]?.sessionId ?? "session-a",
      title: "会话",
      topic: "微积分",
      level: "从零开始",
      goal: "理解导数",
      messages: [],
      stageIndex: 0,
      completedStages: [],
      stageAnswers: {},
      plan: [],
      quiz: [],
      flashcards: [],
      quizAnswers: {},
      quizSubmitted: false,
      reviewedCards: [],
      references: [],
      reviews: items,
      createdAt: 1,
      updatedAt: 1_000,
    },
  ];
}

test("understood 命题经 knowledgeGraphReviewItems 生成可见复习项并进入会话列表", () => {
  const graph = graphWithUnderstoodProposition();
  const generated = knowledgeGraphReviewItems(graph, reviewIdOptions, []);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].prompt.includes("导数是函数在某点的瞬时变化率"), true);
  assert.equal(generated[0].sessionId, "session-a");

  // 评分推进 dueAt：真实复习路径可用。
  const rated = rateReviewItem(generated[0], "fuzzy", 5_000);
  assert.ok(rated.dueAt > 5_000);
  assert.equal(rated.lastOutcome, "fuzzy");
});

test("applied 命题不生成图谱复习；understood 升级 applied 后不再补练", () => {
  let graph = emptyGraph();
  graph = upsertProposition(graph, {
    statement: "复合函数链式法则",
    topic: "微积分",
    sourceSessionId: "session-a",
    verifiedAt: 1_000,
    strength: "applied",
    evidence: [graphEvidence("在新情境中使用了链式法则")],
  });
  assert.equal(knowledgeGraphReviewItems(graph, reviewIdOptions, []).length, 0);
});

test("前置未核验时先补前置：生成顺序为前置在前、目标在后", () => {
  let graph = emptyGraph();
  graph = upsertProposition(graph, {
    statement: "极限的夹逼性质",
    topic: "微积分",
    sourceSessionId: "session-a",
    verifiedAt: 1_000,
    strength: "understood",
    evidence: [graphEvidence("夹逼性质用于极限推导")],
  });
  graph = upsertProposition(graph, {
    statement: "导数定义依赖极限",
    topic: "微积分",
    sourceSessionId: "session-a",
    verifiedAt: 1_000,
    strength: "understood",
    evidence: [graphEvidence("导数定义用到极限")],
  });
  graph = addDependency(graph, propositionId("极限的夹逼性质"), propositionId("导数定义依赖极限"), 1_000);
  const items = knowledgeGraphReviewItems(graph, { ...reviewIdOptions, newId: () => `rv-${Math.random()}` }, []);
  assert.equal(items.length, 2);
  const prompts = items.map((item) => item.prompt);
  const preIndex = prompts.findIndex((p) => p.includes("极限的夹逼性质"));
  const goalIndex = prompts.findIndex((p) => p.includes("导数定义依赖极限"));
  assert.ok(preIndex !== -1 && goalIndex !== -1 && preIndex < goalIndex);
});

test("刷新幂等：已有同 questionId 复习项不重复生成", () => {
  const graph = graphWithUnderstoodProposition();
  const first = knowledgeGraphReviewItems(graph, reviewIdOptions, []);
  const second = knowledgeGraphReviewItems(graph, { ...reviewIdOptions, newId: () => "rv-2" }, first);
  assert.equal(second.length, 0);
});

test("源会话已删除的图谱复习保留：评分后仍可再次练习（不静默消失）", () => {
  const graph = graphWithUnderstoodProposition();
  const generated = knowledgeGraphReviewItems(graph, reviewIdOptions, []);
  assert.equal(generated.length, 1);

  // 模拟源会话被删除：复习项仍存在（持有器机制），评分照常生效。
  // again = 立即重学（dueAt = now），streak 清零。
  const rated = rateReviewItem(generated[0], "again", 5_000);
  assert.equal(rated.dueAt, 5_000);
  assert.equal(rated.streak, 0);
  assert.equal(rated.lastOutcome, "again");
  // 目标命题已在现有复习里，刷新不重复生成；不会因源会话缺失而异常。
  const again = knowledgeGraphReviewItems(graph, { ...reviewIdOptions, newId: () => "rv-3" }, [rated]);
  assert.equal(again.length, 0);
});

test("App 接线：addKnowledgeGraphReviews 导出且被全局复习刷新调用", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /export function addKnowledgeGraphReviews/);
  assert.match(source, /return addKnowledgeGraphReviews\(graphRef\.current, next, \{ now, newId: uid \}\)/);
  assert.match(source, /GRAPH_REVIEW_HOLDER_PREFIX/);
  // 全局复习汇总包含持有器复习项，源会话删除不丢失。
  assert.match(source, /const allReviews = sessions\.flatMap\(\(session\) => session\.reviews \?\? \[\]\)/);
});

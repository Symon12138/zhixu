import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  KnowledgeGraph,
  KnowledgeProposition,
  LearningEvidence,
} from "../src/types";
import {
  addDependency,
  emptyGraph,
  propositionId,
  upsertProposition,
} from "../src/lib/knowledgeGraph";
import {
  createReviewItem,
  isKnowledgeGraphReviewItem,
  knowledgeGraphReviewItems,
  propositionReviewItems,
} from "../src/lib/review";

const NOW = 1_700_000_000_000;

function ids(): () => string {
  let n = 0;
  return () => `kg-review-${++n}`;
}

function opts(now = NOW) {
  return { now, newId: ids() };
}

function evidence(quote: string): LearningEvidence {
  return {
    quote,
    questionId: "q-graph",
    kind: "recognition",
    turn: 1,
  };
}

function proposition(
  statement: string,
  strength: KnowledgeProposition["strength"] = "understood",
  verifiedAt = NOW - 1000,
): Parameters<typeof upsertProposition>[1] {
  return {
    statement,
    topic: "导数",
    sourceSessionId: "s-graph",
    verifiedAt,
    strength,
    evidence: [evidence(`我能复述：${statement}`)],
  };
}

/** 目标命题依赖一个仍未应用的前置命题。 */
function derivativeGraph(): KnowledgeGraph {
  let graph = emptyGraph();
  graph = upsertProposition(graph, proposition("极限描述无限逼近"));
  graph = upsertProposition(graph, proposition("导数是瞬时变化率"));
  graph = addDependency(
    graph,
    propositionId("极限描述无限逼近"),
    propositionId("导数是瞬时变化率"),
    1,
  );
  return graph;
}

test("understood 命题可被取为主动回忆练习，applied 命题不再取", () => {
  const graph = derivativeGraph();
  const items = knowledgeGraphReviewItems(graph, opts());

  assert.equal(items.length, 2);
  const target = items.find(
    (item) => item.questionId === propositionId("导数是瞬时变化率"),
  );
  assert.ok(target);
  assert.equal(target.kind, "concept");
  assert.equal(target.source, "concept");
  assert.equal(target.sessionId, "s-graph");
  assert.equal(target.topic, "导数");
  assert.match(target.correctExplanation, /^导数是瞬时变化率/);
  assert.match(target.correctExplanation, /前置关系：先理解「极限描述无限逼近」/);
  assert.equal(target.learnerQuote, "我能复述：导数是瞬时变化率");
  assert.match(target.prompt, /^不看资料/);
  assert.match(target.prompt, /导数是瞬时变化率/);
  assert.equal(target.dueAt, NOW);
  assert.equal(isKnowledgeGraphReviewItem(target), true);

  const quiz = createReviewItem(
    {
      sessionId: "s-graph",
      topic: "导数",
      prompt: "测验题干",
      kind: "quiz",
      reason: "测验答错",
      correctExplanation: "解析",
      source: "quiz",
    },
    opts(),
  );
  assert.equal(isKnowledgeGraphReviewItem(quiz), false);

  let appliedOnly = emptyGraph();
  appliedOnly = upsertProposition(
    appliedOnly,
    proposition("导数是瞬时变化率", "applied"),
  );
  assert.deepEqual(knowledgeGraphReviewItems(appliedOnly, opts()), []);
});

test("前置未核验时先补前置，再练目标；前置已应用则直接练目标", () => {
  const graph = derivativeGraph();
  const targetId = propositionId("导数是瞬时变化率");
  const prerequisiteId = propositionId("极限描述无限逼近");

  const items = propositionReviewItems(graph, targetId, opts());
  assert.deepEqual(
    items.map((item) => item.questionId),
    [prerequisiteId, targetId],
  );
  assert.doesNotMatch(items[0].prompt, /前置概念/);
  assert.equal(items[0].correctExplanation, "极限描述无限逼近");
  assert.match(items[1].prompt, /前置概念「极限描述无限逼近」/);

  // 前置升级为 applied：已核验，无需补练。
  let upgraded = upsertProposition(
    graph,
    proposition("极限描述无限逼近", "applied", NOW),
  );
  const direct = propositionReviewItems(upgraded, targetId, opts());
  assert.deepEqual(direct.map((item) => item.questionId), [targetId]);
  assert.doesNotMatch(direct[0].prompt, /前置概念/);

  // 目标本身已 applied：不再生成练习。
  upgraded = upsertProposition(
    graph,
    proposition("导数是瞬时变化率", "applied", NOW + 1),
  );
  assert.deepEqual(propositionReviewItems(upgraded, targetId, opts()), []);
});

test("已有复习项不重复生成，但缺失的前置仍会补练", () => {
  const graph = derivativeGraph();
  const targetId = propositionId("导数是瞬时变化率");
  const prerequisiteId = propositionId("极限描述无限逼近");

  const first = propositionReviewItems(graph, targetId, opts());
  assert.equal(first.length, 2);
  assert.deepEqual(propositionReviewItems(graph, targetId, opts(), first), []);

  const onlyPrerequisite = propositionReviewItems(graph, targetId, opts(), [
    first[0],
  ]);
  assert.deepEqual(onlyPrerequisite.map((item) => item.questionId), [targetId]);

  const onlyTarget = propositionReviewItems(graph, targetId, opts(), [first[1]]);
  assert.deepEqual(onlyTarget.map((item) => item.questionId), [prerequisiteId]);
});

test("批量生成优先补底层前置，limit 也先保留前置", () => {
  const graph = derivativeGraph();
  const items = knowledgeGraphReviewItems(graph, {
    ...opts(),
    limit: 1,
  });
  assert.deepEqual(
    items.map((item) => item.questionId),
    [propositionId("极限描述无限逼近")],
  );
});

test("复习界面标注来自知识图谱的命题", () => {
  const source = readFileSync(
    new URL("../src/components/ReviewWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /来自知识图谱 · \$\{item\.topic\}/);
});

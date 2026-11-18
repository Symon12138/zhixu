import assert from "node:assert/strict";
import test from "node:test";
import { isKnowledgeGraph } from "../src/lib/backup";
import {
  addPropositionsFromNote,
  emptyGraph,
  GRAPH_PROPOSITION_LIMIT,
  mergeGraphs,
  noteCandidateStatements,
  priorProbeTargets,
  propositionId,
} from "../src/lib/knowledgeGraph";
import type {
  KnowledgeGraph,
  KnowledgeProposition,
  Note,
} from "../src/types";

const NOW = 1_700_000_000_000;

function makeNote(content: string, overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    sessionId: "session-1",
    title: "导数笔记",
    content,
    createdAt: NOW,
    ...overrides,
  };
}

function makeProposition(
  statement: string,
  strength: KnowledgeProposition["strength"],
  verifiedAt = NOW,
): KnowledgeProposition {
  return {
    id: propositionId(statement),
    statement,
    topic: "导数",
    sourceSessionId: "session-1",
    verifiedAt,
    strength,
    evidence: [],
  };
}

test("笔记候选：按行与句末标点切分，去掉符号编号并去重", () => {
  const candidates = noteCandidateStatements(
    makeNote(
      [
        "# 导数",
        "- 导数是函数在某一点的瞬时变化率。",
        "- 导数是函数在某一点的瞬时变化率。",
        "1. 求导时先看幂指对的结构。",
        "短",
        "这一行没有句号但它足够长可以成为候选",
      ].join("\n"),
    ),
  );
  assert.ok(candidates.includes("导数是函数在某一点的瞬时变化率"));
  assert.ok(!candidates.some((item) => item.startsWith("#") || item.startsWith("-")));
  assert.ok(!candidates.includes("短"));
  assert.ok(candidates.includes("这一行没有句号但它足够长可以成为候选"));
  // 同一句只出现一次。
  assert.equal(
    candidates.filter((item) => item === "导数是函数在某一点的瞬时变化率").length,
    1,
  );
});

test("笔记候选：一次最多展示固定条数，空笔记返回空数组", () => {
  const many = Array.from({ length: 30 }, (_, index) => `第${index}条足够长的候选句子。`).join("\n");
  assert.equal(noteCandidateStatements(makeNote(many)).length, 12);
  assert.deepEqual(noteCandidateStatements(makeNote("")), []);
});

test("笔记导入：写入 noted 节点、记录来源笔记，不产生理解证据", () => {
  const note = makeNote("导数是瞬时变化率。切线斜率就是该点导数。");
  const result = addPropositionsFromNote(
    emptyGraph(),
    note,
    ["导数是瞬时变化率", "切线斜率就是该点导数"],
    NOW,
  );
  assert.equal(result.added, 2);
  assert.equal(result.rejected, 0);
  assert.equal(result.graph.propositions.length, 2);
  for (const item of result.graph.propositions) {
    assert.equal(item.strength, "noted");
    assert.equal(item.sourceNoteId, note.id);
    assert.equal(item.sourceSessionId, note.sessionId);
    assert.deepEqual(item.evidence, []);
    assert.equal(item.verifiedAt, NOW);
  }
});

test("笔记导入：重复内容与已删除命题都不会被写入或复活", () => {
  const note = makeNote("导数是瞬时变化率。");
  const first = addPropositionsFromNote(emptyGraph(), note, ["导数是瞬时变化率"], NOW);
  const again = addPropositionsFromNote(first.graph, note, ["导数是瞬时变化率"], NOW + 1);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 1);

  const deletedId = propositionId("导数是瞬时变化率");
  const tombstoned: KnowledgeGraph = {
    ...first.graph,
    deletedPropositionIds: [deletedId],
  };
  const afterDelete = addPropositionsFromNote(tombstoned, note, ["导数是瞬时变化率"], NOW + 2);
  assert.equal(afterDelete.added, 0);
  assert.equal(afterDelete.duplicates, 1);
  assert.equal(
    afterDelete.graph.propositions.some((item) => item.id === deletedId),
    false,
  );
});

test("图谱容量：达到命题上限后确定性拒绝新增并报告条数", () => {
  const propositions = Array.from({ length: GRAPH_PROPOSITION_LIMIT }, (_, index) =>
    makeProposition(`已存在的命题${index}`, "understood"),
  );
  const full: KnowledgeGraph = { propositions, dependencies: [] };
  const result = addPropositionsFromNote(
    full,
    makeNote("新的一句话。另一句新的话。"),
    ["一条全新的待核验概念", "另一条全新的待核验概念"],
    NOW,
  );
  assert.equal(result.added, 0);
  assert.equal(result.rejected, 2);
  assert.equal(result.graph.propositions.length, GRAPH_PROPOSITION_LIMIT);
});

test("强度偏序：笔记导入不会把已理解节点降级", () => {
  const statement = "导数是瞬时变化率";
  const understood = makeProposition(statement, "understood", NOW - 10);
  const local: KnowledgeGraph = { propositions: [understood], dependencies: [] };
  const imported = addPropositionsFromNote(
    local,
    makeNote("导数是瞬时变化率。", { id: "note-2" }),
    [statement],
    NOW,
  );
  // 同内容已存在：不新增、不复活，也不降级。
  assert.equal(imported.added, 0);
  assert.equal(imported.duplicates, 1);

  const remote: KnowledgeGraph = {
    propositions: [
      { ...makeProposition(statement, "noted", NOW), id: understood.id },
    ],
    dependencies: [],
  };
  const merged = mergeGraphs(local, remote);
  const node = merged.propositions.find((item) => item.id === understood.id);
  assert.equal(node?.strength, "understood");
});

test("备份校验：接受 noted 与 sourceNoteId，拒绝未知强度或非法来源", () => {
  const graph = addPropositionsFromNote(
    emptyGraph(),
    makeNote("导数是瞬时变化率。"),
    ["导数是瞬时变化率"],
    NOW,
  ).graph;
  assert.equal(isKnowledgeGraph(graph), true);

  const badStrength = {
    ...graph,
    propositions: [{ ...graph.propositions[0], strength: "mastered" }],
  };
  assert.equal(isKnowledgeGraph(badStrength), false);

  const badSource = {
    ...graph,
    propositions: [{ ...graph.propositions[0], sourceNoteId: 42 }],
  };
  assert.equal(isKnowledgeGraph(badSource), false);
});

test("先验探测只选择已理解前置，不把笔记导入的 noted 当作已掌握", () => {
  const noted = makeProposition("导数是瞬时变化率", "noted", NOW);
  const understood = makeProposition("极限是趋近值", "understood", NOW - 1);
  const targetA = makeProposition("可导必连续", "understood", NOW);
  const targetB = makeProposition("连续不一定可导", "understood", NOW);
  const graph: KnowledgeGraph = {
    propositions: [noted, understood, targetA, targetB],
    dependencies: [
      { fromId: noted.id, toId: targetA.id, createdAt: NOW },
      { fromId: understood.id, toId: targetB.id, createdAt: NOW },
    ],
  };
  assert.deepEqual(
    priorProbeTargets(graph).map((item) => item.id),
    [understood.id],
  );
});

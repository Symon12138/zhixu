import assert from "node:assert/strict";
import test from "node:test";
import {
  addDependency,
  deleteProposition,
  editProposition,
  emptyGraph,
  mergeGraphs,
  mergePropositions,
  propositionId,
  upsertProposition,
} from "../src/lib/knowledgeGraph";
import type { KnowledgeProposition, LearningEvidence } from "../src/types";

const evidence = (quote: string): LearningEvidence => ({
  quote,
  questionId: "q1",
  kind: "reasoning",
  turn: 1,
});

const node = (statement: string, strength: KnowledgeProposition["strength"] = "understood") => ({
  statement,
  topic: "数学",
  sourceSessionId: "s1",
  verifiedAt: 1000,
  strength,
  evidence: [evidence(statement)],
});

test("deleteProposition 移除节点与关联边并记录墓碑，旧副本不会复活", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("A"));
  g = upsertProposition(g, node("B"));
  const a = propositionId("A");
  const b = propositionId("B");
  g = addDependency(g, a, b, 1);
  const older = g; // 模拟另一台设备/旧备份的快照

  const deleted = deleteProposition(g, a);
  assert.equal(deleted.propositions.some((p) => p.id === a), false);
  assert.equal(deleted.dependencies.some((d) => d.fromId === a || d.toId === a), false);
  assert.ok(deleted.deletedPropositionIds?.includes(a));

  // 旧会话按旧标题重新核验（harvest 路径）不会把已删命题带回来。
  const reupsert = upsertProposition(deleted, node("A"));
  assert.equal(reupsert.propositions.some((p) => p.id === a), false);

  // 旧云端/旧备份合并也不会复活。
  const merged = mergeGraphs(deleted, older);
  assert.equal(merged.propositions.some((p) => p.id === a), false);
  assert.equal(merged.dependencies.some((d) => d.fromId === a), false);
  assert.ok(merged.deletedPropositionIds?.includes(a));
});

test("editProposition 重算 id 与 harvest/服务端对齐，旧语句不复活且边重连", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("旧命题"));
  g = upsertProposition(g, node("目标"));
  const oldId = propositionId("旧命题");
  const newId = propositionId("新命题");
  const targetId = propositionId("目标");
  g = addDependency(g, oldId, targetId, 1);
  const older = g;

  const edited = editProposition(g, oldId, { statement: "新命题", topic: "物理" }, 5000);
  assert.equal(edited.propositions.some((p) => p.id === oldId), false);
  const replacement = edited.propositions.find((p) => p.id === newId)!;
  assert.ok(replacement);
  assert.equal(replacement.statement, "新命题");
  assert.equal(replacement.topic, "物理");
  assert.equal(replacement.strength, "understood"); // 证据与强度保留
  assert.equal(replacement.evidence.length, 1);
  assert.ok(edited.deletedPropositionIds?.includes(oldId));
  assert.ok(edited.dependencies.some((d) => d.fromId === newId && d.toId === targetId));

  // 旧会话按旧标题核验、旧副本合并都不能复活旧语句。
  assert.equal(upsertProposition(edited, node("旧命题")).propositions.some((p) => p.id === oldId), false);
  assert.equal(mergeGraphs(edited, older).propositions.some((p) => p.id === oldId), false);
});

test("editProposition 仅空白/标点变化时原地更新，不产生墓碑与 id 替换", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("导数是瞬时变化率"));
  const id = propositionId("导数是瞬时变化率");
  const edited = editProposition(g, id, { statement: "  导数是瞬时变化率。 " }, 5000);
  assert.equal(edited.propositions.length, 1);
  assert.equal(edited.propositions[0].id, id);
  assert.equal(edited.propositions[0].verifiedAt, 5000);
  assert.equal(edited.deletedPropositionIds, undefined);
});

test("editProposition 改成已存在命题时并入证据而不制造重复节点", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("A"));
  g = upsertProposition(g, node("B"));
  const a = propositionId("A");
  const b = propositionId("B");
  const edited = editProposition(g, a, { statement: "B" }, 5000);
  assert.equal(edited.propositions.length, 1);
  assert.equal(edited.propositions.find((p) => p.id === b)!.evidence.length, 2);
  assert.ok(edited.deletedPropositionIds?.includes(a));
});

test("editProposition 改成已删除命题时撤掉旧节点，不复活墓碑节点", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("A"));
  g = upsertProposition(g, node("B"));
  const b = propositionId("B");
  g = deleteProposition(g, b);
  const edited = editProposition(g, propositionId("A"), { statement: "B" }, 5000);
  assert.equal(edited.propositions.some((p) => p.id === b), false);
  assert.ok(edited.deletedPropositionIds?.includes(b));
  assert.equal(edited.propositions.length, 0);
});

test("mergePropositions 合并证据/强度、重连边并给旧 id 记墓碑", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("A"));
  g = upsertProposition(g, { ...node("A2", "applied"), verifiedAt: 2000 });
  g = upsertProposition(g, node("C"));
  const a = propositionId("A");
  const a2 = propositionId("A2");
  const c = propositionId("C");
  g = addDependency(g, a2, c, 1);

  const merged = mergePropositions(g, a, a2, 3000);
  assert.equal(merged.propositions.length, 2);
  const keep = merged.propositions.find((p) => p.id === a)!;
  assert.equal(keep.strength, "applied");
  assert.equal(keep.evidence.length, 2);
  assert.equal(keep.verifiedAt, 3000);
  assert.ok(merged.deletedPropositionIds?.includes(a2));
  assert.ok(merged.dependencies.some((d) => d.fromId === a && d.toId === c));
  assert.equal(merged.dependencies.some((d) => d.fromId === a2), false);
});

test("addDependency 拒绝已删除端点，mergeGraphs 墓碑取双方并集", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("A"));
  g = upsertProposition(g, node("B"));
  const a = propositionId("A");
  const b = propositionId("B");
  const deletedA = deleteProposition(g, a);
  assert.equal(addDependency(deletedA, a, b, 1).dependencies.length, 0);

  const deletedB = deleteProposition(g, b);
  const merged = mergeGraphs(deletedA, deletedB);
  assert.ok(merged.deletedPropositionIds?.includes(a));
  assert.ok(merged.deletedPropositionIds?.includes(b));
  assert.equal(merged.propositions.length, 0);
});

test("编辑后核验时间不低于原值，时钟回拨不会让编辑在 LWW 合并中丢失", () => {
  let g = emptyGraph();
  g = upsertProposition(g, { ...node("A"), verifiedAt: 9000 });
  const edited = editProposition(g, propositionId("A"), { statement: "B" }, 1000);
  assert.equal(edited.propositions.find((p) => p.id === propositionId("B"))!.verifiedAt, 9000);
});

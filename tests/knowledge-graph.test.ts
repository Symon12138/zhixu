import assert from "node:assert/strict";
import test from "node:test";
import {
  addDependency,
  emptyGraph,
  mergeGraphs,
  normalizeStatement,
  propositionId,
  reachable,
  unmetPrerequisites,
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

test("命题 id 由规范化内容稳定生成", () => {
  assert.equal(propositionId("导数是瞬时变化率。"), propositionId("导数是瞬时变化率"));
  assert.equal(propositionId("导数是瞬时变化率"), propositionId("  导数是瞬时变化率  "));
  assert.notEqual(propositionId("导数是瞬时变化率"), propositionId("导数是斜率"));
});

test("upsertProposition 幂等且合并证据与较新核验", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("导数是瞬时变化率"));
  assert.equal(g.propositions.length, 1);
  // 同概念再次沉淀：证据并集、strength 升级、verifiedAt 取较新。
  g = upsertProposition(g, { ...node("导数是瞬时变化率", "applied"), verifiedAt: 2000 });
  assert.equal(g.propositions.length, 1);
  assert.equal(g.propositions[0].strength, "applied");
  assert.equal(g.propositions[0].verifiedAt, 2000);
});

test("addDependency 去重、拒绝自环与成环", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("A"));
  g = upsertProposition(g, node("B"));
  g = upsertProposition(g, node("C"));
  const a = propositionId("A"), b = propositionId("B"), c = propositionId("C");
  g = addDependency(g, a, b, 1);
  g = addDependency(g, a, b, 2); // 重复
  assert.equal(g.dependencies.length, 1);
  g = addDependency(g, a, a, 3); // 自环
  assert.equal(g.dependencies.length, 1);
  g = addDependency(g, b, c, 4);
  g = addDependency(g, c, a, 5); // 成环 c->a，而 a->b->c 已存在
  assert.equal(g.dependencies.length, 2);
  assert.equal(reachable(g, a, c), true);
  assert.equal(reachable(g, c, a), false);
});

test("unmetPrerequisites 返回仅辨认未应用的前置", () => {
  let g = emptyGraph();
  g = upsertProposition(g, node("前置", "understood"));
  g = upsertProposition(g, node("目标", "understood"));
  const pre = propositionId("前置"), goal = propositionId("目标");
  g = addDependency(g, pre, goal, 1);
  assert.equal(unmetPrerequisites(g, goal).length, 1);
  // 前置升级为 applied 后视为满足。
  g = upsertProposition(g, { ...node("前置", "applied"), verifiedAt: 2000 });
  assert.equal(unmetPrerequisites(g, goal).length, 0);
});

test("mergeGraphs 跨设备合并：命题 LWW、依赖并集", () => {
  let a = emptyGraph();
  a = upsertProposition(a, node("A", "understood"));
  let b = emptyGraph();
  b = upsertProposition(b, { ...node("A", "applied"), verifiedAt: 5000 });
  b = upsertProposition(b, node("B"));
  b = addDependency(b, propositionId("A"), propositionId("B"), 1);
  const merged = mergeGraphs(a, b);
  assert.equal(merged.propositions.length, 2);
  const aNode = merged.propositions.find((p) => p.id === propositionId("A"))!;
  assert.equal(aNode.strength, "applied");
  assert.equal(aNode.verifiedAt, 5000);
  assert.equal(merged.dependencies.length, 1);
});

test("normalizeStatement 统一标点与空白", () => {
  assert.equal(normalizeStatement("  你好 世界  。"), "你好 世界");
  assert.equal(normalizeStatement("Hello."), "hello");
});

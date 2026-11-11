import type {
  KnowledgeDependency,
  KnowledgeGraph,
  KnowledgeProposition,
  LearningEvidence,
} from "../types";

/**
 * 知识图谱核心操作（纯函数，可单测）。
 *
 * 设计原则：
 * - 命题 id 由内容规范化生成，同一概念跨会话/设备复用同一节点。
 * - 只沉淀有真实证据的命题；合并用 LWW（verifiedAt 较新者胜），证据取并集。
 * - 依赖边去重（fromId+toId 唯一），不允许自环，检测环避免死循环规划。
 */

/** 命题内容规范化：去空白、统一大小写与标点，作为同概念判定依据。 */
export function normalizeStatement(statement: string): string {
  return statement
    .normalize("NFKC")
    .trim()
    .replace(/[。．.]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 命题 id：内容规范化后的稳定散列（FNV-1a 简化，够用于本地图谱规模）。 */
export function propositionId(statement: string): string {
  const normalized = normalizeStatement(statement);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `kp_${(hash >>> 0).toString(36)}`;
}

/**
 * 主题命名空间命题 id：同一 statement 在不同主题下是不同节点，
 * 避免「同名步骤标题」跨主题被误合并为一个概念。
 */
export function namespacedPropositionId(
  statement: string,
  topic: string,
): string {
  const namespace = normalizeStatement(topic);
  const normalized = normalizeStatement(statement);
  let hash = 0x811c9dc5;
  const combined = `${namespace}\u0000${normalized}`;
  for (let i = 0; i < combined.length; i += 1) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `kp_${(hash >>> 0).toString(36)}`;
}

/** 从会话证据沉淀一个命题节点（幂等：同 id 已存在则合并证据与较新核验）。 */
export function upsertProposition(
  graph: KnowledgeGraph,
  input: {
    /** 显式命题 id（如 namespacedPropositionId 生成值）；缺省按内容散列。 */
    id?: string;
    statement: string;
    topic: string;
    sourceSessionId: string;
    verifiedAt: number;
    strength: KnowledgeProposition["strength"];
    evidence: LearningEvidence[];
  },
): KnowledgeGraph {
  const id = input.id ?? propositionId(input.statement);
  const existing = graph.propositions.find((p) => p.id === id);
  const evidence = dedupeEvidence([...(existing?.evidence ?? []), ...input.evidence]);
  const strength: KnowledgeProposition["strength"] =
    existing?.strength === "applied" || input.strength === "applied" ? "applied" : "understood";
  const verifiedAt = Math.max(existing?.verifiedAt ?? 0, input.verifiedAt);
  const node: KnowledgeProposition = {
    id,
    statement: input.statement,
    topic: input.topic,
    sourceSessionId: existing?.sourceSessionId ?? input.sourceSessionId,
    verifiedAt,
    strength,
    evidence,
  };
  const propositions = existing
    ? graph.propositions.map((p) => (p.id === id ? node : p))
    : [...graph.propositions, node];
  return { propositions, dependencies: graph.dependencies };
}

/** 添加依赖边（去重、拒绝自环与成环）。kind/rule 保留模型标注。 */
export function addDependency(
  graph: KnowledgeGraph,
  fromId: string,
  toId: string,
  createdAt: number,
  extra?: { kind?: KnowledgeDependency["kind"]; rule?: string },
): KnowledgeGraph {
  if (fromId === toId) return graph;
  if (graph.dependencies.some((d) => d.fromId === fromId && d.toId === toId))
    return graph;
  // 拒绝会成环的边：toId 已能到达 fromId 时 fromId->toId 成环。
  if (reachable(graph, toId, fromId)) return graph;
  return {
    propositions: graph.propositions,
    dependencies: [
      ...graph.dependencies,
      {
        fromId,
        toId,
        createdAt,
        ...(extra?.kind ? { kind: extra.kind } : {}),
        ...(extra?.rule ? { rule: extra.rule } : {}),
      },
    ],
  };
}

/** 有向可达性（from 沿依赖能否到达 target）。 */
export function reachable(graph: KnowledgeGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const d of graph.dependencies) {
      if (d.fromId === current) stack.push(d.toId);
    }
  }
  return false;
}

/** 计算命题的未满足前置：toId 依赖的、尚未核验的命题。 */
export function unmetPrerequisites(graph: KnowledgeGraph, toId: string): KnowledgeProposition[] {
  const byId = new Map(graph.propositions.map((p) => [p.id, p]));
  return graph.dependencies
    .filter((d) => d.toId === toId)
    .map((d) => byId.get(d.fromId))
    .filter((p): p is KnowledgeProposition => p !== undefined && p.strength === "understood");
}

/** 合并两个图谱（跨设备/备份导入）：命题按 id LWW，依赖取并集去重。 */
export function mergeGraphs(a: KnowledgeGraph, b: KnowledgeGraph): KnowledgeGraph {
  let propositions = [...a.propositions];
  for (const bNode of b.propositions) {
    const existing = propositions.find((p) => p.id === bNode.id);
    if (!existing) {
      propositions.push(bNode);
      continue;
    }
    const merged: KnowledgeProposition = {
      ...bNode,
      verifiedAt: Math.max(existing.verifiedAt, bNode.verifiedAt),
      strength: existing.strength === "applied" || bNode.strength === "applied" ? "applied" : "understood",
      evidence: dedupeEvidence([...existing.evidence, ...bNode.evidence]),
      sourceSessionId: existing.sourceSessionId,
      topic: bNode.verifiedAt >= existing.verifiedAt ? bNode.topic : existing.topic,
      statement: bNode.verifiedAt >= existing.verifiedAt ? bNode.statement : existing.statement,
    };
    propositions = propositions.map((p) => (p.id === bNode.id ? merged : p));
  }
  const depSeen = new Set(a.dependencies.map((d) => `${d.fromId}→${d.toId}`));
  const dependencies = [...a.dependencies];
  for (const d of b.dependencies) {
    const key = `${d.fromId}→${d.toId}`;
    if (depSeen.has(key)) continue;
    depSeen.add(key);
    dependencies.push(d);
  }
  return { propositions, dependencies };
}

/** 空图谱常量。 */
export function emptyGraph(): KnowledgeGraph {
  return { propositions: [], dependencies: [] };
}

function dedupeEvidence(items: LearningEvidence[]): LearningEvidence[] {
  const seen = new Set<string>();
  const result: LearningEvidence[] = [];
  for (const item of items) {
    const key = `${item.questionId}::${item.turn}::${item.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

import type {
  KnowledgeDependency,
  KnowledgeGraph,
  KnowledgeProposition,
  LearningEvidence,
  Note,
} from "../types";

/**
 * 知识图谱核心操作（纯函数，可单测）。
 *
 * 设计原则：
 * - 命题 id 由内容规范化生成，同一概念跨会话/设备复用同一节点。
 * - 只沉淀有真实证据的命题；合并用 LWW（verifiedAt 较新者胜），证据取并集。
 * - 依赖边去重（fromId+toId 唯一），不允许自环，检测环避免死循环规划。
 * - 显式删除/编辑替换记录 id 墓碑，合并时取并集，旧副本不能复活已删命题。
 */

/** 图谱容量上限：超过后新增被确定性拒绝，提示先清理或导出备份。合并不会丢数据。 */
export const GRAPH_PROPOSITION_LIMIT = 500;
export const GRAPH_DEPENDENCY_LIMIT = 1000;

/** 强度偏序：noted < understood < applied；合并取较高者，避免笔记条目覆盖真实核验。 */
const STRENGTH_RANK: Record<KnowledgeProposition["strength"], number> = {
  noted: 0,
  understood: 1,
  applied: 2,
};

function stronger(
  a: KnowledgeProposition["strength"],
  b: KnowledgeProposition["strength"],
): KnowledgeProposition["strength"] {
  return STRENGTH_RANK[a] >= STRENGTH_RANK[b] ? a : b;
}

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


/** 从会话证据沉淀一个命题节点（幂等：同 id 已存在则合并证据与较新核验）。
 * 已墓碑化的命题不再沉淀：用户显式删除优先于任何旧设备/旧会话的重新核验。 */
export function upsertProposition(
  graph: KnowledgeGraph,
  input: {
    statement: string;
    topic: string;
    sourceSessionId: string;
    verifiedAt: number;
    strength: KnowledgeProposition["strength"];
    evidence: LearningEvidence[];
  },
): KnowledgeGraph {
  const id = propositionId(input.statement);
  if (isTombstoned(graph, id)) return graph;
  const existing = graph.propositions.find((p) => p.id === id);
  // 容量上限：只拒绝新增，既有命题的核验更新仍然生效。
  if (!existing && graph.propositions.length >= GRAPH_PROPOSITION_LIMIT) return graph;
  const evidence = dedupeEvidence([...(existing?.evidence ?? []), ...input.evidence]);
  const strength = stronger(existing?.strength ?? "noted", input.strength);
  const verifiedAt = Math.max(existing?.verifiedAt ?? 0, input.verifiedAt);
  const node: KnowledgeProposition = {
    id,
    statement: input.statement,
    topic: input.topic,
    sourceSessionId: existing?.sourceSessionId ?? input.sourceSessionId,
    verifiedAt,
    strength,
    evidence,
    ...(existing?.sourceNoteId ? { sourceNoteId: existing.sourceNoteId } : {}),
  };
  const propositions = existing
    ? graph.propositions.map((p) => (p.id === id ? node : p))
    : [...graph.propositions, node];
  return withTombstones(graph, { propositions, dependencies: graph.dependencies });
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
  if (isTombstoned(graph, fromId) || isTombstoned(graph, toId)) return graph;
  if (graph.dependencies.some((d) => d.fromId === fromId && d.toId === toId))
    return graph;
  // 容量上限：超限后拒绝新增边，不破坏既有结构。
  if (graph.dependencies.length >= GRAPH_DEPENDENCY_LIMIT) return graph;
  // 拒绝会成环的边：toId 已能到达 fromId 时 fromId->toId 成环。
  if (reachable(graph, toId, fromId)) return graph;
  return withTombstones(graph, {
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
  });
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

/**
 * 新目标的先验探测目标：图谱里“已理解为前置、但尚未应用”的命题。
 * 新目标还没有具体路线节点，无法用 unmetPrerequisites(toId)，因此改选
 * 作为其他命题前置（出边 ≥ 1）且 strength 为 understood 的节点，
 * 按最近核验排序，最多 limit 条（与诊断题上限一致，避免开课前考试化）。
 * understood 说明能解释但还不能独立应用，正是值得先探测的边界；
 * applied 无需再探，未核验的也不能当作已有基础。
 */
export function priorProbeTargets(graph: KnowledgeGraph, limit = 3): KnowledgeProposition[] {
  const gateways = new Set(graph.dependencies.map((dependency) => dependency.fromId));
  const deleted = new Set(graph.deletedPropositionIds ?? []);
  return graph.propositions
    .filter(
      (proposition) =>
        gateways.has(proposition.id) &&
        !deleted.has(proposition.id) &&
        proposition.strength === "understood",
    )
    .sort((a, b) => b.verifiedAt - a.verifiedAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

/**
 * 合并两个图谱（跨设备/备份导入）：命题按 id LWW，依赖取并集去重。
 * 删除墓碑取双方并集，并把任何已墓碑化命题与关联边从结果中剔除；
 * 旧备份/旧云端没有墓碑字段时视为空，本机删除不会被旧副本复活。
 */
export function mergeGraphs(a: KnowledgeGraph, b: KnowledgeGraph): KnowledgeGraph {
  const tombstones = new Set<string>([
    ...(a.deletedPropositionIds ?? []),
    ...(b.deletedPropositionIds ?? []),
  ]);
  let propositions = [...a.propositions.filter((p) => !tombstones.has(p.id))];
  for (const bNode of b.propositions) {
    if (tombstones.has(bNode.id)) continue;
    const existing = propositions.find((p) => p.id === bNode.id);
    if (!existing) {
      propositions.push(bNode);
      continue;
    }
    const merged: KnowledgeProposition = {
      ...bNode,
      verifiedAt: Math.max(existing.verifiedAt, bNode.verifiedAt),
      strength: stronger(existing.strength, bNode.strength),
      evidence: dedupeEvidence([...existing.evidence, ...bNode.evidence]),
      sourceSessionId: existing.sourceSessionId,
      topic: bNode.verifiedAt >= existing.verifiedAt ? bNode.topic : existing.topic,
      statement: bNode.verifiedAt >= existing.verifiedAt ? bNode.statement : existing.statement,
      // 笔记来源任一侧存在就保留，避免同步/备份后失去可追溯性。
      ...((existing.sourceNoteId ?? bNode.sourceNoteId)
        ? { sourceNoteId: existing.sourceNoteId ?? bNode.sourceNoteId }
        : {}),
    };
    propositions = propositions.map((p) => (p.id === bNode.id ? merged : p));
  }
  const depSeen = new Set<string>();
  const dependencies = [...a.dependencies];
  for (const d of dependencies) {
    depSeen.add(`${d.fromId}→${d.toId}`);
  }
  for (const d of [...a.dependencies, ...b.dependencies]) {
    const key = `${d.fromId}→${d.toId}`;
    if (depSeen.has(key)) continue;
    if (tombstones.has(d.fromId) || tombstones.has(d.toId)) continue;
    depSeen.add(key);
    dependencies.push(d);
  }
  // 剔除 a 侧遗留的、指向已删节点的边。
  const cleaned = dependencies.filter(
    (d) => !tombstones.has(d.fromId) && !tombstones.has(d.toId),
  );
  const result: KnowledgeGraph = { propositions, dependencies: cleaned };
  if (tombstones.size > 0) result.deletedPropositionIds = [...tombstones].sort();
  return result;
}

/** 空图谱常量。 */
export function emptyGraph(): KnowledgeGraph {
  return { propositions: [], dependencies: [] };
}

/* ── 用户手动编辑 / 删除 / 去重 / 容量控制 ─────────────────────────── */

function isTombstoned(graph: KnowledgeGraph, id: string): boolean {
  return (graph.deletedPropositionIds ?? []).includes(id);
}

/** 保留已有墓碑；没有墓碑时不写空数组，保持与旧数据形状一致。 */
function withTombstones(graph: KnowledgeGraph, next: KnowledgeGraph): KnowledgeGraph {
  if (graph.deletedPropositionIds && graph.deletedPropositionIds.length > 0) {
    return { ...next, deletedPropositionIds: [...graph.deletedPropositionIds] };
  }
  return next;
}


function stripNode(graph: KnowledgeGraph, id: string): KnowledgeGraph {
  return {
    propositions: graph.propositions.filter((p) => p.id !== id),
    dependencies: graph.dependencies.filter(
      (d) => d.fromId !== id && d.toId !== id,
    ),
    ...(graph.deletedPropositionIds
      ? { deletedPropositionIds: [...graph.deletedPropositionIds] }
      : {}),
  };
}

/** 删除命题：移除节点与关联边，并记录墓碑（跨设备/备份不可复活）。 */
export function deleteProposition(
  graph: KnowledgeGraph,
  id: string,
): KnowledgeGraph {
  const stripped = stripNode(graph, id);
  const tombstones = new Set(stripped.deletedPropositionIds ?? []);
  tombstones.add(id);
  return { ...stripped, deletedPropositionIds: [...tombstones].sort() };
}

/**
 * 编辑命题：按新内容重算 id（与 harvest/服务端 propositionId 对齐），
 * 重连所有边、保留原证据与核验强度；旧 id 记墓碑，
 * 防止旧副本或旧会话按旧步骤标题把编辑前的语句重新沉淀回来。
 */
export function editProposition(
  graph: KnowledgeGraph,
  id: string,
  patch: { statement?: string; topic?: string },
  editedAt: number,
): KnowledgeGraph {
  const target = graph.propositions.find((p) => p.id === id);
  if (!target) return graph;
  const statement = (patch.statement ?? target.statement).trim();
  const topic = (patch.topic ?? target.topic).trim();
  if (!statement) return graph;
  const newId = propositionId(statement);
  if (newId === id) {
    // 仅空白/大小写规范化差异：原地更新，无需替换 id。
    return {
      ...graph,
      propositions: graph.propositions.map((p) =>
        p.id === id ? { ...p, statement, topic, verifiedAt: Math.max(p.verifiedAt, editedAt) } : p,
      ),
    };
  }
  if (graph.propositions.some((p) => p.id === newId)) {
    // 新语句已是既有命题：把证据并入它，避免重复节点与证据丢失。
    return mergePropositions(graph, newId, id, editedAt);
  }
  if (isTombstoned(graph, newId)) {
    // 新语句此前已被删除：撤掉旧节点，不复活已删命题。
    return deleteProposition(graph, id);
  }
  const replacement: KnowledgeProposition = {
    ...target,
    id: newId,
    statement,
    topic,
    verifiedAt: Math.max(target.verifiedAt, editedAt),
  };
  const remap = (edgeId: string) => (edgeId === id ? newId : edgeId);
  const edgeSeen = new Set<string>();
  const dependencies = graph.dependencies
    .map((d) => ({ ...d, fromId: remap(d.fromId), toId: remap(d.toId) }))
    .filter((d) => {
      if (d.fromId === d.toId) return false;
      const key = `${d.fromId}→${d.toId}`;
      if (edgeSeen.has(key)) return false;
      edgeSeen.add(key);
      return true;
    });
  const tombstones = new Set(graph.deletedPropositionIds ?? []);
  tombstones.add(id);
  return {
    propositions: [
      ...graph.propositions.filter((p) => p.id !== id),
      replacement,
    ],
    dependencies,
    deletedPropositionIds: [...tombstones].sort(),
  };
}

/**
 * 合并两个重复命题：保留 keepId 节点，证据取并集、强度取较高者、
 * 核验时间取较新者；mergeId 的边重连到 keepId，mergeId 记墓碑。
 */
export function mergePropositions(
  graph: KnowledgeGraph,
  keepId: string,
  mergeId: string,
  mergedAt: number,
): KnowledgeGraph {
  if (keepId === mergeId) return graph;
  const keep = graph.propositions.find((p) => p.id === keepId);
  const drop = graph.propositions.find((p) => p.id === mergeId);
  if (!keep || !drop) return graph;
  const merged: KnowledgeProposition = {
    ...keep,
    evidence: dedupeEvidence([...keep.evidence, ...drop.evidence]),
    strength: stronger(keep.strength, drop.strength),
    verifiedAt: Math.max(keep.verifiedAt, drop.verifiedAt, mergedAt),
  };
  const remap = (edgeId: string) => (edgeId === mergeId ? keepId : edgeId);
  const edgeSeen = new Set<string>();
  const dependencies = graph.dependencies
    .map((d) => ({ ...d, fromId: remap(d.fromId), toId: remap(d.toId) }))
    .filter((d) => {
      if (d.fromId === d.toId) return false;
      const key = `${d.fromId}→${d.toId}`;
      if (edgeSeen.has(key)) return false;
      edgeSeen.add(key);
      return true;
    });
  const tombstones = new Set(graph.deletedPropositionIds ?? []);
  tombstones.add(mergeId);
  return {
    propositions: graph.propositions
      .filter((p) => p.id !== mergeId)
      .map((p) => (p.id === keepId ? merged : p)),
    dependencies,
    deletedPropositionIds: [...tombstones].sort(),
  };
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

/* ── 笔记导入：确定性候选提取 + 显式确认 + 容量上限 ────────────────── */

/** 单条候选命题的最大字符数；过长段落更适合留作原文而不是命题。 */
const NOTE_STATEMENT_MAX_CHARS = 240;
/** 一次导入最多展示的候选条数，避免长笔记变成一次巨型确认。 */
export const NOTE_CANDIDATE_LIMIT = 12;

/**
 * 从笔记正文确定性提取候选命题：按行与中英文句末标点切分，
 * 去掉项目符号/编号/标题标记，丢掉过短或纯标点的片段，按规范化内容去重。
 * 这里只做文本切分，不做 AI 抽取，也不会自动写入图谱。
 */
export function noteCandidateStatements(note: Note, limit = NOTE_CANDIDATE_LIMIT): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const pieces = note.content
    .replace(/\r\n/g, "\n")
    .split(/[\n。！？!?；;]+/)
    .map((line) => line.replace(/^\s*(?:[-*+>]+|\d+[.)、]|#{1,6}\s*)\s*/, "").trim())
    .filter((line) => line.length >= 6 && line.length <= NOTE_STATEMENT_MAX_CHARS);
  for (const piece of pieces) {
    const key = normalizeStatement(piece);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(piece);
    if (result.length >= Math.max(0, limit)) break;
  }
  return result;
}

/**
 * 把用户确认的笔记语句写入图谱：
 * - 新节点 strength="noted"，只表示“值得跟踪”，不构成理解证据；
 * - 记录 sourceNoteId，便于回看来源笔记；
 * - 已存在或已删除（墓碑）的同内容命题不重复写入、也不复活；
 * - 达到节点上限后停止并报告被拒绝条数，由调用方提示导出/清理。
 */
export function addPropositionsFromNote(
  graph: KnowledgeGraph,
  note: Note,
  statements: readonly string[],
  now: number,
): { graph: KnowledgeGraph; added: number; duplicates: number; rejected: number } {
  const topic = note.title.trim().slice(0, 120) || "笔记";
  // 已删除命题即使残留在数组里也不再参与计数或写回，避免旧副本借导入复活。
  const propositions = graph.propositions.filter((p) => !isTombstoned(graph, p.id));
  const known = new Set(propositions.map((p) => p.id));
  let added = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const raw of statements) {
    const statement = raw.trim();
    if (!statement) continue;
    const id = propositionId(statement);
    if (known.has(id) || isTombstoned(graph, id)) {
      duplicates += 1;
      continue;
    }
    if (propositions.length >= GRAPH_PROPOSITION_LIMIT) {
      rejected += 1;
      continue;
    }
    known.add(id);
    propositions.push({
      id,
      statement: statement.slice(0, NOTE_STATEMENT_MAX_CHARS * 2),
      topic,
      sourceSessionId: note.sessionId,
      sourceNoteId: note.id,
      verifiedAt: now,
      strength: "noted",
      evidence: [],
    });
    added += 1;
  }
  return {
    graph: withTombstones(graph, { propositions, dependencies: graph.dependencies }),
    added,
    duplicates,
    rejected,
  };
}

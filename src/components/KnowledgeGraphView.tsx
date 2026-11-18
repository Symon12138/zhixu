import { useId, useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Clock3,
  GitBranch,
  Layers3,
  Network,
  Pencil,
  Quote,
  Trash2,
} from "lucide-react";
import type {
  KnowledgeGraph,
  KnowledgeProposition,
  Note,
} from "../types";
import { noteCandidateStatements } from "../lib/knowledgeGraph";
import { evidenceKindLabels } from "./LearningProgress";
import "./KnowledgeGraphView.css";

/** 图谱节点尺寸：固定宽高让 SVG 布局可预测，长命题在详情面板完整展示。 */
export const KG_NODE_WIDTH = 176;
export const KG_NODE_HEIGHT = 64;
const KG_COLUMN_GAP = 78;
const KG_ROW_GAP = 18;
const KG_PADDING = 22;

const strengthLabels: Record<KnowledgeProposition["strength"], string> = {
  noted: "待核验",
  understood: "已理解",
  applied: "已应用",
};

const strengthHints: Record<KnowledgeProposition["strength"], string> = {
  noted: "从笔记导入，仅表示值得跟踪，没有理解证据",
  understood: "能复述或辨认",
  applied: "能独立应用或迁移",
};

export interface KnowledgeGraphSessionRef {
  id: string;
  title: string;
}

export interface KnowledgeGraphViewProps {
  /** 跨会话沉淀的命题与依赖；随工作区同步，不在本组件里推导或合并。 */
  graph: KnowledgeGraph;
  /** 本机会话索引，用于把命题的来源会话渲染成可跳回的链接。 */
  sessions?: readonly KnowledgeGraphSessionRef[];
  /** 点击来源会话时跳回学习现场；目标会话已被删除时不触发。 */
  onOpenSession?: (sessionId: string) => void;
  /** 空态下回到学习入口。 */
  onStartLearning?: () => void;
  /** 编辑命题内容/主题；回调负责按新内容重算 id、重连依赖并记录墓碑。 */
  onEditProposition?: (
    id: string,
    patch: { statement: string; topic: string },
  ) => void;
  /** 删除命题；回调负责移除节点、关联边并记录墓碑。 */
  onDeleteProposition?: (id: string) => void;
  /** 把 mergeId 这条重复命题并入 keepId（证据并入、边重连、mergeId 记墓碑）。 */
  onMergePropositions?: (keepId: string, mergeId: string) => void;
  /** 可导入的笔记；省略时不渲染笔记导入入口。 */
  notes?: readonly Note[];
  /** 用户确认后的笔记语句；回调负责写入 noted 节点、容量上限与提示。 */
  onImportFromNote?: (noteId: string, statements: string[]) => void;
}

export interface TopicGroup {
  topic: string;
  propositions: KnowledgeProposition[];
}

export interface KnowledgeGraphLayoutNode {
  proposition: KnowledgeProposition;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface KnowledgeGraphLayoutEdge {
  fromId: string;
  toId: string;
  /** 依赖类型与推理规则（图谱依赖边携带时透传，用于详情展示）。 */
  kind?: "prerequisite" | "derivation";
  rule?: string;
}

export interface KnowledgeGraphLayout {
  nodes: KnowledgeGraphLayoutNode[];
  edges: KnowledgeGraphLayoutEdge[];
  width: number;
  height: number;
  layerCount: number;
}

/**
 * 按主题分组：主题按中文排序，同主题内最近核验的命题在前。
 * 主题为空的旧数据归入「未分类」，不丢节点。
 */
export function groupPropositionsByTopic(
  propositions: readonly KnowledgeProposition[],
): TopicGroup[] {
  const groups = new Map<string, KnowledgeProposition[]>();
  for (const proposition of propositions) {
    const topic = (proposition.topic ?? "").trim() || "未分类";
    const bucket = groups.get(topic);
    if (bucket) bucket.push(proposition);
    else groups.set(topic, [proposition]);
  }
  return [...groups.entries()]
    .map(([topic, items]) => ({
      topic,
      propositions: [...items].sort(comparePropositions),
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic, "zh-Hans-CN"));
}

function comparePropositions(
  a: KnowledgeProposition,
  b: KnowledgeProposition,
): number {
  if (a.verifiedAt !== b.verifiedAt) return b.verifiedAt - a.verifiedAt;
  return a.statement.localeCompare(b.statement, "zh-Hans-CN");
}

/**
 * 拓扑分层：入度为 0 的命题放在第 0 层，其余节点取所有前置的最深一层 + 1。
 * 导入的旧数据若含环，剩余节点统一放到最后一层，保证布局仍可完成。
 */
export function computeKnowledgeGraphLayout(
  graph: KnowledgeGraph,
): KnowledgeGraphLayout {
  if (graph.propositions.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, layerCount: 0 };
  }

  const propositionIds = new Set(graph.propositions.map((p) => p.id));
  const edges: KnowledgeGraphLayoutEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const dependency of graph.dependencies) {
    if (dependency.fromId === dependency.toId) continue;
    if (!propositionIds.has(dependency.fromId)) continue;
    if (!propositionIds.has(dependency.toId)) continue;
    const key = `${dependency.fromId}→${dependency.toId}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      fromId: dependency.fromId,
      toId: dependency.toId,
      ...(dependency.kind ? { kind: dependency.kind } : {}),
      ...(dependency.rule ? { rule: dependency.rule } : {}),
    });
  }

  const indegree = new Map<string, number>();
  const layerById = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const proposition of graph.propositions) {
    indegree.set(proposition.id, 0);
    layerById.set(proposition.id, 0);
  }
  for (const edge of edges) {
    indegree.set(edge.toId, (indegree.get(edge.toId) ?? 0) + 1);
    const targets = outgoing.get(edge.fromId);
    if (targets) targets.push(edge.toId);
    else outgoing.set(edge.fromId, [edge.toId]);
  }

  const queue = graph.propositions
    .filter((proposition) => indegree.get(proposition.id) === 0)
    .map((proposition) => proposition.id);
  const processed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed.add(id);
    const currentLayer = layerById.get(id) ?? 0;
    for (const targetId of outgoing.get(id) ?? []) {
      layerById.set(
        targetId,
        Math.max(layerById.get(targetId) ?? 0, currentLayer + 1),
      );
      const remaining = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, remaining);
      if (remaining === 0) queue.push(targetId);
    }
  }

  const maxLayer = Math.max(0, ...layerById.values());
  const cycleLayer = processed.size > 0 ? maxLayer + 1 : 0;
  for (const proposition of graph.propositions) {
    if (!processed.has(proposition.id)) layerById.set(proposition.id, cycleLayer);
  }

  const layerCount = Math.max(0, ...layerById.values()) + 1;
  const layers: KnowledgeProposition[][] = Array.from(
    { length: layerCount },
    () => [],
  );
  for (const proposition of graph.propositions) {
    layers[layerById.get(proposition.id) ?? 0].push(proposition);
  }
  for (const layer of layers) layer.sort(comparePropositions);

  const maxRows = Math.max(1, ...layers.map((layer) => layer.length));
  const contentHeight =
    maxRows * KG_NODE_HEIGHT + Math.max(0, maxRows - 1) * KG_ROW_GAP;
  const width =
    KG_PADDING * 2 +
    layers.length * KG_NODE_WIDTH +
    Math.max(0, layers.length - 1) * KG_COLUMN_GAP;
  const height = KG_PADDING * 2 + contentHeight;

  const nodes: KnowledgeGraphLayoutNode[] = [];
  layers.forEach((layer, layerIndex) => {
    const columnHeight =
      layer.length * KG_NODE_HEIGHT + Math.max(0, layer.length - 1) * KG_ROW_GAP;
    const top = KG_PADDING + (contentHeight - columnHeight) / 2;
    layer.forEach((proposition, rowIndex) => {
      nodes.push({
        proposition,
        layer: layerIndex,
        x: KG_PADDING + layerIndex * (KG_NODE_WIDTH + KG_COLUMN_GAP),
        y: top + rowIndex * (KG_NODE_HEIGHT + KG_ROW_GAP),
        width: KG_NODE_WIDTH,
        height: KG_NODE_HEIGHT,
      });
    });
  });

  return { nodes, edges, width, height, layerCount };
}

/** 节点内最多两行；完整命题在详情面板展示。 */
export function wrapNodeStatement(statement: string, maxChars = 13): string[] {
  const clean = statement.replace(/\s+/g, " ").trim();
  const characters = Array.from(clean);
  if (characters.length <= maxChars) return [clean];
  const first = characters.slice(0, maxChars).join("");
  const remainder = characters.slice(maxChars);
  const second =
    remainder.length > maxChars
      ? `${remainder.slice(0, maxChars - 1).join("")}…`
      : remainder.join("");
  return [first, second];
}

export function formatVerifiedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "核验时间未知";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "核验时间未知";
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function edgePath(
  from: KnowledgeGraphLayoutNode,
  to: KnowledgeGraphLayoutNode,
): string {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const curve = Math.max(24, Math.abs(endX - startX) * 0.45);
  return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
}

function SourceSessionLink({
  proposition,
  session,
  onOpenSession,
}: {
  proposition: KnowledgeProposition;
  session: KnowledgeGraphSessionRef | undefined;
  onOpenSession?: (sessionId: string) => void;
}) {
  if (!proposition.sourceSessionId) {
    return <span className="kg-session-missing">来源会话未知</span>;
  }
  if (!session) {
    return (
      <span className="kg-session-missing" title={proposition.sourceSessionId}>
        来源会话已不在本机
      </span>
    );
  }
  if (!onOpenSession) {
    return (
      <span className="kg-session-name">
        <BookOpen size={12} aria-hidden="true" />
        {session.title}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="kg-session-link"
      title={`回到来源会话：${session.title}`}
      onClick={() => onOpenSession(session.id)}
    >
      <BookOpen size={12} aria-hidden="true" />
      <span>{session.title}</span>
      <ArrowRight size={12} aria-hidden="true" />
    </button>
  );
}

/** 合并候选：同主题优先，其余按命题文字排序，排除当前节点。 */
export function listMergeCandidates(
  propositions: readonly KnowledgeProposition[],
  selected: KnowledgeProposition,
): KnowledgeProposition[] {
  const topic = selected.topic.trim();
  return propositions
    .filter((proposition) => proposition.id !== selected.id)
    .sort((a, b) => {
      const aSame = a.topic.trim() === topic ? 0 : 1;
      const bSame = b.topic.trim() === topic ? 0 : 1;
      return aSame - bSame || a.statement.localeCompare(b.statement, "zh-Hans-CN");
    });
}

function PropositionEditor({
  proposition,
  onEditProposition,
}: {
  proposition: KnowledgeProposition;
  onEditProposition: NonNullable<KnowledgeGraphViewProps["onEditProposition"]>;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const statement = String(data.get("statement") ?? "").trim();
    if (!statement) return;
    const topic = String(data.get("topic") ?? "").trim();
    onEditProposition(proposition.id, { statement, topic });
    const disclosure = event.currentTarget.closest("details");
    if (disclosure) disclosure.open = false;
  }
  return (
    <form className="kg-edit-form" onSubmit={handleSubmit}>
      <label>
        命题内容
        <textarea
          name="statement"
          defaultValue={proposition.statement}
          rows={3}
          maxLength={240}
          required
        />
      </label>
      <label>
        主题
        <input name="topic" defaultValue={proposition.topic} maxLength={40} />
      </label>
      <div className="kg-edit-actions">
        <button type="submit" className="button primary">
          保存修改
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={(event) => {
            const form = event.currentTarget.closest("form");
            if (form) form.reset();
            const disclosure = form?.closest("details");
            if (disclosure) disclosure.open = false;
          }}
        >
          取消
        </button>
      </div>
    </form>
  );
}

export function KnowledgeGraphView({
  graph,
  sessions = [],
  onOpenSession,
  onStartLearning,
  onEditProposition,
  onDeleteProposition,
  onMergePropositions,
  notes = [],
  onImportFromNote,
}: KnowledgeGraphViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importNoteId, setImportNoteId] = useState<string>("");
  const [importChosen, setImportChosen] = useState<string[]>([]);
  const layout = useMemo(() => computeKnowledgeGraphLayout(graph), [graph]);
  const groups = useMemo(
    () => groupPropositionsByTopic(graph.propositions),
    [graph.propositions],
  );
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session] as const)),
    [sessions],
  );
  const propositionById = useMemo(
    () =>
      new Map(
        graph.propositions.map(
          (proposition) => [proposition.id, proposition] as const,
        ),
      ),
    [graph.propositions],
  );
  const nodeById = useMemo(
    () =>
      new Map(
        layout.nodes.map((node) => [node.proposition.id, node] as const),
      ),
    [layout.nodes],
  );
  const orderedPropositions = useMemo(
    () => groups.flatMap((group) => group.propositions),
    [groups],
  );

  const selected =
    (selectedId ? propositionById.get(selectedId) : undefined) ??
    orderedPropositions[0];
  const canManage = Boolean(
    onEditProposition && onDeleteProposition && onMergePropositions,
  );
  const mergeCandidates = useMemo(
    () =>
      selected
        ? listMergeCandidates(graph.propositions, selected)
        : [],
    [graph.propositions, selected],
  );
  const appliedCount = graph.propositions.filter(
    (proposition) => proposition.strength === "applied",
  ).length;
  const markerId = `kg-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const titleId = `${markerId}-title`;
  const hasDependencies = layout.edges.length > 0;
  const importNote = importNoteId
    ? notes.find((note) => note.id === importNoteId)
    : undefined;
  const importCandidates = useMemo(
    () => (importNote ? noteCandidateStatements(importNote) : []),
    [importNote],
  );
  const importFieldId = `${markerId}-import`;

  const prerequisiteEdges = selected
    ? layout.edges.filter((edge) => edge.toId === selected.id)
    : [];
  const prerequisites = prerequisiteEdges
    .map((edge) => propositionById.get(edge.fromId))
    .filter((item): item is KnowledgeProposition => item !== undefined);
  const prerequisiteEdgeById = new Map(
    prerequisiteEdges.map((edge) => [edge.fromId, edge] as const),
  );
  const unlocks = selected
    ? layout.edges
        .filter((edge) => edge.fromId === selected.id)
        .map((edge) => propositionById.get(edge.toId))
        .filter((item): item is KnowledgeProposition => item !== undefined)
    : [];

  return (
    <div className="collection-page kg-page">
      <header className="collection-heading kg-heading">
        <div>
          <span className="eyebrow">
            <Network size={13} aria-hidden="true" />
            KNOWLEDGE GRAPH
          </span>
          <h1>你学过的概念，正在连成一张网。</h1>
          <p>
            每次核验通过，都会留下一个节点；概念之间的先后关系，会随学习路线逐渐显现。
          </p>
        </div>
        {graph.propositions.length > 0 && (
          <div className="kg-stats" aria-label="图谱概览">
            <span className="kg-stat">
              <strong>{graph.propositions.length}</strong>条命题
            </span>
            <span className="kg-stat">
              <strong>{layout.edges.length}</strong>条依赖
            </span>
            <span className="kg-stat applied">
              <strong>{appliedCount}</strong>条已应用
            </span>
          </div>
        )}
      </header>

      {onImportFromNote && notes.length > 0 && (
        <details className="kg-import">
          <summary>
            <BookOpen size={14} aria-hidden="true" />
            从笔记导入待核验概念
          </summary>
          <p className="kg-import-help">
            只把你确认的句子标记为“待核验”，不会自动算作已理解或已掌握；需要之后再独立核验。
          </p>
          <label htmlFor={importFieldId}>选择笔记</label>
          <select
            id={importFieldId}
            value={importNoteId}
            onChange={(event) => {
              setImportNoteId(event.target.value);
              setImportChosen([]);
            }}
          >
            <option value="">选择一条笔记…</option>
            {notes.map((note) => (
              <option key={note.id} value={note.id}>
                {note.title.trim() || note.content.slice(0, 24)}
              </option>
            ))}
          </select>
          {importNote && (
            importCandidates.length === 0 ? (
              <p className="kg-import-help">这条笔记没有可拆分的短句。</p>
            ) : (
              <>
                <ul className="kg-import-list">
                  {importCandidates.map((statement) => {
                    const checked = importChosen.includes(statement);
                    return (
                      <li key={statement}>
                        <label>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setImportChosen((current) =>
                                checked
                                  ? current.filter((item) => item !== statement)
                                  : [...current, statement],
                              )
                            }
                          />
                          <span>{statement}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <button
                  type="button"
                  className="button secondary"
                  disabled={importChosen.length === 0}
                  onClick={() => {
                    if (!importNote) return;
                    onImportFromNote(importNote.id, importChosen);
                    setImportChosen([]);
                  }}
                >
                  加入图谱（{importChosen.length}）
                </button>
              </>
            )
          )}
        </details>
      )}

      {graph.propositions.length === 0 ? (
        <div className="kg-empty empty-state">
          <div className="empty-illustration">
            <Network size={42} strokeWidth={1.3} aria-hidden="true" />
          </div>
          <h2>知识图谱还在等待第一批概念。</h2>
          <p>
            完成学习并核验通过后，概念会沉淀到这里。
            <br />
            一次核验一个节点，慢慢就能看见概念之间的连接。
          </p>
          {onStartLearning && (
            <button
              type="button"
              className="button secondary"
              onClick={onStartLearning}
            >
              去开始一次学习
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      ) : (
        <div className="kg-layout">
          <div className="kg-main">
            <section className="kg-card" aria-labelledby="kg-map-title">
              <div className="kg-card-head">
                <div>
                  <h2 id="kg-map-title">
                    <GitBranch size={16} aria-hidden="true" />
                    依赖地图
                  </h2>
                  <p>箭头表示「先懂前置，再学后续」。点击节点查看详情与证据。</p>
                </div>
                {hasDependencies && (
                  <span className="kg-map-legend">前置 → 后续</span>
                )}
              </div>
              {hasDependencies ? (
                <div className="kg-graph-scroll">
                  <svg
                    className="kg-graph-svg"
                    width={layout.width}
                    height={layout.height}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    role="group"
                    aria-labelledby={titleId}
                  >
                    <title id={titleId}>
                      {`知识依赖图：${graph.propositions.length} 个命题，${layout.edges.length} 条依赖`}
                    </title>
                    <defs>
                      <marker
                        id={markerId}
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto"
                      >
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="#b6c4a8" />
                      </marker>
                    </defs>
                    {layout.edges.map((edge) => {
                      const from = nodeById.get(edge.fromId);
                      const to = nodeById.get(edge.toId);
                      if (!from || !to) return null;
                      const related =
                        selected !== undefined &&
                        (edge.fromId === selected.id || edge.toId === selected.id);
                      return (
                        <path
                          key={`${edge.fromId}-${edge.toId}`}
                          className={`kg-edge${related ? " is-related" : ""}`}
                          d={edgePath(from, to)}
                          markerEnd={`url(#${markerId})`}
                        >
                          <title>
                            {from.proposition.statement} → {to.proposition.statement}
                          </title>
                        </path>
                      );
                    })}
                    {layout.nodes.map((node) => {
                      const proposition = node.proposition;
                      const isSelected = selected?.id === proposition.id;
                      const [firstLine, secondLine] = wrapNodeStatement(
                        proposition.statement,
                      );
                      return (
                        <g
                          key={proposition.id}
                          className={`kg-node${isSelected ? " is-selected" : ""}`}
                          role="button"
                          tabIndex={0}
                          aria-pressed={isSelected}
                          aria-label={`${proposition.statement}（${strengthLabels[proposition.strength]}）`}
                          onClick={() => setSelectedId(proposition.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedId(proposition.id);
                            }
                          }}
                        >
                          <title>
                            {`${proposition.statement} · ${proposition.topic || "未分类"} · ${
                              strengthLabels[proposition.strength]
                            }`}
                          </title>
                          <rect
                            className="kg-node-box"
                            x={node.x}
                            y={node.y}
                            width={node.width}
                            height={node.height}
                            rx={12}
                          />
                          <rect
                            className={`kg-node-accent ${proposition.strength}`}
                            x={node.x}
                            y={node.y + 11}
                            width={3}
                            height={node.height - 22}
                            rx={1.5}
                          />
                          <text
                            className="kg-node-line"
                            x={node.x + 14}
                            y={node.y + 23}
                          >
                            {firstLine}
                          </text>
                          {secondLine && (
                            <text
                              className="kg-node-line"
                              x={node.x + 14}
                              y={node.y + 39}
                            >
                              {secondLine}
                            </text>
                          )}
                          <text
                            className={`kg-node-strength ${proposition.strength}`}
                            x={node.x + 14}
                            y={node.y + node.height - 8}
                          >
                            {strengthLabels[proposition.strength]}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              ) : (
                <div className="kg-map-empty">
                  <Network size={19} aria-hidden="true" />
                  <p>
                    命题已经沉淀，但还没有标注依赖。继续学习时，导师会在路线里补上概念之间的先后关系。
                  </p>
                </div>
              )}
            </section>

            <section className="kg-card" aria-labelledby="kg-topics-title">
              <div className="kg-card-head">
                <div>
                  <h2 id="kg-topics-title">
                    <Layers3 size={16} aria-hidden="true" />
                    按主题浏览
                  </h2>
                  <p>同一主题下，最近核验的命题排在前面。</p>
                </div>
                <span>
                  {`${groups.length} 个主题 · ${graph.propositions.length} 条命题`}
                </span>
              </div>
              <div className="kg-topics">
                {groups.map((group) => (
                  <div className="kg-topic" key={group.topic}>
                    <div className="kg-topic-head">
                      <span className="kg-topic-dot" aria-hidden="true" />
                      <h3>{group.topic}</h3>
                      <span>{group.propositions.length} 条</span>
                    </div>
                    <div className="kg-prop-grid">
                      {group.propositions.map((proposition) => {
                        const isSelected = selected?.id === proposition.id;
                        const session = sessionById.get(
                          proposition.sourceSessionId,
                        );
                        return (
                          <article
                            key={proposition.id}
                            className={`kg-prop${isSelected ? " is-selected" : ""}`}
                          >
                            <button
                              type="button"
                              className="kg-prop-main"
                              aria-pressed={isSelected}
                              onClick={() => setSelectedId(proposition.id)}
                            >
                              <span className="kg-prop-statement">
                                {proposition.statement}
                              </span>
                              <span className="kg-prop-meta">
                                <span
                                  className={`kg-badge ${proposition.strength}`}
                                >
                                  {strengthLabels[proposition.strength]}
                                </span>
                                <span className="kg-date">
                                  {formatVerifiedAt(proposition.verifiedAt)}
                                </span>
                              </span>
                            </button>
                            <div className="kg-prop-foot">
                              <SourceSessionLink
                                proposition={proposition}
                                session={session}
                                onOpenSession={onOpenSession}
                              />
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="kg-detail" aria-label="命题详情">
            {selected ? (
              <>
                <div className="kg-detail-top">
                  <span className={`kg-badge ${selected.strength}`}>
                    {strengthLabels[selected.strength]}
                  </span>
                  <span
                    className="kg-detail-topic"
                    title={selected.topic || "未分类"}
                  >
                    {selected.topic || "未分类"}
                  </span>
                </div>
                <h2>{selected.statement}</h2>
                <p className="kg-detail-time">
                  <Clock3 size={12} aria-hidden="true" />
                  {`${formatVerifiedAt(selected.verifiedAt)}核验 · ${
                    strengthHints[selected.strength]
                  }`}
                </p>
                <div className="kg-detail-source">
                  <span className="kg-meta-label">来源会话</span>
                  <SourceSessionLink
                    proposition={selected}
                    session={sessionById.get(selected.sourceSessionId)}
                    onOpenSession={onOpenSession}
                  />
                </div>

                {canManage && (
                  <section className="kg-manage">
                    <details className="kg-manage-edit">
                      <summary>
                        <Pencil size={12} aria-hidden="true" />
                        编辑这条命题
                      </summary>
                      <PropositionEditor
                        proposition={selected}
                        onEditProposition={onEditProposition!}
                      />
                    </details>
                    {mergeCandidates.length > 0 && (
                      <form
                        className="kg-merge-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          const keepId = String(data.get("keepId") ?? "");
                          if (!keepId || keepId === selected.id) return;
                          onMergePropositions!(keepId, selected.id);
                        }}
                      >
                        <label htmlFor="kg-merge-target">合并重复命题</label>
                        <select id="kg-merge-target" name="keepId" defaultValue="">
                          <option value="" disabled>
                            选择要保留的命题…
                          </option>
                          {mergeCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.topic || "未分类"} · {candidate.statement}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="button secondary">
                          并入所选命题
                        </button>
                        <small>当前命题的证据与依赖会并入所选命题，当前节点被移除。</small>
                      </form>
                    )}
                    <button
                      type="button"
                      className="text-button kg-delete-button"
                      onClick={() => {
                        if (
                          typeof window === "undefined" ||
                          window.confirm(
                            `删除「${selected.statement}」？该命题与关联依赖会被移除，且不会在旧备份或另一台设备上复活。`,
                          )
                        ) {
                          onDeleteProposition!(selected.id);
                        }
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      删除这条命题
                    </button>
                  </section>
                )}

                <section className="kg-detail-section">
                  <h3>
                    <Quote size={13} aria-hidden="true" />
                    核验证据
                    <span className="kg-detail-count">
                      {selected.evidence.length} 条
                    </span>
                  </h3>
                  {selected.evidence.length > 0 ? (
                    <ul className="kg-evidence">
                      {selected.evidence.map((evidence, index) => (
                        <li key={`${evidence.questionId}-${evidence.turn}-${index}`}>
                          <blockquote>
                            <Quote size={12} aria-hidden="true" />
                            <span>{evidence.quote || "（未保存引文）"}</span>
                          </blockquote>
                          <small>
                            {`${evidenceKindLabels[evidence.kind] ?? "作答"} · 第 ${evidence.turn} 轮${
                              evidence.question ? ` · ${evidence.question}` : ""
                            }`}
                          </small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="kg-detail-empty">
                      这条命题暂未保存证据引文；继续学习并核验后会补充。
                    </p>
                  )}
                </section>

                <section className="kg-detail-section">
                  <h3>
                    <GitBranch size={13} aria-hidden="true" />
                    前置概念
                    <span className="kg-detail-count">{prerequisites.length}</span>
                  </h3>
                  {prerequisites.length > 0 ? (
                    <ul className="kg-related-list">
                      {prerequisites.map((proposition) => {
                        const edge = prerequisiteEdgeById.get(proposition.id);
                        return (
                          <li key={proposition.id}>
                            <button
                              type="button"
                              className="kg-related"
                              onClick={() => setSelectedId(proposition.id)}
                            >
                              <span aria-hidden="true">→</span>
                              <span>{proposition.statement}</span>
                            </button>
                            {edge?.rule && (
                              <small className="kg-related-rule">
                                {edge.kind === "derivation" ? "推导：" : "前置："}
                                {edge.rule}
                              </small>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="kg-detail-empty">暂无标注的前置概念。</p>
                  )}
                </section>

                <section className="kg-detail-section">
                  <h3>
                    <ArrowRight size={13} aria-hidden="true" />
                    解锁的后续
                    <span className="kg-detail-count">{unlocks.length}</span>
                  </h3>
                  {unlocks.length > 0 ? (
                    <ul className="kg-related-list">
                      {unlocks.map((proposition) => (
                        <li key={proposition.id}>
                          <button
                            type="button"
                            className="kg-related"
                            onClick={() => setSelectedId(proposition.id)}
                          >
                            <span aria-hidden="true">→</span>
                            <span>{proposition.statement}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="kg-detail-empty">暂无标注的后续概念。</p>
                  )}
                </section>
              </>
            ) : (
              <p className="kg-detail-empty">点击图谱节点或命题卡片查看详情。</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

export default KnowledgeGraphView;

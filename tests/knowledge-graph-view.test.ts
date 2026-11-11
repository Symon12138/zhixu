import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  KnowledgeGraph,
  KnowledgeProposition,
} from "../src/types";
import type {
  KnowledgeGraphLayout,
  KnowledgeGraphViewProps,
  TopicGroup,
} from "../src/components/KnowledgeGraphView";

/*
 * 组件自身 import 了 CSS，Node 无法直接加载；沿用 app-ux-polish 的 esbuild
 * 方案，把 CSS 置空后加载真实组件与布局纯函数。
 */
interface KnowledgeGraphViewModule {
  KnowledgeGraphView: (props: KnowledgeGraphViewProps) => ReactNode;
  computeKnowledgeGraphLayout: (graph: KnowledgeGraph) => KnowledgeGraphLayout;
  groupPropositionsByTopic: (
    propositions: readonly KnowledgeProposition[],
  ) => TopicGroup[];
  wrapNodeStatement: (statement: string, maxChars?: number) => string[];
  formatVerifiedAt: (timestamp: number) => string;
  KG_NODE_WIDTH: number;
  KG_NODE_HEIGHT: number;
}

let view: KnowledgeGraphViewModule;

test.before(async () => {
  const outfile = join(process.cwd(), `.kg-view-${process.pid}.mjs`);
  try {
    await build({
      entryPoints: ["src/components/KnowledgeGraphView.tsx"],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      external: ["react", "react-dom", "react-dom/*", "lucide-react"],
      loader: {
        ".css": "empty",
        ".woff": "empty",
        ".woff2": "empty",
        ".ttf": "empty",
      },
      logLevel: "silent",
    });
    view = (await import(
      // 构建产物路径在运行时才确定，静态 import 无法引用。
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    )) as typeof view;
  } finally {
    await rm(outfile, { force: true });
  }
});

const VERIFIED_AT = new Date(2026, 0, 15, 9, 30).getTime();

const LIMIT: KnowledgeProposition = {
  id: "kp_limit",
  statement: "极限是导数定义的基础",
  topic: "极限",
  sourceSessionId: "session-calculus",
  verifiedAt: VERIFIED_AT,
  strength: "understood",
  evidence: [],
};

const DERIVATIVE: KnowledgeProposition = {
  id: "kp_derivative",
  statement: "导数是函数在某点的瞬时变化率",
  topic: "微积分",
  sourceSessionId: "session-calculus",
  verifiedAt: VERIFIED_AT + 1000,
  strength: "understood",
  evidence: [
    {
      quote: "导数描述的是这一点附近的变化快慢",
      questionId: "q-derivative",
      question: "如何理解导数的瞬时性？",
      kind: "reasoning",
      turn: 2,
    },
  ],
};

const CHAIN: KnowledgeProposition = {
  id: "kp_chain",
  statement: "链式法则用于复合函数求导",
  topic: "微积分",
  sourceSessionId: "session-chain",
  verifiedAt: VERIFIED_AT + 2000,
  strength: "applied",
  evidence: [],
};

const GRAPH: KnowledgeGraph = {
  propositions: [LIMIT, DERIVATIVE, CHAIN],
  dependencies: [
    { fromId: "kp_limit", toId: "kp_derivative", createdAt: VERIFIED_AT },
    { fromId: "kp_derivative", toId: "kp_chain", createdAt: VERIFIED_AT + 1000 },
    // 重复边与指向缺失节点的边都应在布局里被忽略。
    { fromId: "kp_limit", toId: "kp_derivative", createdAt: VERIFIED_AT + 2000 },
    { fromId: "kp_missing", toId: "kp_chain", createdAt: VERIFIED_AT + 3000 },
  ],
};

const SESSIONS = [
  { id: "session-calculus", title: "微积分入门" },
  { id: "session-chain", title: "链式法则练习" },
];

function render(props: KnowledgeGraphViewProps): string {
  return renderToStaticMarkup(
    createElement(view.KnowledgeGraphView, props),
  );
}

test("空图谱给出沉淀说明与学习入口", () => {
  let started = 0;
  const html = render({
    graph: { propositions: [], dependencies: [] },
    onStartLearning: () => {
      started += 1;
    },
  });

  assert.match(html, /知识图谱还在等待第一批概念/);
  assert.match(html, /完成学习并核验通过后，概念会沉淀到这里/);
  assert.match(html, /去开始一次学习/);
  assert.match(html, /class="kg-empty empty-state"/);
  assert.doesNotMatch(html, /kg-graph-svg/);
  // 空态是说明而不是错误；不渲染“已删除/加载失败”之类误导文案。
  assert.doesNotMatch(html, /加载失败|出错了/);
  assert.equal(started, 0);
});

test("命题按主题分组并展示强度、核验时间与来源会话链接", () => {
  const html = render({
    graph: GRAPH,
    sessions: SESSIONS,
    onOpenSession: () => undefined,
  });

  assert.match(html, /微积分/);
  assert.match(html, /极限/);
  assert.match(html, /导数是函数在某点的瞬时变化率/);
  assert.match(html, /链式法则用于复合函数求导/);
  assert.match(html, /极限是导数定义的基础/);
  assert.match(html, /已理解/);
  assert.match(html, /已应用/);
  assert.match(html, /2026 年 1 月 15 日/);
  assert.match(html, /个主题/);
  assert.match(html, /3<\/strong>条命题/);
  assert.match(html, /微积分入门/);
  assert.match(html, /链式法则练习/);
  assert.match(html, /class="kg-session-link"/);
  assert.match(html, /回到来源会话：微积分入门/);
});

test("依赖图按拓扑分层，忽略重复边与缺失节点", () => {
  const layout = view.computeKnowledgeGraphLayout(GRAPH);
  const layers = new Map(
    layout.nodes.map((node) => [node.proposition.id, node.layer] as const),
  );

  assert.equal(layout.edges.length, 2);
  assert.equal(layers.get("kp_limit"), 0);
  assert.equal(layers.get("kp_derivative"), 1);
  assert.equal(layers.get("kp_chain"), 2);
  assert.equal(layout.layerCount, 3);
  assert.ok(layout.width > view.KG_NODE_WIDTH * 2);
  assert.ok(layout.height >= view.KG_NODE_HEIGHT);
  assert.ok(
    layout.nodes.every(
      (node) =>
        node.width === view.KG_NODE_WIDTH &&
        node.height === view.KG_NODE_HEIGHT,
    ),
  );

  const html = render({ graph: GRAPH, sessions: SESSIONS });
  assert.match(html, /知识依赖图：3 个命题，2 条依赖/);
  assert.match(html, /class="kg-edge(?: is-related)?"/);
  assert.match(html, /class="kg-node/);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  // 全量命题都在图中，包括没有入边的起点与没有出边的终点。
  assert.match(html, /极限是导数定义的基础/);
  assert.match(html, /链式法则用于复合函数求导/);
});

test("依赖边的 kind 与 rule 透传布局并在详情面板展示推理规则", () => {
  // locale 排序下“极限”组排首位，LIMIT 成为 SSR 默认选中节点。
  const NUMBER: KnowledgeProposition = {
    id: "kp_number",
    statement: "实数与数列收敛是极限语言的基础",
    topic: "实数",
    sourceSessionId: "session-calculus",
    verifiedAt: VERIFIED_AT - 1000,
    strength: "understood",
    evidence: [],
  };
  const graph: KnowledgeGraph = {
    propositions: [LIMIT, DERIVATIVE, NUMBER],
    dependencies: [
      {
        fromId: "kp_number",
        toId: "kp_limit",
        createdAt: VERIFIED_AT,
        kind: "derivation",
        rule: "瞬时变化率由割线斜率取极限得到，极限是它的前提",
      },
      {
        fromId: "kp_limit",
        toId: "kp_derivative",
        createdAt: VERIFIED_AT,
      },
    ],
  };
  const layout = view.computeKnowledgeGraphLayout(graph);
  const derivationEdge = layout.edges.find((edge) => edge.fromId === "kp_number");
  assert.equal(derivationEdge?.kind, "derivation");
  assert.equal(derivationEdge?.rule, "瞬时变化率由割线斜率取极限得到，极限是它的前提");

  // 默认选中“极限”组首节点（LIMIT）时，前置区展示推理规则。
  const html = render({ graph, sessions: SESSIONS, onOpenSession: () => undefined });
  assert.match(html, /推导：瞬时变化率由割线斜率取极限得到，极限是它的前提/);
});

test("节点详情展示真实证据，并列出前置与后续", () => {
  const single: KnowledgeGraph = {
    propositions: [DERIVATIVE],
    dependencies: [],
  };
  const html = render({ graph: single, sessions: SESSIONS });

  assert.match(html, /class="kg-detail"/);
  assert.match(html, /导数描述的是这一点附近的变化快慢/);
  assert.match(html, /推理 · 第 2 轮 · 如何理解导数的瞬时性/);
  assert.match(html, /能独立应用或迁移|能复述或辨认/);

  const connected = render({ graph: GRAPH, sessions: SESSIONS });
  assert.match(connected, /前置概念/);
  assert.match(connected, /解锁的后续/);
});

test("没有依赖标注时说明原因，但保留全部命题", () => {
  const html = render({
    graph: { propositions: [LIMIT, DERIVATIVE], dependencies: [] },
    sessions: SESSIONS,
  });

  assert.match(html, /命题已经沉淀，但还没有标注依赖/);
  assert.doesNotMatch(html, /kg-graph-svg/);
  assert.match(html, /极限是导数定义的基础/);
  assert.match(html, /导数是函数在某点的瞬时变化率/);
});

test("主题分组稳定：最近核验在前，空主题归入未分类", () => {
  const groups = view.groupPropositionsByTopic([
    LIMIT,
    DERIVATIVE,
    CHAIN,
    {
      ...LIMIT,
      id: "kp_untitled",
      statement: "未写主题的命题",
      topic: "  ",
      verifiedAt: VERIFIED_AT - 1000,
    },
  ]);

  const calculus = groups.find((group) => group.topic === "微积分");
  assert.ok(calculus);
  assert.deepEqual(
    calculus.propositions.map((item) => item.id),
    ["kp_chain", "kp_derivative"],
  );
  assert.ok(groups.some((group) => group.topic === "未分类"));
  assert.ok(groups.some((group) => group.topic === "极限"));
});

test("含环的旧数据也能完成布局，不会死循环", () => {
  const cyclic: KnowledgeGraph = {
    propositions: [LIMIT, DERIVATIVE, CHAIN],
    dependencies: [
      { fromId: "kp_limit", toId: "kp_derivative", createdAt: 1 },
      { fromId: "kp_derivative", toId: "kp_limit", createdAt: 2 },
    ],
  };
  const layout = view.computeKnowledgeGraphLayout(cyclic);
  assert.equal(layout.nodes.length, 3);
  // 环外节点正常分层；环内节点统一落在最后一层。
  const chain = layout.nodes.find(
    (node) => node.proposition.id === "kp_chain",
  );
  assert.equal(chain?.layer, 0);
  assert.ok(layout.nodes.every((node) => Number.isFinite(node.x + node.y)));
});

test("节点文案两行截断与核验时间格式化保持可读", () => {
  assert.deepEqual(view.wrapNodeStatement("短命题"), ["短命题"]);
  const wrapped = view.wrapNodeStatement("导数是函数在某点的瞬时变化率");
  assert.equal(wrapped.length, 2);
  assert.equal(Array.from(wrapped[0]).length, 13);
  assert.equal(wrapped[1], "率");

  const clipped = view.wrapNodeStatement("一".repeat(40));
  assert.equal(clipped.length, 2);
  assert.ok(clipped[1].endsWith("…"));

  assert.equal(view.formatVerifiedAt(0), "核验时间未知");
  assert.equal(
    view.formatVerifiedAt(VERIFIED_AT),
    "2026 年 1 月 15 日",
  );
});

test("App 注册知识图谱入口、标题与路由，并从本地工作区读取图谱", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /type View = "home" \| "study" \| "notes" \| "review" \| "graph" \| "books"/);
  assert.match(source, /const \{\s*sessions: storedSessions,\s*setSessions,\s*graph,/);
  assert.match(source, /<span>知识图谱<\/span>/);
  assert.match(source, /view === "graph"/);
  assert.match(source, /<KnowledgeGraphView/);
  assert.match(source, /graph=\{graph\}/);
  assert.match(source, /onOpenSession=\{\(sessionId\) => \{/);
  assert.match(source, /openSession\(target\)/);
});

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { harvestSessionPropositions, mergeAnnotatedGraph } from "../src/App";
import type { ChatRequest, LearningState } from "../src/types";
import {
  addDependency,
  emptyGraph,
  propositionId,
  reachable,
  upsertProposition,
} from "../src/lib/knowledgeGraph";
import {
  applyTutorDraft,
  LearningProtocolError,
  type TutorDraft,
} from "../server/learning";
import { runTeachingTurn } from "../server/tutor";
import { openingDraft, passingReview, stateWithQuestion } from "./fixtures";

/*
 * 知识图谱三条链路：
 * 1. 客户端步骤核验通过 -> 沉淀命题（App.tsx 导出纯函数）；
 * 2. 服务端路线规划 -> 依赖标注写入图谱，且防环；
 * 3. 新会话导师上下文包含已掌握命题。
 * App.tsx 直接 import CSS，Node 测试沿用 app-cloud-merge 的 esbuild 方案。
 */
let app: {
  harvestSessionPropositions: typeof harvestSessionPropositions;
  mergeAnnotatedGraph: typeof mergeAnnotatedGraph;
};

test.before(async () => {
  const outfile = join(process.cwd(), `.knowledge-graph-flow-${process.pid}.mjs`);
  try {
    await build({
      entryPoints: ["src/App.tsx"],
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
    app = (await import(
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    )) as unknown as typeof app;
  } finally {
    await rm(outfile, { force: true });
  }
});

const reviewed = { repaired: false, modelCalls: 2 };

function initialRequest(knowledgeGraph?: ChatRequest["knowledgeGraph"]): ChatRequest {
  return {
    topic: "理财净值与交易确认",
    level: "从零开始",
    goal: "能解释资金变化并应用",
    action: "start",
    messages: [{ role: "user", content: "我想理解现金分红与净值。" }],
    ...(knowledgeGraph ? { knowledgeGraph } : {}),
  };
}

function lessonFor(draft: TutorDraft) {
  const { teaching, ...content } = draft;
  const question = teaching?.question;
  return {
    ...content,
    question: question
      ? {
          prompt: question.prompt,
          kind: question.kind,
          options: question.options,
          successCriteria: question.successCriteria,
          protectedAnswers: question.protectedAnswers,
        }
      : null,
    assumptions: teaching?.assumptions ?? [],
  };
}

function stateAfterVerification(): { before: LearningState; after: LearningState } {
  const before = stateWithQuestion();
  const after = structuredClone(before);
  after.steps[0] = {
    ...after.steps[0],
    mastery: "understood",
    evidence: [
      {
        quote: "分红从产品资产转出，所以单位净值下降，累计净值不变。",
        questionId: "q-verified",
        question: "分红后两种净值分别如何变化？",
        kind: "reasoning",
        turn: 3,
      },
    ],
  };
  // 未核验且没有证据的步骤不能沉淀。
  after.steps[1] = { ...after.steps[1], mastery: "understood", evidence: [] };
  return { before, after };
}

test("step 核验通过时沉淀命题：只用真实证据，同概念幂等升级", async () => {
  const { before, after } = stateAfterVerification();
  const session = { id: "session-1", topic: "银行理财业务" };
  const graph = app.harvestSessionPropositions(
    { propositions: [], dependencies: [] },
    session,
    before,
    after,
    1_700_000_000_000,
  );
  assert.equal(graph.propositions.length, 1);
  const proposition = graph.propositions[0];
  assert.equal(proposition.statement, after.steps[0].title);
  assert.equal(proposition.topic, session.topic);
  assert.equal(proposition.sourceSessionId, session.id);
  assert.equal(proposition.strength, "understood");
  assert.deepEqual(proposition.evidence, after.steps[0].evidence);
  assert.equal(proposition.verifiedAt, 1_700_000_000_000);

  // 同一状态重复提交不追加命题、不刷新核验时间。
  const repeated = app.harvestSessionPropositions(
    graph,
    session,
    after,
    after,
    1_700_000_100_000,
  );
  assert.deepEqual(repeated, graph);

  // understood -> applied 是真实升级：强度提升、证据并集、核验时间取较新。
  const upgraded = structuredClone(after);
  upgraded.steps[0] = {
    ...upgraded.steps[0],
    mastery: "applied",
    evidence: [
      ...upgraded.steps[0].evidence,
      {
        quote: "换一个分红比例也能推出同样结论。",
        questionId: "q-transfer",
        question: "若每份分红0.08元，结果如何？",
        kind: "transfer",
        turn: 5,
      },
    ],
  };
  const applied = app.harvestSessionPropositions(
    graph,
    session,
    after,
    upgraded,
    1_700_000_200_000,
  );
  assert.equal(applied.propositions.length, 1);
  assert.equal(applied.propositions[0].strength, "applied");
  assert.equal(applied.propositions[0].verifiedAt, 1_700_000_200_000);
  assert.equal(applied.propositions[0].evidence.length, 2);
});

test("服务端路线依赖标注写入图谱，自环和成环依赖被拒绝", () => {
  const draft = openingDraft();
  const plan = draft.plan!;
  let graph = emptyGraph();
  // 预置一条反向边，验证新依赖不会与本地现有图谱成环。
  graph = addDependency(
    graph,
    propositionId(plan[1]),
    propositionId(plan[0]),
    1,
  );
  const response = applyTutorDraft(
    initialRequest(graph),
    {
      ...draft,
      dependencies: [
        { from: plan[0], to: plan[1] }, // 与预置 B->A 相反，应被拒绝
        { from: plan[1], to: plan[2] }, // 合法
        { from: plan[2], to: plan[2] }, // 自环，应被拒绝
      ],
    },
    reviewed,
  );
  assert.ok(response.knowledgeGraph);
  const dependencies = response.knowledgeGraph.dependencies;
  assert.equal(dependencies.length, 2);
  const has = (from: string, to: string) =>
    dependencies.some(
      (dependency) =>
        dependency.fromId === propositionId(from) &&
        dependency.toId === propositionId(to),
    );
  assert.equal(has(plan[1], plan[0]), true);
  assert.equal(has(plan[1], plan[2]), true);
  assert.equal(has(plan[0], plan[1]), false);
  assert.equal(
    reachable(response.knowledgeGraph, propositionId(plan[0]), propositionId(plan[2])),
    false,
  );

  // 依赖标题必须是 plan 中的精确步骤，模型不能凭空编造概念节点。
  assert.throws(
    () =>
      applyTutorDraft(
        initialRequest(),
        {
          ...draft,
          dependencies: [{ from: "不存在的步骤", to: plan[1] }],
        },
        reviewed,
      ),
    (error: unknown) =>
      error instanceof LearningProtocolError &&
      error.issues.some((issue) => issue.code === "unknown_dependency"),
  );

  // 客户端并入服务端依赖时同样逐条防环，不能靠 mergeGraphs 直接并集制造死循环。
  const clientGraph = addDependency(
    emptyGraph(),
    propositionId(plan[1]),
    propositionId(plan[0]),
    1,
  );
  const merged = app.mergeAnnotatedGraph(clientGraph, {
    propositions: [],
    dependencies: [
      {
        fromId: propositionId(plan[0]),
        toId: propositionId(plan[1]),
        createdAt: 2,
      },
    ],
  });
  assert.equal(merged.dependencies.length, 1);
  assert.equal(
    merged.dependencies.some(
      (dependency) =>
        dependency.fromId === propositionId(plan[0]) &&
        dependency.toId === propositionId(plan[1]),
    ),
    false,
  );
});

test("新会话导师上下文注入已掌握命题，路线依赖随响应返回", async () => {
  const knownStatement = "现金分红会同时降低单位净值与累计净值";
  const graph = upsertProposition(emptyGraph(), {
    statement: knownStatement,
    topic: "银行理财业务",
    sourceSessionId: "earlier-session",
    verifiedAt: 1_000,
    strength: "applied",
    evidence: [
      {
        quote: "分红后单位净值1.05，累计净值1.10。",
        questionId: "earlier-q",
        kind: "transfer",
        turn: 4,
      },
    ],
  });
  const draft = openingDraft();
  const plan = draft.plan!;
  let writerContext = "";
  const response = await runTeachingTurn(initialRequest(graph), async (invocation) => {
    if (invocation.purpose === "draft")
      writerContext = invocation.messages.map((message) => message.content).join("\n");
    if (invocation.purpose === "review") return passingReview;
    return JSON.stringify({
      ...lessonFor(draft),
      dependencies: [
        { from: plan[0], to: plan[1] },
        { from: plan[1], to: plan[0] },
      ],
    });
  });
  assert.ok(writerContext.includes('"knownPropositions"'));
  assert.ok(writerContext.includes(knownStatement));
  assert.ok(writerContext.includes('"strength":"applied"'));
  assert.equal(response.learningState!.steps.length, plan.length);
  assert.ok(response.knowledgeGraph);
  assert.equal(
    response.knowledgeGraph.dependencies.filter(
      (dependency) =>
        dependency.fromId === propositionId(plan[0]) &&
        dependency.toId === propositionId(plan[1]),
    ).length,
    1,
  );
  // 反向边因成环被拒绝，图谱保持可规划。
  assert.equal(
    reachable(response.knowledgeGraph, propositionId(plan[1]), propositionId(plan[0])),
    false,
  );
});

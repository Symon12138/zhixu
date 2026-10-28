import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type {
  attachmentErrorSessionId,
  draftForSessionSwitch,
  resolveStageAnswer,
  selectStageAnswer,
} from "../src/App";
import type { Stage } from "../src/types";

/*
 * App.tsx 直接 import 了 CSS，Node 测试无法直接加载；沿用 app-credential-read
 * 的 esbuild 方案，取本轮产品修复的纯函数做回归，并对续跑接线做源码断言。
 */
let app: {
  attachmentErrorSessionId: typeof attachmentErrorSessionId;
  draftForSessionSwitch: typeof draftForSessionSwitch;
  resolveStageAnswer: typeof resolveStageAnswer;
  selectStageAnswer: typeof selectStageAnswer;
};

test.before(async () => {
  const outfile = join(process.cwd(), `.app-ux-polish-${process.pid}.mjs`);
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
      // 构建产物路径在运行时才确定，静态 import 无法引用。
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    )) as unknown as typeof app;
  } finally {
    await rm(outfile, { force: true });
  }
});

const STAGE: Pick<Stage, "id" | "correctIndex"> = {
  id: "stage-1",
  correctIndex: 1,
};

test("理解检查答对后锁定，旧数据也不会同时显示答对与再想一步", () => {
  const wrong = app.selectStageAnswer(
    { completedStages: [], stageAnswers: {} },
    STAGE,
    0,
  );
  assert.ok(wrong);
  assert.deepEqual(wrong.stageAnswers, { "stage-1": 0 });
  assert.deepEqual(wrong.completedStages, []);

  const correct = app.selectStageAnswer(
    { completedStages: [], stageAnswers: {} },
    STAGE,
    1,
  );
  assert.ok(correct);
  assert.deepEqual(correct.stageAnswers, { "stage-1": 1 });
  assert.deepEqual(correct.completedStages, ["stage-1"]);

  // 已答对后即使再点错误选项，也不再产生新作答。
  assert.equal(
    app.selectStageAnswer(
      { completedStages: ["stage-1"], stageAnswers: { "stage-1": 1 } },
      STAGE,
      0,
    ),
    null,
  );

  // 旧数据“完成但答案被改错”统一按锁定的正确答案展示。
  assert.deepEqual(
    app.resolveStageAnswer(STAGE, {
      completedStages: ["stage-1"],
      stageAnswers: { "stage-1": 0 },
    }),
    { locked: true, selectedIndex: 1, correct: true },
  );
  assert.deepEqual(
    app.resolveStageAnswer(STAGE, {
      completedStages: [],
      stageAnswers: { "stage-1": 0 },
    }),
    { locked: false, selectedIndex: 0, correct: false },
  );
});

test("切换会话丢弃草稿，回到同一会话仍保留", () => {
  assert.equal(app.draftForSessionSwitch("session-a", "session-b", "没发出去"), "");
  assert.equal(app.draftForSessionSwitch("session-a", "session-a", "没发出去"), "没发出去");
  assert.equal(app.draftForSessionSwitch(null, "session-b", "没发出去"), "");
});

test("首页附件错误使用空 sessionId 才会被首页渲染", () => {
  // 首页可能仍保留 activeId，但错误的归属必须是首页而不是旧会话。
  assert.equal(app.attachmentErrorSessionId("home", "session-a"), null);
  assert.equal(app.attachmentErrorSessionId("notes", "session-a"), null);
  assert.equal(app.attachmentErrorSessionId("study", "session-a"), "session-a");
  assert.equal(app.attachmentErrorSessionId("study", null), null);
});

test("保存模型配置后会续跑挂起的诊断与复习补讲", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  // 缺 Key 时诊断挂起而不是只打开设置；保存后按 kind 续跑。
  assert.match(
    source,
    /setPending\(\{ kind: "diagnostic", topic, level: diagLevel, goal: diagGoal \}\)/,
  );
  assert.match(source, /next\.kind === "diagnostic"/);
  assert.match(
    source,
    /startDiagnostic\(\s*next\.topic,\s*next\.level,\s*next\.goal,\s*nextValue,\s*\)/,
  );

  // 复习补讲通过 deferred Promise 把结果还给原卡片；保存后自动继续。
  assert.match(source, /setPending\(\{ kind: "review", item \}\)/);
  assert.match(source, /next\.kind === "review"/);
  assert.match(source, /resumeReviewExplain\(next\.item, nextValue\)/);
  assert.match(
    source,
    /pendingReviewExplainRef\.current = \{ resolve, reject \}/,
  );

  // 关闭设置或保存失败时要取消挂起，避免补讲卡片一直停在加载中。
  assert.match(source, /function cancelPending\(\)/);
  assert.match(source, /deferred\?\.reject\(new Error\("补讲已取消，请重新发起。"\)\)/);
});

test("理解检查已锁定在界面上不可再点选", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /disabled=\{stageAnswer\?\.locked \?\? false\}/);
  assert.match(source, /已答对，选项已锁定，不能再改选/);
  assert.match(
    source,
    /setChatInput\(\(draft\) => draftForSessionSwitch\(activeId, session\.id, draft\)\)/,
  );
  assert.match(
    source,
    /attachmentErrorSessionId\(view, studySession\?\.id \?\? null\)/,
  );
});

test("env 模板与 README 明确区分生产模板和本地最小配置", () => {
  const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const top = env.split("\n").slice(0, 12).join("\n");
  assert.match(top, /这是生产部署模板/);
  assert.match(top, /本地开发/);
  assert.match(top, /GEMINI_API_KEY 或 OPENAI_API_KEY/);

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /本地开发不要复制整份 `\.env\.example`/);
  assert.match(readme, /只需填写 `GEMINI_API_KEY` 或 `OPENAI_API_KEY`/);
  assert.match(readme, /保留网页内个人 Key 输入/);
});

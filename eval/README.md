# 知序评测套件

本目录存放两类评测：**教学回合门禁**（`scripts/eval-teaching.ts`）和**学习效果协议**（outcome harness）。两者都只把程序能独立核验的结果计为通过；模型自述、模拟数据和缺失数据不能过关。

> **CI 绿灯 ≠ 学习效果。** 套件通过只说明固定剧本下程序断言通过，不能证明学习者学得更好，也不能替代真实教学效果研究。

## 快速命令

```bash
# 列出发布门禁用例（不需要密钥，退出码 0）
npm run eval:teaching -- --list

# 运行真实模型门禁（需要 GEMINI_API_KEY 或 OPENAI_API_KEY）
npm run eval:teaching

# 每用例重复 5 次，输出 pass rate、Wilson 95% CI 与 flaky 标记
npm run eval:teaching -- --runs 5

# 跨学科泛化套件（不是发布必需覆盖门禁）
npm run eval:teaching:broad

# 学习效果协议：列出示例（不需要密钥）
npm run eval:teaching -- --outcome --list

# 离线走通 outcome 流程：受控时钟 + simulatedResponses，结果永远 pending，退出码 2
npm run eval:teaching -- --outcome --offline --json

# 真实效果评测：运行学习会话 + 使用 recorded-human 作答
npm run eval:teaching -- --outcome --responses path/to/responses.json
```

退出码：

- `0`：真实模型已运行且全部通过（outcome 模式要求全部指标为 `measured`）。
- `1`：教学失败（结构性断言或门禁结果不达标）。
- `2`：未配置密钥、套件无效、**必需覆盖缺失**、只运行了模拟/缺失数据（不得视为通过）。
- `3`：供应商/网络错误、凭据被拒、回合超时（评测未完成）。

没有真实密钥时脚本会明确输出 `SKIP` / `status: "skipped"` 并退出 `2`；没有真实测试作答时 outcome 指标标 `skipped` 或 `simulated`，同样退出 `2`。

## 教学回合套件 schema

`eval/teaching-suite.json` 与 `eval/teaching-suite-broad.json` 使用 `version: 1`。每个用例可带可选夹具：

| 字段 | 作用 |
| --- | --- |
| `knowledgeGraph` | 跨会话已核验命题与依赖，作为 `knownPropositions` 注入导师上下文，并校验返回的依赖边。 |
| `bookFixture` | 书籍原文段落；程序自行构造生产同构的 `bookContext` + 带定位的 `references`。与 `references` 互斥。 |
| `references` | 固定网页/外部资料（可含 `url`、`verification`、`verifiedQuote`、`sourceTier`）。 |
| `webSearch` | 允许搜索供应商链；`web_claim_matched` 检查需要同时提供带 `url` 的固定 `references`，否则该检查会失败而不是依赖不可复现的实时搜索。 |

新增程序断言：

- `known_proposition_used`：已核验命题必须真正出现在公开讲解或新路线中，而不是注入后被忽略。
- `graph_dependency_returned`：返回的依赖边必须落到本次 `plan` 或图谱命题上，不丢已有边、不自环、不重复、不成环。
- `graph_review_generated`：当前状态中带真实证据的 `understood` 命题必须能通过 `knowledgeGraphReviewItems` 生成可追溯的主动回忆复习项。
- `book_quote_bound`：书籍回合的每条公开引文必须逐字来自本轮同名原文，位置由程序绑定。
- `web_claim_matched`：网页引文必须逐字命中服务端 `verifiedQuote`；`claim_matched` 不能被降级或伪造。

发布套件默认要求覆盖 `REQUIRED_COVERAGE` 中的场景（含 `knowledge_graph_continuity`、`graph_review_generation`、`book_grounding`、`web_grounding`）。缺失时运行直接退出 `2`；`eval/teaching-suite-broad.json` 显式设置 `"requiredCoverage": false`，因为它是泛化补充套件，不是发布必需覆盖门禁。

## 学习效果（outcome）协议

`eval/outcome-suite.example.json` 展示 `mode: "outcome"` 结构。每个用例包含：

1. `preTest`：held-out 前测（题目不得与学习会话逐字相同）。
2. `turns`：真实学习会话，复用教学回合门禁的模型编排与断言。
3. `postTest`：立即后测。
4. `delayedTest`：延迟后测，必须给出 `scheduleAfterMs`；报告记录 `scheduledAt` 与实际完成时间。
5. `transferTest`：新情境迁移题。

各阶段题目 id 与题干必须互不相同，防止把同一道题重复计分。

指标只在数据完整时计算：

- 归一化增益：`g = (post − pre) / (1 − pre)`；前测满分时标 `skipped`（天花板效应）。
- 保持率：`delayed / post`；后测为 0、缺少延迟数据或延迟后测早于 `scheduledAt` 时标 `skipped`。
- 迁移率：`transferTest` 的正确比例。

数据来源：

- `simulatedResponses`（套件内）：只允许 `--offline` 使用，指标标 `simulated` / pending，退出码 `2`。
- `--responses <path>`：必须声明 `"source": "recorded-human"`，并可带 `cohort`、`collectedAt`；只有完整且按计划完成的真实作答才会得到 `measured`。
- 没有作答或缺少任一题：对应指标标 `skipped`，绝不按通过处理。

`--offline` 使用 `--now` 受控时钟（毫秒时间戳或 ISO 日期）走通流程；它证明的是 harness 行为，不是学习效果。

## `--runs` 统计边界

`--runs N`（1–20）只适用于教学回合门禁。报告输出：

- pass rate：实际通过次数 / 实际运行次数；
- Wilson 95% 置信区间（n=0 时不编造区间）；
- 逐用例 `flaky`：同一用例既有通过又有失败/错误时标记。

统计只来自真实运行样本。没有运行、没有密钥或只有模拟数据时不输出“通过率”，不得把局部样本包装成总体教学质量结论。

## 真实对照研究的必要条件

要回答“是否更好帮助学习”，仅靠本目录的套件还不够。真实对照至少需要：

1. **同一题库**：前后测与对照条件使用同一套已校准题目。
2. **随机顺序/随机分组**：学习条件与题目顺序随机化，避免顺序与选择偏差。
3. **盲评**：评分者不知道分组；主观题使用预先注册的评分 rubric。
4. **保留原始作答**：记录 `recorded-human` 作答、时间戳、流失与缺失，不用模拟补齐。
5. **预注册指标与分析**：先定归一化增益、保持率、迁移率与样本量，避免事后挑选显著结果。

本仓库的 `--offline` 模拟只用于验证协议实现。任何对外声明都必须基于真实记录，并注明样本、模型版本、日期与局限。

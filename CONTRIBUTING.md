# 贡献指南

感谢你考虑为知序贡献。

## 开发环境

- Node.js **22.15+**（测试依赖 `module.registerHooks`；应用本身 22.13+ 可运行）
- 安装依赖：`npm ci`
- 启动开发：`npm run dev`（前端 5173，API 3001）
- 本地使用 AI 功能：在「模型与设置」配置 Gemini 或 OpenAI 兼容密钥，或先注册账户后保存个人 Key（BYOK）。不配置模型也能直接使用内置互动课程与导数实验。

## 提交前必跑

```bash
npm run check    # TypeScript 检查
npm test         # 全部回归测试
npm run build    # 生产构建
```

三项都必须通过。新增/修改行为请补对应测试，放在 `tests/`。

## 代码约定

- 服务端权威：评审、配额、凭据、SSRF 防护只在服务端，客户端是投影。
- 跨设备同步：会话字段的合并策略集中在 `src/lib/sessionMerge.ts` 的 `SESSION_MERGE_STRATEGIES` 单点声明。**新增 `StudySession` 字段必须登记合并策略**，映射类型会在编译期强制检查。
- 时间戳：参与 LWW 判断的本地时间写入用 `src/App.tsx` 的 `localNow()`（内部校准时钟），不要直接 `Date.now()`。
- 简单优先：不为推测性需求加抽象层、依赖、配置开关或重试/降级/缓存。

## 安全边界（不要削弱）

- 凭据只用 AES-256-GCM + 用户 AAD 加密存服务端；密钥不进备份、导出、日志。
- 网页抓取只允许公开 HTTPS，固定解析地址防 DNS rebinding。
- Markdown 不启用原始 HTML；KaTeX 不信任 `\href` 等命令。

涉及这些边界的改动请在 PR 中说明理由。

## Pull Request

1. Fork 并新建分支（`feat/...` 或 `fix/...`）。
2. 保持改动聚焦，一个 PR 一件事。
3. 描述清楚：动机、改动点、验证方式（命令 + 结果）。
4. CI（check / test / build）需全绿。

## 报告问题

用 Issue 模板提供：复现步骤、期望行为、实际行为、环境（OS / Node 版本 / 是否配置模型）。不要贴真实 API Key 或个人数据。

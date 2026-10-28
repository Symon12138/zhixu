import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  Layers3,
  Lightbulb,
  LogIn,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { ProviderSettings, ServerConfig, StudySession } from "../types";
import type { Fetcher } from "../lib/cloudSync";
import {
  clearCredentialSettings,
  deleteCredentials,
  hasCredentialSecrets,
  markCredentialSettingsDeleted,
} from "../lib/credentials";
import { Modal } from "./UI";
import { RichText } from "./RichText";

type SessionChange = (changes: Partial<StudySession>) => void;

export function SettingsModal({
  initial,
  config,
  pending,
  canConfigureKeys,
  onSave,
  onClose,
  onLogin,
  fetcher,
  expectedUserId,
  savedCredentials,
  onDeleted,
}: {
  initial: ProviderSettings;
  config: ServerConfig;
  pending: boolean;
  canConfigureKeys: boolean;
  onSave: (value: ProviderSettings) => void;
  onClose: () => void;
  /**
   * 本地未登录且服务端未配置模型密钥时的登录入口。
   * 不提供时（例如公共版已登录）只提示联系管理员，不渲染无法完成的按钮。
   */
  onLogin?: () => void;
  /** 测试或嵌入方可注入同源 fetcher；默认使用浏览器 fetch。 */
  fetcher?: Fetcher;
  /** 当前登录账户；省略时删除前调用 /api/auth/me 获取，避免跨标签页账户切换误删。 */
  expectedUserId?: string;
  /** 服务端是否已有当前账户保存的个人配置；默认按初始值中是否含密钥判断。 */
  savedCredentials?: boolean;
  /** 删除成功后的回调；未提供时通过 onSave 把清空后的配置同步回应用。 */
  onDeleted?: (value: ProviderSettings) => void;
}) {
  const [value, setValue] = useState(initial);
  const [showKey, setShowKey] = useState(false);
  const [showSearchKey, setShowSearchKey] = useState(false);
  const [saved, setSaved] = useState(() => savedCredentials ?? hasCredentialSecrets(initial));
  const [deletingCredentials, setDeletingCredentials] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteNotice, setDeleteNotice] = useState("");
  const [confirmedUserId, setConfirmedUserId] = useState(expectedUserId ?? "");
  const publicManaged = config.authRequired && !config.allowByok;
  const serverManaged = publicManaged || !canConfigureKeys;
  /**
   * 本地未登录（BYOK 可用但尚未登录）且服务端也没有密钥：
   * 此时弹窗里必须给出登录出口，否则用户既填不了密钥也无处可去。
   */
  const loginRequired =
    serverManaged && !publicManaged && !config.configured && !!onLogin;
  const shownProvider = serverManaged ? config.provider : value.provider;
  const shownModel = serverManaged && config.model ? config.model : value.model;
  const modelFallbacks = value.modelFallbacks ?? [];
  const searchFallbacks = value.searchFallbacks ?? [];
  /**
   * 登录后应用会重新打开本弹窗，而账户已保存的个人配置可能稍后才从服务端返回。
   * 用户尚未改动表单时采用新的 initial，避免展示空密钥、保存时误覆盖服务端配置。
   */
  const initialRef = useRef(initial);
  useEffect(() => {
    const previous = initialRef.current;
    initialRef.current = initial;
    setValue((current) => (current === previous ? initial : current));
  }, [initial]);
  useEffect(() => {
    if (expectedUserId || fetcher || !saved || !canConfigureKeys) return;
    let cancelled = false;
    const request: Fetcher = (input, init) => fetch(input, init);
    void request("/api/auth/me", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body: unknown = await response.json().catch(() => undefined);
        const id = body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).id
          : undefined;
        if (!cancelled && typeof id === "string" && id) setConfirmedUserId(id);
      })
      .catch(() => {
        /* 读取失败时删除动作会再次确认，不阻断设置面板。 */
      });
    return () => {
      cancelled = true;
    };
  }, [canConfigureKeys, expectedUserId, fetcher, saved]);
  const deleteSavedCredentials = async () => {
    if (deletingCredentials) return;
    setDeletingCredentials(true);
    setDeleteError("");
    setDeleteNotice("");
    try {
      const request: Fetcher = fetcher ?? ((input, init) => fetch(input, init));
      let userId = expectedUserId || confirmedUserId;
      if (!userId && !fetcher) {
        // 打开面板时未能读取账户（例如网络抖动）：删除前再确认一次当前 Cookie 会话。
        const me = await request("/api/auth/me", {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        const body: unknown = me.ok ? await me.json().catch(() => undefined) : undefined;
        const id = body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).id
          : undefined;
        if (!me.ok || typeof id !== "string" || !id) {
          throw new Error("登录状态已失效，请刷新页面后重试。");
        }
        userId = id;
      }
      await deleteCredentials(request, userId || undefined);
      const cleared = clearCredentialSettings(value);
      // 通知保存流程这是一次已完成的服务端删除，避免后续保存重新创建空凭据行。
      markCredentialSettingsDeleted(cleared);
      setValue(cleared);
      setSaved(false);
      setDeleteNotice("已删除当前账户在服务器保存的个人配置。");
      if (onDeleted) onDeleted(cleared);
      else onSave(cleared);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除个人配置失败，请稍后重试。");
    } finally {
      setDeletingCredentials(false);
    }
  };
  const updateModelFallback = (index: number, changes: Partial<NonNullable<ProviderSettings["modelFallbacks"]>[number]>) => {
    setValue({
      ...value,
      modelFallbacks: modelFallbacks.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
    });
  };
  const updateSearchFallback = (index: number, changes: Partial<NonNullable<ProviderSettings["searchFallbacks"]>[number]>) => {
    setValue({
      ...value,
      searchFallbacks: searchFallbacks.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
    });
  };
  return (
    <Modal
      title="连接你的 AI 导师"
      subtitle={
        publicManaged
          ? "公共版由服务端统一提供模型与密钥。"
          : !canConfigureKeys
            ? "登录后才能配置个人模型与搜索密钥。"
            : "选择模型，让每个问题都有更适合你的讲解。"
      }
      onClose={onClose}
    >
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...value,
            provider: shownProvider,
            apiKey: serverManaged ? "" : value.apiKey.trim(),
            searchApiKey: serverManaged ? "" : (value.searchApiKey ?? "").trim(),
            model: shownModel.trim(),
            baseUrl: value.baseUrl.trim(),
          });
        }}
      >
        {config.configured && (
          <div className="info-box">
            <ShieldCheck size={18} />
            <span>
              {serverManaged
                ? `服务端已配置 ${config.model}，直接发送问题即可使用。`
                : `登录后使用你保存的个人模型 Key；模型 Key 必填，未配置时请求会被明确拒绝，不会回退到服务端密钥。`}
            </span>
          </div>
        )}
        {serverManaged && (
          <div className="info-box">
            <ShieldCheck size={18} />
            <span>
              {publicManaged
                ? "公共版使用服务端统一密钥调用 AI，无需也无法填写个人 API 密钥；这里不提供密钥输入框，避免误输入后泄露。当前模型与接口由管理员配置。"
                : loginRequired
                  ? "登录后才能填写并保存个人模型与搜索 API Key；密钥不会从浏览器持久化保存。"
                  : "登录后才能配置个人模型与搜索 API Key。未登录时仅可使用服务端已配置的能力；密钥不会从浏览器持久化保存。"}
            </span>
          </div>
        )}
        {serverManaged && !config.configured && (
          <div className="error-box" role="status">
            <p>
              {loginRequired
                ? "服务器尚未配置模型密钥，暂时无法调用 AI。本地使用需先登录并配置个人模型密钥；也可以由管理员在服务端配置模型密钥。"
                : "服务器尚未配置模型密钥，暂时无法调用 AI；请联系管理员。"}
            </p>
          </div>
        )}
        <label>
          模型服务
          <select
            value={shownProvider}
            disabled={serverManaged}
            onChange={(e) => {
              const provider = e.target.value as ProviderSettings["provider"];
              setValue({
                ...value,
                provider,
                apiKey: "",
                model: provider === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini",
                // 保留用户填写的自定义接口地址；只有为空时才填入官方默认值。
                baseUrl: value.baseUrl.trim()
                  ? value.baseUrl
                  : "https://api.openai.com/v1",
                structuredOutput: value.structuredOutput,
                thinkingLevel: value.thinkingLevel ?? "auto",
              });
            }}
          >
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI / 兼容接口</option>
          </select>
        </label>
        {serverManaged ? (
          /* 公共版默认只用服务端密钥：不渲染可输入密钥的控件，防止误输入泄露。 */
          null
        ) : (
          <label>
            模型 API 密钥
            <span className="label-optional">必填 · 仅保存到当前账户，不回退服务端 Key</span>
            <div className="password-field">
              <input
                type={showKey ? "text" : "password"}
                value={value.apiKey}
                required
                placeholder={
                  value.provider === "gemini"
                    ? "输入 Gemini API Key"
                    : "输入 API Key"
                }
                autoComplete="off"
                onChange={(e) => setValue({ ...value, apiKey: e.target.value })}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                onClick={() => setShowKey(!showKey)}
              >
                <Eye size={18} />
              </button>
            </div>
            <span className="field-help">
              登录且开启 BYOK 时只使用该账户保存的个人模型 Key；留空或未保存会被拒绝，不会改用服务端共享 Key。
            </span>
          </label>
        )}
        {!serverManaged && (
          <div className="settings-section">
            <h3>搜索 API（仅联网搜索时需要）</h3>
            <label>
              搜索供应商
              <select
                value={value.searchProvider ?? "tavily"}
                onChange={(e) => {
                  const next = e.target.value as NonNullable<ProviderSettings["searchProvider"]>;
                  setValue({
                    ...value,
                    searchProvider: next,
                    searchApiKey: next === value.searchProvider ? value.searchApiKey : "",
                  });
                }}
              >
                <option value="tavily">Tavily</option>
                <option value="brave">Brave Search</option>
                <option value="exa">Exa</option>
                <option value="firecrawl">Firecrawl</option>
                <option value="deepseek">DeepSeek Search</option>
                <option value="you">You.com</option>
              </select>
            </label>
            <label>
              搜索 API 密钥
              <span className="label-optional">
                {value.searchProvider === "you"
                  ? "可留空 · You.com 免费接口"
                  : "仅联网搜索时需要 · 不回退服务端 Key"}
              </span>
              <div className="password-field">
                <input
                  type={showSearchKey ? "text" : "password"}
                  value={value.searchApiKey ?? ""}
                  placeholder={
                    value.searchProvider === "you"
                      ? "可留空使用 You.com 免费接口"
                      : "输入搜索服务 API Key"
                  }
                  autoComplete="off"
                  onChange={(e) => setValue({ ...value, searchApiKey: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={showSearchKey ? "隐藏搜索密钥" : "显示搜索密钥"}
                  onClick={() => setShowSearchKey((shown) => !shown)}
                >
                  <Eye size={18} />
                </button>
              </div>
            </label>
            <span className="field-help">
              不启用联网搜索时无需填写搜索 Key；发起联网搜索但没有可用个人搜索配置时会明确拒绝，不会回退服务端共享 Key。You.com 可留空 Key 使用免费接口，其它供应商留空视为未配置。主搜索密钥、备用搜索配置与 Key 在登录后加密保存到服务端，仅当前账户可读取；清除浏览器数据不会丢失，重新登录后自动恢复。所有搜索密钥只随当前登录用户的请求发送，不进入学习记录、导出或备份。
            </span>
            {searchFallbacks.map((fallback, index) => (
              <div className="fallback-row" key={`search-fallback-${index}`}>
                <label>
                  备用搜索 {index + 1}
                  <select
                    value={fallback.provider}
                    onChange={(event) => {
                      const next = event.target.value as NonNullable<ProviderSettings["searchProvider"]>;
                      updateSearchFallback(index, {
                        provider: next,
                        apiKey: next === fallback.provider ? fallback.apiKey : "",
                      });
                    }}
                  >
                    <option value="tavily">Tavily</option>
                    <option value="brave">Brave Search</option>
                    <option value="exa">Exa</option>
                    <option value="firecrawl">Firecrawl</option>
                    <option value="deepseek">DeepSeek Search</option>
                    <option value="you">You.com</option>
                  </select>
                </label>
                <label>
                  {fallback.provider === "you" ? "API Key（可留空）" : "API Key（留空不生效）"}
                  <input
                    type="password"
                    value={fallback.apiKey ?? ""}
                    placeholder={
                      fallback.provider === "you"
                        ? "You.com 可留空使用免费接口"
                        : "留空则跳过此备用搜索"
                    }
                    autoComplete="off"
                    onChange={(event) => updateSearchFallback(index, { apiKey: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`移除备用搜索 ${index + 1}`}
                  onClick={() => setValue({ ...value, searchFallbacks: searchFallbacks.filter((_, itemIndex) => itemIndex !== index) })}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            {searchFallbacks.length < 5 && (
              <button
                type="button"
                className="text-button"
                onClick={() => setValue({
                  ...value,
                  searchFallbacks: [...searchFallbacks, { provider: "tavily", apiKey: "" }],
                })}
              >
                添加备用搜索供应商
              </button>
            )}
            <span className="field-help">
              备用搜索 Key 留空时不会加入搜索链（You.com 除外，可留空使用免费接口），也不会沿用主搜索 Key。
            </span>
          </div>
        )}
        {shownProvider === "openai" && !serverManaged && (
          <label>
            接口地址
            <input
              type="url"
              required
              value={value.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
            />
            <span className="field-help">
              支持 OpenAI 兼容服务及 localhost 本地模型；填写包含 /v1 的基础地址。官方 https://api.openai.com/v1 始终可用；第三方或 localhost 端点必须由管理员先加入部署变量 ZHIXU_BYOK_BASEURLS，否则保存或请求会被 403 拒绝。
            </span>
          </label>
        )}
        <label>
          模型名称
          <input
            required
            value={shownModel}
            disabled={serverManaged}
            placeholder={
              shownProvider === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini"
            }
            onChange={(e) => setValue({ ...value, model: e.target.value })}
          />
        </label>
        {!serverManaged && (
          <label>
            思考等级
            <select
              value={value.thinkingLevel ?? "auto"}
              onChange={(e) =>
                setValue({
                  ...value,
                  thinkingLevel: e.target.value as NonNullable<ProviderSettings["thinkingLevel"]>,
                })
              }
            >
              <option value="auto">自动（由模型决定）</option>
              <option value="low">低 · 更快</option>
              <option value="medium">中 · 平衡</option>
              <option value="high">高 · 更充分</option>
            </select>
            <span className="field-help">
              Gemini 按已知模型族映射思考等级或预算；OpenAI 兼容服务使用 reasoning_effort。GLM-5.2/5.3 会同时启用 thinking；5.3 不支持中档，5.2 以下不支持指定强度。未知模型或不支持的等级会明确拒绝，不会静默降级。
            </span>
          </label>
        )}
        {!serverManaged && (
          <div className="check-row">
            <input
              id="structured-output"
              type="checkbox"
              checked={value.structuredOutput !== false}
              onChange={(e) =>
                setValue({ ...value, structuredOutput: e.target.checked })
              }
            />
            <div className="check-text">
              <label htmlFor="structured-output">原生 JSON 输出</label>
              <span className="field-help">
                让模型直接返回结构化数据，回复更稳定。遇到不支持该特性的兼容服务报错时，可取消勾选关闭。关闭不会绕过质量检查；使用后端密钥时由服务器 AI_STRUCTURED_OUTPUT 配置。
              </span>
            </div>
          </div>
        )}
        {!serverManaged && (
          <div className="settings-section">
            <h3>备用模型（按顺序故障转移）</h3>
            {modelFallbacks.map((fallback, index) => (
              <div className="fallback-row model-fallback" key={`model-fallback-${index}`}>
                <label>
                  服务
                  <select
                    value={fallback.provider}
                    onChange={(event) => {
                      const provider = event.target.value as ProviderSettings["provider"];
                      updateModelFallback(index, {
                        provider,
                        apiKey: "",
                        baseUrl: fallback.baseUrl.trim()
                          ? fallback.baseUrl
                          : "https://api.openai.com/v1",
                      });
                    }}
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openai">OpenAI / 兼容</option>
                  </select>
                </label>
                <label>
                  模型名称
                  <input
                    value={fallback.model}
                    placeholder={fallback.provider === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini"}
                    onChange={(event) => updateModelFallback(index, { model: event.target.value })}
                  />
                </label>
                <label>
                  接口地址
                  <input
                    type="url"
                    value={fallback.baseUrl}
                    placeholder="https://api.openai.com/v1"
                    onChange={(event) => updateModelFallback(index, { baseUrl: event.target.value })}
                  />
                </label>
                <label>
                  API Key（留空不生效）
                  <input
                    type="password"
                    value={fallback.apiKey ?? ""}
                    placeholder="留空则不使用此备用模型（不继承主 Key）"
                    autoComplete="off"
                    onChange={(event) => updateModelFallback(index, { apiKey: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`移除备用模型 ${index + 1}`}
                  onClick={() => setValue({ ...value, modelFallbacks: modelFallbacks.filter((_, itemIndex) => itemIndex !== index) })}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            {modelFallbacks.length < 2 && (
              <button
                type="button"
                className="text-button"
                onClick={() => setValue({
                  ...value,
                  modelFallbacks: [...modelFallbacks, {
                    provider: "openai",
                    model: "gpt-4o-mini",
                    baseUrl: "https://api.openai.com/v1",
                    apiKey: "",
                  }],
                })}
              >
                添加备用模型
              </button>
            )}
            <span className="field-help">
              主模型遇到认证、额度、接口或连接错误时，按此顺序尝试备用模型；教学质量拒绝或整轮超时不会切换。备用模型 Key 必须单独填写：留空不会继承主模型 Key，也不会改用服务端共享 Key，该备用配置不生效。备用模型的自定义接口地址同样受部署白名单限制：官方 OpenAI 端点始终允许，第三方或 localhost 端点需由管理员加入 ZHIXU_BYOK_BASEURLS。模型与备用配置和 Key 在登录后加密保存到服务端，仅当前账户可读取；清除浏览器数据不会丢失，重新登录后自动恢复。
            </span>
          </div>
        )}
        {!serverManaged && saved && !pending && (
          <div className="settings-section">
            <h3>个人配置</h3>
            <span className="field-help">
              删除后，服务器会移除当前账户保存的模型与搜索配置及全部 Key；本机的非敏感偏好仍会保留。此操作不影响学习记录。
            </span>
            {deleteError && (
              <div className="error-box" role="alert">
                <p>{deleteError}</p>
              </div>
            )}
            {deleteNotice && (
              <div className="info-box" role="status">
                <ShieldCheck size={17} />
                <p>{deleteNotice}</p>
              </div>
            )}
            <div>
              <button
                type="button"
                className="button danger"
                disabled={deletingCredentials}
                onClick={() => void deleteSavedCredentials()}
              >
                {deletingCredentials ? "正在删除…" : "删除已保存的个人配置"}
              </button>
            </div>
          </div>
        )}
        <div className="privacy-note">
          <ShieldCheck size={17} />
          <p>
            {serverManaged
              ? "公共版由服务端使用服务器密钥调用模型，浏览器不保存任何模型密钥。学习内容和上传资料会发送给服务端配置的模型服务；请勿上传敏感信息。"
              : "主模型、主搜索以及备用模型/搜索的配置和 Key 在登录后加密保存到服务端，仅当前账户可读取；清除浏览器数据不会丢失，重新登录后自动恢复。登录后的模型 Key 必填；搜索 Key 仅在发起联网搜索时需要，You.com 可留空使用免费接口。未配置所需个人 Key 会被明确拒绝，不回退到服务端共享 Key。学习内容和上传资料会发送给你选择的模型服务；请勿上传敏感信息。"}
          </p>
        </div>
        <div className="info-box">
          <Sparkles size={17} />
          <p>
            质量优先：每轮通常调用模型两次（生成、独立评审），必要时修订并复检；单模型最多四次，独立评审模型最多六次。会增加耗时和费用；未达门槛的回复不发布，不推进理解状态。流程检查不等于事实认证。
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            暂不连接
          </button>
          {loginRequired ? (
            <button type="button" className="button primary" onClick={onLogin}>
              <LogIn size={16} aria-hidden="true" />
              登录 / 注册
            </button>
          ) : (
            <button className="button primary" type="submit">
              <Sparkles size={16} />
              {pending ? "应用并继续学习" : "应用配置"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function QuizPanel({
  session,
  onChange,
}: {
  session: StudySession;
  onChange: SessionChange;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const questions = session.quiz;
  const answered = questions.filter(
    (q) => session.quizAnswers[q.id] !== undefined,
  ).length;
  const correct = questions.filter(
    (q) => session.quizAnswers[q.id] === q.correctIndex,
  ).length;
  if (!questions.length)
    return (
      <div className="empty-state">
        <CircleHelp size={38} />
        <h2>把理解，变成一次小练习</h2>
        <p>点击下方「生成练习」，AI 会根据当前学习内容出题。</p>
      </div>
    );
  return (
    <section className="quiz-panel">
      <div className="section-intro">
        <span className="eyebrow">CHECK YOUR UNDERSTANDING</span>
        <h2>学懂了，就试试看。</h2>
        <p>不用急着答对。发现不确定的地方，也是学习的一部分。</p>
      </div>
      {session.quizSubmitted && (
        <div className="quiz-result" role="status">
          <div className="result-icon">
            <CheckCircle2 size={28} />
          </div>
          <div>
            <h3>
              {correct === questions.length
                ? "理解得很扎实！"
                : "找到了下一步的方向。"}
            </h3>
            <p>
              本次答对{" "}
              <strong>
                {correct} / {questions.length}
              </strong>{" "}
              题
              {correct !== questions.length
                ? "，看看解析，再把薄弱点学透。"
                : "，试着用自己的话讲给别人听吧。"}
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() => {
              onChange({ quizAnswers: {}, quizSubmitted: false });
              setHint(null);
            }}
          >
            <RotateCcw size={15} />
            重新练习
          </button>
        </div>
      )}
      <div className="quiz-list">
        {questions.map((question, index) => {
          const selected = session.quizAnswers[question.id];
          return (
            <article className="question-card" key={question.id}>
              <div className="question-header">
                <span className="question-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <RichText>{question.question}</RichText>
                </div>
              </div>
              <fieldset
                className="answer-options"
                disabled={session.quizSubmitted}
              >
                <legend className="sr-only">第 {index + 1} 题选项</legend>
                {question.options.map((option, optionIndex) => (
                  <label
                    className={`answer-option ${selected === optionIndex ? "selected" : ""} ${session.quizSubmitted && question.correctIndex === optionIndex ? "correct" : ""} ${session.quizSubmitted && selected === optionIndex && selected !== question.correctIndex ? "incorrect" : ""}`}
                    key={optionIndex}
                  >
                    <input
                      type="radio"
                      name={question.id}
                      checked={selected === optionIndex}
                      onChange={() =>
                        onChange({
                          quizAnswers: {
                            ...session.quizAnswers,
                            [question.id]: optionIndex,
                          },
                        })
                      }
                    />
                    <span className="option-letter">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    <RichText>{option}</RichText>
                    {session.quizSubmitted &&
                      question.correctIndex === optionIndex && (
                        <Check size={18} />
                      )}
                  </label>
                ))}
              </fieldset>
              {!session.quizSubmitted ? (
                <>
                  <button
                    className="text-button hint-toggle"
                    onClick={() =>
                      setHint(hint === question.id ? null : question.id)
                    }
                    aria-expanded={hint === question.id}
                  >
                    <Lightbulb size={15} />
                    {hint === question.id ? "收起提示" : "给我一点提示"}
                  </button>
                  {hint === question.id && (
                    <div className="hint-box">
                      <RichText>{question.hint}</RichText>
                    </div>
                  )}
                </>
              ) : (
                <div
                  className={`answer-explanation ${selected === question.correctIndex ? "is-correct" : ""}`}
                >
                  <strong>
                    {selected === question.correctIndex
                      ? "回答正确"
                      : `正确答案：${String.fromCharCode(65 + question.correctIndex)}`}
                  </strong>
                  <RichText>{question.explanation}</RichText>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!session.quizSubmitted && (
        <div className="quiz-submit">
          <span>
            已完成 {answered} / {questions.length} 题
          </span>
          <button
            className="button primary"
            disabled={answered !== questions.length}
            onClick={() => onChange({ quizSubmitted: true })}
          >
            检查我的理解
            <ArrowRight size={16} />
          </button>
        </div>
      )}
    </section>
  );
}

export function FlashcardPanel({
  session,
  onChange,
}: {
  session: StudySession;
  onChange: SessionChange;
}) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    setIndex(0);
    setFlipped(false);
  }, [session.id, session.flashcards]);
  const card = session.flashcards[index];
  if (!card)
    return (
      <div className="empty-state">
        <Layers3 size={38} />
        <h2>给重要的知识，留一个位置</h2>
        <p>点击下方「生成记忆卡」，将本次学习整理成可复习的卡片。</p>
      </div>
    );
  function move(direction: number) {
    setIndex(
      (index + direction + session.flashcards.length) %
        session.flashcards.length,
    );
    setFlipped(false);
  }
  function markKnown() {
    if (!session.reviewedCards.includes(card.id))
      onChange({ reviewedCards: [...session.reviewedCards, card.id] });
    move(1);
  }
  return (
    <section className="flashcard-panel">
      <div className="section-intro">
        <span className="eyebrow">A LITTLE RECALL GOES A LONG WAY</span>
        <h2>回想一下，比再看一遍更有效。</h2>
        <p>先尝试回答，再翻到背面检查。让知识慢慢留下来。</p>
      </div>
      <div className="flashcard-top">
        <span>
          <Layers3 size={16} />
          知识记忆卡
        </span>
        <span>
          {index + 1} / {session.flashcards.length}
        </span>
      </div>
      <button
        className={`flashcard ${flipped ? "flipped" : ""}`}
        onClick={() => setFlipped(!flipped)}
        aria-label={flipped ? "显示问题" : "翻转查看答案"}
      >
        <span className="flashcard-side">
          {flipped ? "ANSWER · 答案" : "QUESTION · 问题"}
        </span>
        <RichText>{flipped ? card.back : card.front}</RichText>
        <span className="flashcard-footer">
          <RotateCcw size={14} />
          {flipped ? "点击回到问题" : "想好了吗？点击翻面"}
        </span>
      </button>
      <div className="flashcard-nav">
        <button
          className="icon-button"
          aria-label="上一张记忆卡"
          onClick={() => move(-1)}
        >
          <ChevronLeft size={20} />
        </button>
        <div className="card-dots">
          {session.flashcards.map((c, i) => (
            <button
              key={c.id}
              aria-label={`第 ${i + 1} 张记忆卡`}
              aria-current={i === index ? "true" : undefined}
              className={`${i === index ? "active" : ""} ${session.reviewedCards.includes(c.id) ? "known" : ""}`}
              onClick={() => {
                setIndex(i);
                setFlipped(false);
              }}
            />
          ))}
        </div>
        <button
          className="icon-button"
          aria-label="下一张记忆卡"
          onClick={() => move(1)}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      {flipped && (
        <div className="flashcard-actions">
          <button className="button secondary" onClick={() => move(1)}>
            <ArrowLeft size={15} />
            还需巩固
          </button>
          <button className="button primary" onClick={markKnown}>
            <Check size={16} />
            我记住了
          </button>
        </div>
      )}
      <p className="review-progress" role="status">
        {session.reviewedCards.length === session.flashcards.length
          ? "本组知识点已全部回顾。隔一天再来试试，看看能记住多少。"
          : `已记住 ${session.reviewedCards.length} / ${session.flashcards.length} 张，按自己的节奏来。`}
      </p>
    </section>
  );
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal } from "../src/components/StudyTools";
import type { ProviderSettings, ServerConfig } from "../src/types";

const CONFIG: ServerConfig = {
  configured: true,
  provider: "gemini",
  model: "gemini-2.5-flash",
  authRequired: true,
  allowByok: true,
  webFetchEnabled: false,
  webSearchEnabled: false,
  quotas: { chatPerDay: 40, diagnosticPerDay: 10, reviewPerDay: 30 },
};

const SAVED: ProviderSettings = {
  provider: "gemini",
  apiKey: "AIza-saved-secret",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
  searchProvider: "tavily",
  searchApiKey: "tvly-saved-secret",
};

const EMPTY: ProviderSettings = {
  ...SAVED,
  apiKey: "",
  searchApiKey: "",
};

function render(
  initial: ProviderSettings,
  overrides: Partial<Parameters<typeof SettingsModal>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(SettingsModal, {
      initial,
      config: CONFIG,
      pending: false,
      canConfigureKeys: true,
      onSave: () => undefined,
      onClose: () => undefined,
      ...overrides,
    }),
  );
}

test("设置面板仅在已保存个人配置时显示删除按钮", () => {
  assert.match(render(SAVED), /删除已保存的个人配置/);
  assert.doesNotMatch(render(EMPTY), /删除已保存的个人配置/);

  // 服务端已存在配置（即使内存里刚被清空）时仍应给用户删除入口。
  assert.match(render(EMPTY, { savedCredentials: true }), /删除已保存的个人配置/);
  // 明确告知没有已保存配置时，不能凭输入框里的临时内容误显示。
  assert.doesNotMatch(render(SAVED, { savedCredentials: false }), /删除已保存的个人配置/);
});

test("公共版或未登录时不显示删除服务器个人配置的入口", () => {
  assert.doesNotMatch(
    render(SAVED, {
      config: { ...CONFIG, authRequired: true, allowByok: false },
    }),
    /删除已保存的个人配置/,
  );
  assert.doesNotMatch(
    render(SAVED, { canConfigureKeys: false }),
    /删除已保存的个人配置/,
  );
});

const LOCAL_UNCONFIGURED: ServerConfig = {
  ...CONFIG,
  configured: false,
  model: "",
  authRequired: false,
};

test("本地未登录且服务端无密钥时给出登录出口", () => {
  const html = render(EMPTY, {
    config: LOCAL_UNCONFIGURED,
    canConfigureKeys: false,
    onLogin: () => undefined,
  });
  assert.match(html, /服务器尚未配置模型密钥/);
  assert.match(html, /本地使用需先登录并配置个人模型密钥/);
  assert.match(html, /登录 \/ 注册/);
  // “应用配置”在此状态下只会提示使用服务器模型并再次弹回，必须让位给登录动作。
  assert.doesNotMatch(html, /应用配置/);
});

test("已登录或公共版不渲染登录出口", () => {
  // 已登录：可以填写个人密钥，不再提示登录。
  const signedIn = render(EMPTY, {
    config: LOCAL_UNCONFIGURED,
    canConfigureKeys: true,
    onLogin: () => undefined,
  });
  assert.doesNotMatch(signedIn, /登录 \/ 注册/);
  assert.match(signedIn, /模型 API 密钥/);

  // 公共版未开启 BYOK 且服务端无密钥：登录也无法配置个人密钥，只提示管理员。
  const publicHtml = render(EMPTY, {
    config: { ...CONFIG, configured: false, model: "", allowByok: false },
    canConfigureKeys: false,
    onLogin: () => undefined,
  });
  assert.doesNotMatch(publicHtml, /登录 \/ 注册/);
  assert.match(publicHtml, /请联系管理员/);

  // 调用方没有提供登录入口时保持原提示，不渲染点了没反应的按钮。
  const noHandler = render(EMPTY, {
    config: LOCAL_UNCONFIGURED,
    canConfigureKeys: false,
  });
  assert.doesNotMatch(noHandler, /登录 \/ 注册/);
  assert.match(noHandler, /请联系管理员/);
});

test("设置弹窗的登录出口打开账户面板，登录成功后回到配置流程", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /canConfigureKeys=\{canUsePersonalKeys\}\s*onLogin=\{/);
  assert.match(
    app,
    /allowByok && !authUser[\s\S]{0,240}setResumeSettingsAfterLogin\(true\)[\s\S]{0,120}setSettingsOpen\(false\)[\s\S]{0,80}setAccountOpen\(true\)/,
  );
  assert.match(
    app,
    /onLoginSuccess=\{\(user, result\) => \{[\s\S]{0,400}resumeSettingsAfterLogin[\s\S]{0,320}setSettingsOpen\(true\)/,
  );
  // 去登录时不能清掉 pending，否则登录并配置后不会继续原提问。
  assert.doesNotMatch(
    app,
    /setResumeSettingsAfterLogin\(true\)[\s\S]{0,160}setPending\(null\)/,
  );
});

test("删除按钮处理器调用 deleteCredentials 并清空本地密钥字段", () => {
  const source = readFileSync(new URL("../src/components/StudyTools.tsx", import.meta.url), "utf8");
  assert.match(source, /import[\s\S]*deleteCredentials[\s\S]*from "\.\.\/lib\/credentials"/);
  assert.match(source, /await deleteCredentials\(request, userId \|\| undefined\)/);
  assert.match(source, /const cleared = clearCredentialSettings\(value\)/);
  assert.match(source, /setValue\(cleared\)/);
  assert.match(source, /else onSave\(cleared\)/);
  assert.match(source, /onClick=\{\(\) => void deleteSavedCredentials\(\)\}/);
});

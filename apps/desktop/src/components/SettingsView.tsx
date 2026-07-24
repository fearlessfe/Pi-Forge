import * as Select from "@radix-ui/react-select";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  LogIn,
  LogOut,
  LockKeyhole,
  Palette,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ModelSettings,
  ProviderCatalogEntry,
  ProviderId,
  SaveModelSettings,
  ThinkingLevel,
} from "../contracts";
import type { SettingsSection, Theme } from "../types";
import type { AuthFlowState } from "../types";

type SettingsViewProps = {
  activeSection: SettingsSection;
  settings: ModelSettings;
  providerCatalog: ProviderCatalogEntry[];
  authFlow: AuthFlowState | null;
  theme: Theme;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onThemeChange: (theme: Theme) => void;
  onSave: (settings: SaveModelSettings) => Promise<void>;
  onTest: (settings: SaveModelSettings) => Promise<void>;
  onLogin: (providerId: ProviderId) => Promise<void>;
  onAnswerAuthPrompt: (requestId: string, value: string) => Promise<void>;
  onCancelAuth: (loginId: string) => Promise<void>;
  onLogout: (providerId: ProviderId) => Promise<void>;
  onDismissAuth: () => void;
};

const sections: Array<{
  group: string;
  items: Array<{ id: SettingsSection; label: string; icon: typeof Sparkles }>;
}> = [
  { group: "AI", items: [{ id: "models", label: "大模型", icon: Sparkles }, { id: "permissions", label: "权限", icon: LockKeyhole }] },
  { group: "应用", items: [{ id: "general", label: "通用", icon: Settings2 }, { id: "appearance", label: "外观", icon: Palette }] },
];

function editableSettings(settings: ModelSettings): SaveModelSettings {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    modelId: settings.modelId,
    thinkingLevel: settings.thinkingLevel,
    apiKey: "",
  };
}

function SettingsNavigation({ activeSection, onBack, onSectionChange }: Pick<SettingsViewProps, "activeSection" | "onBack" | "onSectionChange">) {
  return (
    <aside className="settings-sidebar">
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft size={15} /><span>返回对话</span></button>
      <h1>设置</h1>
      {sections.map((section) => (
        <div className="settings-nav-group" key={section.group}>
          <span>{section.group}</span>
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <button className={`settings-nav-item ${activeSection === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => onSectionChange(item.id)}>
                <Icon size={16} />{item.label}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

function ProviderSelect({
  value,
  providers,
  onChange,
}: {
  value: ProviderId;
  providers: ProviderCatalogEntry[];
  onChange: (provider: ProviderId) => void;
}) {
  const builtinProviders = providers.filter((provider) => provider.kind === "builtin");
  const compatibleProviders = providers.filter((provider) => provider.kind === "compatible");
  const renderProvider = (provider: ProviderCatalogEntry) => (
    <Select.Item className="select-item" value={provider.id} key={provider.id}>
      <Select.ItemText>{provider.name}</Select.ItemText>
      <Select.ItemIndicator><Check size={13} /></Select.ItemIndicator>
    </Select.Item>
  );
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as ProviderId)}>
      <Select.Trigger className="select-trigger" aria-label="模型提供商"><Select.Value /><Select.Icon><ChevronDown size={14} /></Select.Icon></Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            {builtinProviders.length > 0 && (
              <Select.Group>
                <Select.Label className="select-label">Pi 内置 Provider</Select.Label>
                {builtinProviders.map(renderProvider)}
              </Select.Group>
            )}
            {compatibleProviders.length > 0 && <Select.Separator className="select-separator" />}
            {compatibleProviders.length > 0 && (
              <Select.Group>
                <Select.Label className="select-label">自定义兼容端点</Select.Label>
                {compatibleProviders.map(renderProvider)}
              </Select.Group>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function ModelsPanel({
  settings,
  providerCatalog,
  authFlow,
  onSave,
  onTest,
  onLogin,
  onAnswerAuthPrompt,
  onCancelAuth,
  onLogout,
  onDismissAuth,
}: Pick<SettingsViewProps, "settings" | "providerCatalog" | "authFlow" | "onSave" | "onTest" | "onLogin" | "onAnswerAuthPrompt" | "onCancelAuth" | "onLogout" | "onDismissAuth">) {
  const [form, setForm] = useState<SaveModelSettings>(() => editableSettings(settings));
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authAnswer, setAuthAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(editableSettings(settings)), [settings]);
  const provider = useMemo(
    () => providerCatalog.find((entry) => entry.id === form.provider),
    [form.provider, providerCatalog],
  );
  const presets = useMemo(() => {
    if (!provider) return [];
    const selected = provider.models.find((model) => model.id === form.modelId);
    const leading = provider.models.slice(0, 6);
    return selected && !leading.some((model) => model.id === selected.id) ? [selected, ...leading.slice(0, 5)] : leading;
  }, [form.modelId, provider]);
  const providerName = provider?.name ?? form.provider;
  const credential = settings.credentials.find((entry) => entry.providerId === form.provider);
  const providerHasApiKey = credential?.type === "api_key";
  const providerHasOAuth = credential?.type === "oauth";
  const needsOAuth = Boolean(provider?.supportsOAuth && !provider.supportsApiKey);
  const activeAuth = authFlow?.providerId === form.provider ? authFlow : null;

  useEffect(() => setAuthAnswer(""), [activeAuth?.prompt?.requestId]);

  function update<K extends keyof SaveModelSettings>(key: K, value: SaveModelSettings[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeProvider(provider: ProviderId) {
    const next = providerCatalog.find((entry) => entry.id === provider);
    setForm((current) => ({
      ...current,
      provider,
      baseUrl: next?.baseUrl ?? "",
      modelId: next?.models[0]?.id ?? "",
      apiKey: "",
    }));
  }

  async function run(action: "save" | "test") {
    setBusy(action);
    setError(null);
    try {
      if (action === "save") await onSave(form);
      else await onTest(form);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      setBusy(null);
    }
  }

  async function runAuth(action: () => Promise<void>) {
    setAuthBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <header className="settings-page-header">
        <div><h2>大模型</h2><p>真实配置 Pi Coding Agent 使用的提供商、端点、密钥与 thinking 级别。</p></div>
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("save")}>{busy === "save" ? "保存中…" : "保存设置"}</button>
      </header>

      <section className="provider-card">
        <header className="provider-heading">
          <span className="provider-logo">{providerName[0]}</span>
          <span><strong>{providerName}</strong><small>{provider?.kind === "compatible" ? "自定义兼容端点" : `Pi 内置 Provider · ${provider?.models.length ?? 0} 个模型`}</small></span>
          <span className={`connection-status ${credential ? "" : "is-idle"}`}><i />{providerHasOAuth ? "OAuth 已登录" : providerHasApiKey ? "API Key 已配置" : needsOAuth ? "需要 OAuth 登录" : "等待配置"}</span>
        </header>

        <div className="settings-form-grid">
          <label className="settings-field"><span>提供商</span><ProviderSelect value={form.provider} providers={providerCatalog} onChange={changeProvider} /></label>
          <label className="settings-field"><span>API 地址{provider?.kind === "builtin" ? "（可选覆盖）" : ""}</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} spellCheck={false} placeholder={provider?.baseUrl || "使用 Provider 的环境配置"} /></label>
          <label className="settings-field"><span>模型 ID</span><input list="pi-model-catalog" value={form.modelId} onChange={(event) => update("modelId", event.target.value)} spellCheck={false} placeholder="输入或选择模型 ID" /><datalist id="pi-model-catalog">{provider?.models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</datalist></label>
          <label className="settings-field">
            <span>Thinking 级别</span>
            <select className="native-select" value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value as ThinkingLevel)}>
              <option value="off">关闭</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option>
            </select>
          </label>
          <label className="settings-field settings-field--full">
            <span>API Key</span>
            <div className="secret-input"><KeyRound size={14} /><input type="password" disabled={needsOAuth} value={form.apiKey ?? ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={providerHasApiKey ? "已安全保存；留空则保持不变" : providerHasOAuth ? "当前使用 OAuth；输入 Key 并保存可切换" : needsOAuth ? "该 Provider 仅支持 OAuth" : provider?.kind === "compatible" ? "本地端点可留空；远程端点需要 Key" : "输入 API Key，或使用环境凭据"} /><small>{providerHasApiKey ? "系统加密存储" : providerHasOAuth ? "当前使用 OAuth" : needsOAuth ? "请登录" : "未保存"}</small></div>
            <em>API Key 与 OAuth Token 均由操作系统安全存储加密；Renderer 只能看到认证类型，无法读取凭据明文。</em>
          </label>
        </div>
      </section>

      {provider?.supportsOAuth && (
        <section className="oauth-card">
          <header>
            <span className="oauth-icon"><LogIn size={16} /></span>
            <span><strong>订阅账号登录</strong><small>{provider.oauthName ?? `${providerName} OAuth`}</small></span>
            {providerHasOAuth ? (
              <button className="secondary-button" type="button" disabled={authBusy || Boolean(activeAuth)} onClick={() => void runAuth(() => onLogout(form.provider))}><LogOut size={13} />退出登录</button>
            ) : (
              <button className="secondary-button" type="button" disabled={authBusy || Boolean(activeAuth)} onClick={() => void runAuth(() => onLogin(form.provider))}><ExternalLink size={13} />使用浏览器登录</button>
            )}
          </header>

          {activeAuth && (
            <div className={`oauth-flow ${activeAuth.status === "error" ? "is-error" : ""}`}>
              {activeAuth.message && <p>{activeAuth.message}</p>}
              {activeAuth.url && <code>{activeAuth.url}</code>}
              {activeAuth.deviceCode && (
                <div className="oauth-device-code">
                  <span>设备码</span><strong>{activeAuth.deviceCode.userCode}</strong>
                  <small>{activeAuth.deviceCode.verificationUri}</small>
                </div>
              )}
              {activeAuth.prompt?.promptType === "select" && (
                <div className="oauth-options">
                  {activeAuth.prompt.options?.map((option) => (
                    <button type="button" key={option.id} onClick={() => void runAuth(() => onAnswerAuthPrompt(activeAuth.prompt!.requestId, option.id))}>
                      <strong>{option.label}</strong>{option.description && <small>{option.description}</small>}
                    </button>
                  ))}
                </div>
              )}
              {activeAuth.prompt && activeAuth.prompt.promptType !== "select" && (
                <form className="oauth-prompt" onSubmit={(event) => { event.preventDefault(); void runAuth(() => onAnswerAuthPrompt(activeAuth.prompt!.requestId, authAnswer)); }}>
                  <label>{activeAuth.prompt.message}</label>
                  <div><input type={activeAuth.prompt.promptType === "secret" ? "password" : "text"} value={authAnswer} onChange={(event) => setAuthAnswer(event.target.value)} placeholder={activeAuth.prompt.placeholder} autoFocus /><button className="primary-button" type="submit" disabled={activeAuth.prompt.promptType !== "text" && !authAnswer.trim()}>继续</button></div>
                </form>
              )}
              <footer>
                {activeAuth.status === "running" ? <button type="button" onClick={() => void onCancelAuth(activeAuth.loginId)}>取消登录</button> : <button type="button" onClick={onDismissAuth}>关闭</button>}
              </footer>
            </div>
          )}
        </section>
      )}

      {presets.length > 0 && (
        <section className="default-model-section">
          <header><strong>模型预设</strong><small>也可以直接输入其他模型 ID</small></header>
          <div className="model-card-grid">
            {presets.map((model) => (
              <button className={`model-card ${model.id === form.modelId ? "is-selected" : ""}`} key={model.id} type="button" onClick={() => update("modelId", model.id)}>
                {model.id === form.modelId && <span className="model-check"><Check size={11} /></span>}
                <strong>{model.id}</strong><p>{model.name === model.id ? (model.reasoning ? "支持推理的 Pi SDK 模型。" : "Pi SDK 内置模型。") : model.name}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {error && <div className="settings-error" role="alert">{error}</div>}
      <footer className="settings-panel-footer">
        <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("test")}>{busy === "test" ? "正在调用模型…" : "验证连接"}</button>
        <span>验证会真实发送一条最小请求</span><small>密钥不会出现在日志中</small>
      </footer>
    </div>
  );
}

function PermissionsPanel() {
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>权限</h2><p>当前 Agent 的敏感工具策略。</p></div></header>
      <section className="simple-settings-card">
        <div className="settings-toggle-row"><span><strong>Shell 命令</strong><small>执行 bash 前展示参数并等待本次授权</small></span><span className="policy-badge">始终询问</span></div>
        <div className="settings-toggle-row"><span><strong>文件修改</strong><small>edit 与 write 每次执行前询问</small></span><span className="policy-badge">始终询问</span></div>
        <div className="settings-toggle-row"><span><strong>只读工具</strong><small>read、grep、find、ls 可在所选工作目录运行</small></span><span className="policy-badge policy-badge--allowed">自动允许</span></div>
      </section>
    </div>
  );
}

function GeneralPanel() {
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>通用</h2><p>调整 Pi Desktop 的会话和系统行为。</p></div></header>
      <section className="simple-settings-card">
        <div className="settings-toggle-row"><span><strong>流式过程</strong><small>实时显示 thinking、文本增量和工具状态</small></span><button className="switch is-on" type="button" aria-label="启用流式过程"><i /></button></div>
        <div className="settings-toggle-row"><span><strong>工作区上下文</strong><small>加载项目 AGENTS.md、skills 与 Pi extensions</small></span><button className="switch is-on" type="button" aria-label="启用工作区上下文"><i /></button></div>
      </section>
    </div>
  );
}

function AppearancePanel({ theme, onThemeChange }: Pick<SettingsViewProps, "theme" | "onThemeChange">) {
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>外观</h2><p>选择适合当前环境的界面主题。</p></div></header>
      <section className="theme-card-grid">
        {(["dark", "light"] as const).map((item) => (
          <button className={`theme-card ${theme === item ? "is-selected" : ""}`} key={item} type="button" onClick={() => onThemeChange(item)}>
            <span className={`theme-preview theme-preview--${item}`}><i /><b><em /><em /><em /></b></span>
            <span>{item === "dark" ? "深色" : "浅色"}{theme === item && <Check size={14} />}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

export function SettingsView(props: SettingsViewProps) {
  return (
    <section className="settings-view" aria-label="设置">
      <SettingsNavigation activeSection={props.activeSection} onBack={props.onBack} onSectionChange={props.onSectionChange} />
      <main className="settings-content">
        {props.activeSection === "models" && <ModelsPanel settings={props.settings} providerCatalog={props.providerCatalog} authFlow={props.authFlow} onSave={props.onSave} onTest={props.onTest} onLogin={props.onLogin} onAnswerAuthPrompt={props.onAnswerAuthPrompt} onCancelAuth={props.onCancelAuth} onLogout={props.onLogout} onDismissAuth={props.onDismissAuth} />}
        {props.activeSection === "permissions" && <PermissionsPanel />}
        {props.activeSection === "general" && <GeneralPanel />}
        {props.activeSection === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
      </main>
    </section>
  );
}

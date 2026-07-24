import * as Select from "@radix-ui/react-select";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleDollarSign,
  Database,
  ExternalLink,
  KeyRound,
  LogIn,
  LogOut,
  LockKeyhole,
  Palette,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ModelSettings,
  ModelCatalogEntry,
  ModelMetadataOverride,
  PermissionRuntime,
  PermissionSettings,
  ProviderCatalogEntry,
  ProviderId,
  SaveModelSettings,
  ThinkingLevel,
} from "../contracts";
import type { SettingsSection, Theme } from "../types";
import type { AuthFlowState } from "../types";
import { PluginsPanel } from "./PluginsPanel";

type SettingsViewProps = {
  activeSection: SettingsSection;
  settings: ModelSettings;
  permissionRuntime: PermissionRuntime;
  providerCatalog: ProviderCatalogEntry[];
  authFlow: AuthFlowState | null;
  theme: Theme;
  agentRunning: boolean;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onThemeChange: (theme: Theme) => void;
  onSave: (settings: SaveModelSettings) => Promise<void>;
  onSavePermissions: (settings: PermissionSettings) => Promise<void>;
  onDiscoverModels: (settings: SaveModelSettings) => Promise<ModelCatalogEntry[]>;
  onRefreshMetadata: () => Promise<ProviderCatalogEntry[]>;
  onSaveMetadata: (providerId: ProviderId, modelId: string, metadata: ModelMetadataOverride) => Promise<ProviderCatalogEntry[]>;
  onResetMetadata: (providerId: ProviderId, modelId: string) => Promise<ProviderCatalogEntry[]>;
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
  { group: "AI", items: [{ id: "models", label: "大模型", icon: Sparkles }, { id: "model-metadata", label: "模型元信息", icon: Database }, { id: "permissions", label: "权限", icon: LockKeyhole }] },
  { group: "扩展", items: [{ id: "plugins", label: "插件", icon: Package }] },
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

function ModelSelect({
  value,
  models,
  onChange,
}: {
  value: string;
  models: ModelCatalogEntry[];
  onChange: (modelId: string) => void;
}) {
  const options = models.some((model) => model.id === value) || !value
    ? models
    : [{ id: value, name: value, reasoning: false, contextWindow: 0 }, ...models];
  const selectedModel = options.find((model) => model.id === value);

  return (
    <Select.Root value={value} onValueChange={onChange} disabled={options.length === 0}>
      <Select.Trigger className="select-trigger" aria-label="模型">
        <Select.Value placeholder="暂无可用模型"><span className="settings-model-value">{selectedModel?.name ?? value}</span></Select.Value>
        <Select.Icon><ChevronDown size={14} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content model-catalog-select" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            <Select.Group>
              <Select.Label className="select-label">自动获取的模型</Select.Label>
              {options.map((model) => (
                <Select.Item className="select-item model-select-item" value={model.id} key={model.id}>
                  <Select.ItemText><span><strong>{model.name}</strong><small>{model.id}</small></span></Select.ItemText>
                  <Select.ItemIndicator><Check size={13} /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Group>
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
  onDiscoverModels,
  onTest,
  onLogin,
  onAnswerAuthPrompt,
  onCancelAuth,
  onLogout,
  onDismissAuth,
}: Pick<SettingsViewProps, "settings" | "providerCatalog" | "authFlow" | "onSave" | "onDiscoverModels" | "onTest" | "onLogin" | "onAnswerAuthPrompt" | "onCancelAuth" | "onLogout" | "onDismissAuth">) {
  const [form, setForm] = useState<SaveModelSettings>(() => editableSettings(settings));
  const [busy, setBusy] = useState<"save" | "test" | "models" | null>(null);
  const [modelFetchMessage, setModelFetchMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authAnswer, setAuthAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(editableSettings(settings)), [settings]);
  const provider = useMemo(
    () => providerCatalog.find((entry) => entry.id === form.provider),
    [form.provider, providerCatalog],
  );
  const configuredProviders = useMemo(() => {
    const configuredIds = new Set(settings.configuredProviders);
    const currentProvider = providerCatalog.find((entry) => entry.id === settings.provider);
    if (currentProvider?.kind === "compatible") configuredIds.add(currentProvider.id);
    return providerCatalog.filter((entry) => configuredIds.has(entry.id));
  }, [providerCatalog, settings.configuredProviders, settings.provider]);
  const configuredModelCount = configuredProviders.reduce((count, entry) => count + entry.models.length, 0);
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
    setModelFetchMessage(null);
  }

  function selectConfiguredModel(entry: ProviderCatalogEntry, modelId: string) {
    setForm((current) => ({
      ...current,
      provider: entry.id,
      baseUrl: current.provider === entry.id ? current.baseUrl : entry.baseUrl,
      modelId,
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

  async function discoverModels() {
    setBusy("models");
    setError(null);
    setModelFetchMessage(null);
    try {
      const models = await onDiscoverModels(form);
      setForm((current) => ({
        ...current,
        modelId: models.some((model) => model.id === current.modelId) ? current.modelId : models[0]?.id ?? "",
      }));
      setModelFetchMessage(`已获取 ${models.length} 个模型`);
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
          <div className="settings-field">
            <span>模型</span>
            <div className="settings-model-picker">
              <ModelSelect value={form.modelId} models={provider?.models ?? []} onChange={(modelId) => update("modelId", modelId)} />
              <button className="secondary-button fetch-models-button" type="button" disabled={Boolean(busy) || !form.baseUrl.trim()} onClick={() => void discoverModels()}>
                <RefreshCw size={13} className={busy === "models" ? "is-spinning" : ""} />
                {busy === "models" ? "获取中…" : "获取模型"}
              </button>
            </div>
            <em className={`model-fetch-status ${modelFetchMessage ? "is-success" : ""}`}>{modelFetchMessage ?? "根据当前 API 地址和 Key 拉取模型列表"}</em>
          </div>
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

      <section className="configured-providers-section">
        <header>
          <span><strong>已配置 Provider</strong><small>这些 Provider 及其模型会同步出现在对话框的模型菜单中。</small></span>
          <span className="configured-provider-summary">{configuredProviders.length} 个 Provider · {configuredModelCount} 个模型</span>
        </header>
        {configuredProviders.length === 0 ? (
          <div className="configured-providers-empty">
            <Sparkles size={16} />
            <span><strong>暂未配置 Provider</strong><small>在上方填写凭据并保存后，会自动获取并显示支持的模型。</small></span>
          </div>
        ) : (
          <div className="configured-provider-list">
            {configuredProviders.map((entry) => {
              const entryCredential = settings.credentials.find((item) => item.providerId === entry.id);
              const selected = form.provider === entry.id;
              return (
                <article className={`configured-provider ${selected ? "is-selected" : ""}`} key={entry.id}>
                  <button className="configured-provider-trigger" type="button" onClick={() => {
                    if (!selected) changeProvider(entry.id);
                  }}>
                    <span className="provider-logo">{entry.name[0]}</span>
                    <span><strong>{entry.name}</strong><small>{entryCredential?.type === "oauth" ? "OAuth 已登录" : entryCredential?.type === "api_key" ? "API Key 已配置" : "兼容端点已配置"}</small></span>
                    <span className="configured-provider-count">{entry.models.length} 个模型</span>
                    {selected ? <ChevronDown size={14} /> : <span className="configured-provider-chevron">›</span>}
                  </button>
                  {selected && (
                    <div className="configured-model-list">
                      <header><strong>支持的模型</strong><small>选择模型后点击页面右上角“保存设置”生效</small></header>
                      {entry.models.length === 0 ? (
                        <p>暂未获取到模型，请检查网络或 Provider 配置。</p>
                      ) : (
                        <div>
                          {entry.models.map((model) => (
                            <button className={model.id === form.modelId ? "is-selected" : ""} type="button" key={model.id} onClick={() => selectConfiguredModel(entry, model.id)}>
                              <span><strong>{model.name}</strong><small>{model.id}</small></span>
                              {model.id === form.modelId && <Check size={13} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
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

      {error && <div className="settings-error" role="alert">{error}</div>}
      <footer className="settings-panel-footer">
        <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("test")}>{busy === "test" ? "正在调用模型…" : "验证连接"}</button>
        <span>验证会真实发送一条最小请求</span><small>密钥不会出现在日志中</small>
      </footer>
    </div>
  );
}

type MetadataForm = {
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};

function metadataForm(model: ModelCatalogEntry): MetadataForm {
  return {
    name: model.name,
    contextWindow: String(model.contextWindow || 0),
    maxOutputTokens: String(model.maxOutputTokens || 0),
    input: String(model.pricing?.input || 0),
    output: String(model.pricing?.output || 0),
    cacheRead: String(model.pricing?.cacheRead || 0),
    cacheWrite: String(model.pricing?.cacheWrite || 0),
  };
}

function metadataNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}必须是大于或等于 0 的数字。`);
  return number;
}

function compactTokens(value: number): string {
  if (!value) return "未知";
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  if (value >= 1_000) return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return value.toLocaleString();
}

function compactPrice(value: number | undefined): string {
  if (!value) return "—";
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function ModelMetadataPanel({
  settings,
  providerCatalog,
  onRefreshMetadata,
  onSaveMetadata,
  onResetMetadata,
}: Pick<SettingsViewProps, "settings" | "providerCatalog" | "onRefreshMetadata" | "onSaveMetadata" | "onResetMetadata">) {
  const allModels = useMemo(() => providerCatalog.flatMap((provider) => provider.models.map((model) => ({ provider, model }))), [providerCatalog]);
  const initialKey = `${settings.provider}\u0000${settings.modelId}`;
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [form, setForm] = useState<MetadataForm | null>(null);
  const [busy, setBusy] = useState<"refresh" | "save" | "reset" | null>(null);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const selected = allModels.find(({ provider, model }) => `${provider.id}\u0000${model.id}` === selectedKey) ?? allModels[0];
  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return allModels.filter(({ provider, model }) => (
      (providerFilter === "all" || provider.id === providerFilter)
      && (!normalized || `${provider.name} ${provider.id} ${model.name} ${model.id}`.toLocaleLowerCase().includes(normalized))
    ));
  }, [allModels, providerFilter, query]);

  useEffect(() => {
    if (selected) setForm(metadataForm(selected.model));
  }, [selected?.provider.id, selected?.model.id, selected?.model.name, selected?.model.contextWindow, selected?.model.maxOutputTokens, selected?.model.pricing]);

  function updateForm(key: keyof MetadataForm, value: string) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function refresh() {
    setBusy("refresh");
    setError(undefined);
    setMessage(undefined);
    try {
      const catalog = await onRefreshMetadata();
      const modelCount = catalog.reduce((sum, provider) => sum + provider.models.length, 0);
      setMessage(`已同步 ${catalog.length} 个提供商、${modelCount} 个模型；用户修改保持不变。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !form) return;
    setBusy("save");
    setError(undefined);
    setMessage(undefined);
    try {
      await onSaveMetadata(selected.provider.id, selected.model.id, {
        name: form.name.trim(),
        contextWindow: metadataNumber(form.contextWindow, "上下文窗口"),
        maxOutputTokens: metadataNumber(form.maxOutputTokens, "最大输出"),
        pricing: {
          input: metadataNumber(form.input, "输入价格"),
          output: metadataNumber(form.output, "输出价格"),
          cacheRead: metadataNumber(form.cacheRead, "缓存读取价格"),
          cacheWrite: metadataNumber(form.cacheWrite, "缓存写入价格"),
        },
      });
      setMessage("用户覆盖已保存，后续用量计费会读取这组价格。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!selected) return;
    setBusy("reset");
    setError(undefined);
    setMessage(undefined);
    try {
      await onResetMetadata(selected.provider.id, selected.model.id);
      setMessage("已恢复官方目录中的元信息。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-panel metadata-settings-panel">
      <header className="settings-page-header metadata-page-header">
        <div><h2>模型元信息</h2><p>查看上下文与价格，并维护供用量计费读取的模型数据。</p></div>
        <button className="secondary-button metadata-refresh-button" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>
          <RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={14} />{busy === "refresh" ? "正在同步" : "同步官方目录"}
        </button>
      </header>

      <section className="metadata-summary" aria-label="元信息摘要">
        <span><Database size={15} /><strong>{providerCatalog.length}</strong><small>提供商</small></span>
        <span><Sparkles size={15} /><strong>{allModels.length}</strong><small>模型</small></span>
        <span><CircleDollarSign size={15} /><strong>{allModels.filter(({ model }) => (model.pricing?.input || model.pricing?.output)).length}</strong><small>含价格</small></span>
        <p>价格单位统一为 USD / 1M tokens；官方目录同步不会覆盖用户修改。</p>
      </section>

      <div className="metadata-toolbar">
        <label className="metadata-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或提供商" aria-label="搜索模型元信息" /></label>
        <select className="native-select metadata-provider-filter" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label="筛选模型提供商">
          <option value="all">全部提供商</option>
          {providerCatalog.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select>
      </div>

      <div className="metadata-workspace">
        <div className="metadata-table-wrap">
          <table className="metadata-table">
            <thead><tr><th>模型</th><th>上下文</th><th>输入</th><th>输出</th></tr></thead>
            <tbody>
              {visibleModels.map(({ provider, model }) => {
                const key = `${provider.id}\u0000${model.id}`;
                return (
                  <tr className={key === selectedKey ? "is-selected" : ""} key={key} onClick={() => setSelectedKey(key)}>
                    <td><button type="button" onClick={() => setSelectedKey(key)}><strong>{model.name}</strong><small>{provider.name} · {model.id}</small></button>{model.isMetadataOverridden && <i>已编辑</i>}</td>
                    <td>{compactTokens(model.contextWindow)}</td>
                    <td>{compactPrice(model.pricing?.input)}</td>
                    <td>{compactPrice(model.pricing?.output)}</td>
                  </tr>
                );
              })}
              {visibleModels.length === 0 && <tr><td className="metadata-empty" colSpan={4}>没有匹配的模型</td></tr>}
            </tbody>
          </table>
        </div>

        {selected && form && (
          <form className="metadata-editor" onSubmit={(event) => void save(event)}>
            <header>
              <div><span>{selected.provider.name}</span><strong>{selected.model.id}</strong></div>
              <span className={`metadata-source ${selected.model.isMetadataOverridden ? "is-custom" : ""}`}>{selected.model.isMetadataOverridden ? "用户覆盖" : selected.model.metadataSource === "endpoint" ? "端点数据" : "官方目录"}</span>
            </header>
            <label><span>显示名称</span><input value={form.name} onChange={(event) => updateForm("name", event.target.value)} required /></label>
            <div className="metadata-editor-grid">
              <label><span>上下文窗口</span><input type="number" min="0" step="1" value={form.contextWindow} onChange={(event) => updateForm("contextWindow", event.target.value)} /><small>tokens</small></label>
              <label><span>最大输出</span><input type="number" min="0" step="1" value={form.maxOutputTokens} onChange={(event) => updateForm("maxOutputTokens", event.target.value)} /><small>tokens</small></label>
              <label><span>输入价格</span><input type="number" min="0" step="any" value={form.input} onChange={(event) => updateForm("input", event.target.value)} /><small>$/1M</small></label>
              <label><span>输出价格</span><input type="number" min="0" step="any" value={form.output} onChange={(event) => updateForm("output", event.target.value)} /><small>$/1M</small></label>
              <label><span>缓存读取</span><input type="number" min="0" step="any" value={form.cacheRead} onChange={(event) => updateForm("cacheRead", event.target.value)} /><small>$/1M</small></label>
              <label><span>缓存写入</span><input type="number" min="0" step="any" value={form.cacheWrite} onChange={(event) => updateForm("cacheWrite", event.target.value)} /><small>$/1M</small></label>
            </div>
            <p>{selected.model.metadataSourceUrl ? <>数据参考：{new URL(selected.model.metadataSourceUrl).hostname}</> : "兼容端点通常不提供价格；可在这里手动补充。"}</p>
            <footer>
              {selected.model.isMetadataOverridden && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void reset()}><RotateCcw size={13} />恢复官方值</button>}
              <button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === "save" ? "保存中…" : "保存修改"}</button>
            </footer>
          </form>
        )}
      </div>
      {message && <div className="metadata-message" role="status">{message}</div>}
      {error && <div className="settings-error" role="alert">{error.replace(/^Error invoking remote method '[^']+': Error: /, "")}</div>}
    </div>
  );
}

function PermissionsPanel({
  runtime,
  agentRunning,
  onSave,
}: {
  runtime: PermissionRuntime;
  agentRunning: boolean;
  onSave: (settings: PermissionSettings) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function selectMode(mode: PermissionSettings["mode"]) {
    if (mode === runtime.mode || busy || agentRunning) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave({ mode });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const balanced = runtime.mode === "balanced";
  const sandboxAvailable = runtime.sandbox === "available";
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header">
        <div><h2>权限</h2><p>减少重复确认，同时保留清晰的系统边界。</p></div>
        <span className={`sandbox-status ${sandboxAvailable ? "is-ready" : ""}`}>
          <i />{sandboxAvailable ? "命令沙箱可用" : "命令沙箱不可用"}
        </span>
      </header>
      <section className="permission-mode-grid" aria-label="权限模式">
        <button className={balanced ? "is-selected" : ""} type="button" disabled={busy || agentRunning} onClick={() => void selectMode("balanced")}>
          <span><strong>平衡</strong><small>推荐</small></span>
          <p>工作区内读写自动执行；危险命令、越界访问仍需确认。</p>
          {balanced && <Check size={14} />}
        </button>
        <button className={!balanced ? "is-selected" : ""} type="button" disabled={busy || agentRunning} onClick={() => void selectMode("strict")}>
          <span><strong>严格</strong></span>
          <p>Shell 和文件修改逐次确认，适合陌生或敏感项目。</p>
          {!balanced && <Check size={14} />}
        </button>
      </section>
      <section className="simple-settings-card">
        <div className="settings-toggle-row"><span><strong>Shell 命令</strong><small>{balanced && sandboxAvailable ? "限制写入工作区与临时目录，并拦截敏感凭据和未知网络" : "执行前展示完整命令并等待确认"}</small></span><span className={`policy-badge ${balanced && sandboxAvailable ? "policy-badge--allowed" : ""}`}>{balanced && sandboxAvailable ? "沙箱内允许" : "执行前询问"}</span></div>
        <div className="settings-toggle-row"><span><strong>文件修改</strong><small>{balanced ? "edit 与 write 仅在规范化后的工作区路径内自动执行" : "edit 与 write 每次执行前询问"}</small></span><span className={`policy-badge ${balanced ? "policy-badge--allowed" : ""}`}>{balanced ? "工作区内允许" : "执行前询问"}</span></div>
        <div className="settings-toggle-row"><span><strong>只读工具</strong><small>read、grep、find、ls 可在所选工作目录运行</small></span><span className="policy-badge policy-badge--allowed">自动允许</span></div>
        <div className="settings-toggle-row"><span><strong>危险与越界操作</strong><small>递归删除、丢弃 Git 变更、提权及工作区外访问</small></span><span className="policy-badge">始终询问</span></div>
      </section>
      <p className="permission-footnote">
        {sandboxAvailable
          ? `Shell 由 Anthropic Sandbox Runtime 隔离（${runtime.platform === "darwin" ? "macOS Seatbelt" : "Linux Bubblewrap"}）。`
          : "当前平台或系统依赖不支持 OS 级沙箱；平衡模式下 Shell 仍会询问，并可仅对本次任务授权。"}
      </p>
      {agentRunning && <p className="permission-inline-note">任务运行期间不能切换权限模式。</p>}
      {error && <div className="settings-error" role="alert">{error}</div>}
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
        {props.activeSection === "models" && <ModelsPanel settings={props.settings} providerCatalog={props.providerCatalog} authFlow={props.authFlow} onSave={props.onSave} onDiscoverModels={props.onDiscoverModels} onTest={props.onTest} onLogin={props.onLogin} onAnswerAuthPrompt={props.onAnswerAuthPrompt} onCancelAuth={props.onCancelAuth} onLogout={props.onLogout} onDismissAuth={props.onDismissAuth} />}
        {props.activeSection === "model-metadata" && <ModelMetadataPanel settings={props.settings} providerCatalog={props.providerCatalog} onRefreshMetadata={props.onRefreshMetadata} onSaveMetadata={props.onSaveMetadata} onResetMetadata={props.onResetMetadata} />}
        {props.activeSection === "plugins" && <PluginsPanel agentRunning={props.agentRunning} />}
        {props.activeSection === "permissions" && <PermissionsPanel runtime={props.permissionRuntime} agentRunning={props.agentRunning} onSave={props.onSavePermissions} />}
        {props.activeSection === "general" && <GeneralPanel />}
        {props.activeSection === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
      </main>
    </section>
  );
}

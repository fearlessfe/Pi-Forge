import * as Select from "@radix-ui/react-select";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleDollarSign,
  Database,
  BookOpen,
  ExternalLink,
  KeyRound,
  LogIn,
  LogOut,
  LockKeyhole,
  Cable,
  Palette,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Activity,
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
  ResourceSettings,
  SaveModelSettings,
  SystemPromptSettings,
  ThinkingLevel,
  WorkspaceTrustStatus,
} from "../contracts";
import type { SettingsSection, Theme } from "../types";
import type { AuthFlowState } from "../types";
import { useI18n } from "../i18n";
import { SkillsPanel } from "./SkillsPanel";
import { McpPanel } from "./McpPanel";
import { ObservabilityPanel } from "./ObservabilityPanel";

type SettingsViewProps = {
  activeSection: SettingsSection;
  settings: ModelSettings;
  permissionRuntime: PermissionRuntime;
  systemPrompt: SystemPromptSettings;
  resourceSettings: ResourceSettings;
  workspaceTrust?: WorkspaceTrustStatus;
  providerCatalog: ProviderCatalogEntry[];
  authFlow: AuthFlowState | null;
  theme: Theme;
  agentRunning: boolean;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onThemeChange: (theme: Theme) => void;
  onSave: (settings: SaveModelSettings) => Promise<void>;
  onSavePermissions: (settings: PermissionSettings) => Promise<void>;
  onSaveSystemPrompt: (settings: SystemPromptSettings) => Promise<void>;
  onSaveResourceSettings: (settings: ResourceSettings) => Promise<void>;
  onSetWorkspaceTrusted: (trusted: boolean) => Promise<void>;
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
  { group: "扩展", items: [{ id: "skills", label: "Skills", icon: BookOpen }, { id: "mcp", label: "MCP", icon: Cable }] },
  { group: "可观测性", items: [{ id: "observability", label: "Trace", icon: Activity }] },
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
  const { t } = useI18n();
  return (
    <aside className="settings-sidebar">
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft size={15} /><span>{t("返回对话")}</span></button>
      <h1>{t("设置")}</h1>
      {sections.map((section) => (
        <div className="settings-nav-group" key={section.group}>
          <span>{t(section.group)}</span>
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <button className={`settings-nav-item ${activeSection === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => onSectionChange(item.id)}>
                <Icon size={16} />{t(item.label)}
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
  const { t } = useI18n();
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
      <Select.Trigger className="select-trigger" aria-label={t("模型提供商")}><Select.Value /><Select.Icon><ChevronDown size={14} /></Select.Icon></Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            {builtinProviders.length > 0 && (
              <Select.Group>
                <Select.Label className="select-label">{t("Pi 内置 Provider")}</Select.Label>
                {builtinProviders.map(renderProvider)}
              </Select.Group>
            )}
            {compatibleProviders.length > 0 && <Select.Separator className="select-separator" />}
            {compatibleProviders.length > 0 && (
              <Select.Group>
                <Select.Label className="select-label">{t("自定义兼容端点")}</Select.Label>
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
  const { t } = useI18n();
  const options = models.some((model) => model.id === value) || !value
    ? models
    : [{ id: value, name: value, reasoning: false, contextWindow: 0 }, ...models];
  const selectedModel = options.find((model) => model.id === value);

  return (
    <Select.Root value={value} onValueChange={onChange} disabled={options.length === 0}>
      <Select.Trigger className="select-trigger" aria-label={t("模型")}>
        <Select.Value placeholder={t("暂无可用模型")}><span className="settings-model-value">{selectedModel?.name ?? value}</span></Select.Value>
        <Select.Icon><ChevronDown size={14} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content model-catalog-select" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            <Select.Group>
              <Select.Label className="select-label">{t("自动获取的模型")}</Select.Label>
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
  const { t } = useI18n();
  const [form, setForm] = useState<SaveModelSettings>(() => editableSettings(settings));
  const [busy, setBusy] = useState<"save" | "test" | "models" | null>(null);
  const [modelFetchMessage, setModelFetchMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authAnswer, setAuthAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<ProviderId | null>(settings.provider);

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
      setModelFetchMessage(t("已获取 {count} 个模型", { count: models.length }));
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
        <div><h2>{t("大模型")}</h2><p>{t("真实配置 Pi Coding Agent 使用的提供商、端点、密钥与 thinking 级别。")}</p></div>
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("save")}>{t(busy === "save" ? "保存中…" : "保存设置")}</button>
      </header>

      <section className="provider-card">
        <header className="provider-heading">
          <span className="provider-logo">{providerName[0]}</span>
          <span><strong>{providerName}</strong><small>{provider?.kind === "compatible" ? t("自定义兼容端点") : `${t("Pi 内置 Provider")} · ${provider?.models.length ?? 0} ${t("个模型")}`}</small></span>
          <span className={`connection-status ${credential ? "" : "is-idle"}`}><i />{t(providerHasOAuth ? "OAuth 已登录" : providerHasApiKey ? "API Key 已配置" : needsOAuth ? "需要 OAuth 登录" : "等待配置")}</span>
        </header>

        <div className="settings-form-grid">
          <label className="settings-field"><span>{t("提供商")}</span><ProviderSelect value={form.provider} providers={providerCatalog} onChange={changeProvider} /></label>
          <label className="settings-field"><span>{t("API 地址")}{provider?.kind === "builtin" ? t("（可选覆盖）") : ""}</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} spellCheck={false} placeholder={provider?.baseUrl || t("使用 Provider 的环境配置")} /></label>
          <div className="settings-field">
            <span>{t("模型")}</span>
            <div className="settings-model-picker">
              <ModelSelect value={form.modelId} models={provider?.models ?? []} onChange={(modelId) => update("modelId", modelId)} />
              <button className="secondary-button fetch-models-button" type="button" disabled={Boolean(busy) || !form.baseUrl.trim()} onClick={() => void discoverModels()}>
                <RefreshCw size={13} className={busy === "models" ? "is-spinning" : ""} />
                {t(busy === "models" ? "获取中…" : "获取模型")}
              </button>
            </div>
            <em className={`model-fetch-status ${modelFetchMessage ? "is-success" : ""}`}>{modelFetchMessage ?? t("根据当前 API 地址和 Key 拉取模型列表")}</em>
          </div>
          <label className="settings-field">
            <span>{t("Thinking 级别")}</span>
            <select className="native-select" value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value as ThinkingLevel)}>
              <option value="off">{t("关闭")}</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option>
            </select>
          </label>
          <label className="settings-field settings-field--full">
            <span>API Key</span>
            <div className="secret-input"><KeyRound size={14} /><input type="password" disabled={needsOAuth} value={form.apiKey ?? ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={t(providerHasApiKey ? "已安全保存；留空则保持不变" : providerHasOAuth ? "当前使用 OAuth；输入 Key 并保存可切换" : needsOAuth ? "该 Provider 仅支持 OAuth" : provider?.kind === "compatible" ? "本地端点可留空；远程端点需要 Key" : "输入 API Key，或使用环境凭据")} /><small>{t(providerHasApiKey ? "系统加密存储" : providerHasOAuth ? "当前使用 OAuth" : needsOAuth ? "请登录" : "未保存")}</small></div>
            <em>{t("API Key 与 OAuth Token 均由操作系统安全存储加密；Renderer 只能看到认证类型，无法读取凭据明文。")}</em>
          </label>
        </div>
      </section>

      <section className="configured-providers-section">
        <header>
          <span><strong>{t("已配置 Provider")}</strong><small>{t("这些 Provider 及其模型会同步出现在对话框的模型菜单中。")}</small></span>
          <span className="configured-provider-summary">{configuredProviders.length} Provider · {configuredModelCount} {t("个模型")}</span>
        </header>
        {configuredProviders.length === 0 ? (
          <div className="configured-providers-empty">
            <Sparkles size={16} />
            <span><strong>{t("暂未配置 Provider")}</strong><small>{t("在上方填写凭据并保存后，会自动获取并显示支持的模型。")}</small></span>
          </div>
        ) : (
          <div className="configured-provider-list">
            {configuredProviders.map((entry) => {
              const entryCredential = settings.credentials.find((item) => item.providerId === entry.id);
              const selected = form.provider === entry.id;
              const expanded = expandedProvider === entry.id;
              return (
                <article className={`configured-provider ${selected ? "is-selected" : ""}`} key={entry.id}>
                  <button className="configured-provider-trigger" type="button" aria-expanded={expanded} onClick={() => {
                    if (!selected) changeProvider(entry.id);
                    setExpandedProvider((current) => current === entry.id ? null : entry.id);
                  }}>
                    <span className="provider-logo">{entry.name[0]}</span>
                    <span><strong>{entry.name}</strong><small>{t(entryCredential?.type === "oauth" ? "OAuth 已登录" : entryCredential?.type === "api_key" ? "API Key 已配置" : "兼容端点已配置")}</small></span>
                    <span className="configured-provider-count">{entry.models.length} {t("个模型")}</span>
                    {expanded ? <ChevronDown size={14} /> : <span className="configured-provider-chevron">›</span>}
                  </button>
                  {expanded && (
                    <div className="configured-model-list">
                      <header><strong>{t("支持的模型")}</strong><small>{t("选择模型后点击页面右上角“保存设置”生效")}</small></header>
                      {entry.models.length === 0 ? (
                        <p>{t("暂未获取到模型，请检查网络或 Provider 配置。")}</p>
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
            <span><strong>{t("订阅账号登录")}</strong><small>{provider.oauthName ?? `${providerName} OAuth`}</small></span>
            {providerHasOAuth ? (
              <button className="secondary-button" type="button" disabled={authBusy || Boolean(activeAuth)} onClick={() => void runAuth(() => onLogout(form.provider))}><LogOut size={13} />{t("退出登录")}</button>
            ) : (
              <button className="secondary-button" type="button" disabled={authBusy || Boolean(activeAuth)} onClick={() => void runAuth(() => onLogin(form.provider))}><ExternalLink size={13} />{t("使用浏览器登录")}</button>
            )}
          </header>

          {activeAuth && (
            <div className={`oauth-flow ${activeAuth.status === "error" ? "is-error" : ""}`}>
              {activeAuth.message && <p>{activeAuth.message}</p>}
              {activeAuth.url && <code>{activeAuth.url}</code>}
              {activeAuth.deviceCode && (
                <div className="oauth-device-code">
                  <span>{t("设备码")}</span><strong>{activeAuth.deviceCode.userCode}</strong>
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
                  <div><input type={activeAuth.prompt.promptType === "secret" ? "password" : "text"} value={authAnswer} onChange={(event) => setAuthAnswer(event.target.value)} placeholder={activeAuth.prompt.placeholder} autoFocus /><button className="primary-button" type="submit" disabled={activeAuth.prompt.promptType !== "text" && !authAnswer.trim()}>{t("继续")}</button></div>
                </form>
              )}
              <footer>
                {activeAuth.status === "running" ? <button type="button" onClick={() => void onCancelAuth(activeAuth.loginId)}>{t("取消登录")}</button> : <button type="button" onClick={onDismissAuth}>{t("关闭")}</button>}
              </footer>
            </div>
          )}
        </section>
      )}

      {error && <div className="settings-error" role="alert">{error}</div>}
      <footer className="settings-panel-footer">
        <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("test")}>{t(busy === "test" ? "正在调用模型…" : "验证连接")}</button>
        <span>{t("验证会真实发送一条最小请求")}</span><small>{t("密钥不会出现在日志中")}</small>
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

function metadataNumber(value: string, label: string, invalidSuffix = "必须是大于或等于 0 的数字。"): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} ${invalidSuffix}`);
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
  const { t } = useI18n();
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
      setMessage(t("已同步 {providers} 个提供商、{models} 个模型；用户修改保持不变。", { providers: catalog.length, models: modelCount }));
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
        contextWindow: metadataNumber(form.contextWindow, t("上下文窗口"), t("必须是大于或等于 0 的数字。")),
        maxOutputTokens: metadataNumber(form.maxOutputTokens, t("最大输出"), t("必须是大于或等于 0 的数字。")),
        pricing: {
          input: metadataNumber(form.input, t("输入价格"), t("必须是大于或等于 0 的数字。")),
          output: metadataNumber(form.output, t("输出价格"), t("必须是大于或等于 0 的数字。")),
          cacheRead: metadataNumber(form.cacheRead, t("缓存读取价格"), t("必须是大于或等于 0 的数字。")),
          cacheWrite: metadataNumber(form.cacheWrite, t("缓存写入价格"), t("必须是大于或等于 0 的数字。")),
        },
      });
      setMessage(t("用户覆盖已保存，后续用量计费会读取这组价格。"));
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
      setMessage(t("已恢复官方目录中的元信息。"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-panel metadata-settings-panel">
      <header className="settings-page-header metadata-page-header">
        <div><h2>{t("模型元信息")}</h2><p>{t("查看上下文与价格，并维护供用量计费读取的模型数据。")}</p></div>
        <button className="secondary-button metadata-refresh-button" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>
          <RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={14} />{t(busy === "refresh" ? "正在同步" : "同步官方目录")}
        </button>
      </header>

      <section className="metadata-summary" aria-label={t("元信息摘要")}>
        <span><Database size={15} /><strong>{providerCatalog.length}</strong><small>{t("提供商")}</small></span>
        <span><Sparkles size={15} /><strong>{allModels.length}</strong><small>{t("模型")}</small></span>
        <span><CircleDollarSign size={15} /><strong>{allModels.filter(({ model }) => (model.pricing?.input || model.pricing?.output)).length}</strong><small>{t("含价格")}</small></span>
        <p>{t("价格单位统一为 USD / 1M tokens；官方目录同步不会覆盖用户修改。")}</p>
      </section>

      <div className="metadata-toolbar">
        <label className="metadata-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索模型或提供商")} aria-label={t("搜索模型元信息")} /></label>
        <select className="native-select metadata-provider-filter" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label={t("筛选模型提供商")}>
          <option value="all">{t("全部提供商")}</option>
          {providerCatalog.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select>
      </div>

      <div className="metadata-workspace">
        <div className="metadata-table-wrap">
          <table className="metadata-table">
            <thead><tr><th>{t("模型")}</th><th>{t("上下文")}</th><th>{t("输入")}</th><th>{t("输出")}</th></tr></thead>
            <tbody>
              {visibleModels.map(({ provider, model }) => {
                const key = `${provider.id}\u0000${model.id}`;
                return (
                  <tr className={key === selectedKey ? "is-selected" : ""} key={key} onClick={() => setSelectedKey(key)}>
                    <td><button type="button" onClick={() => setSelectedKey(key)}><strong>{model.name}</strong><small>{provider.name} · {model.id}</small></button>{model.isMetadataOverridden && <i>{t("已编辑")}</i>}</td>
                    <td>{compactTokens(model.contextWindow)}</td>
                    <td>{compactPrice(model.pricing?.input)}</td>
                    <td>{compactPrice(model.pricing?.output)}</td>
                  </tr>
                );
              })}
              {visibleModels.length === 0 && <tr><td className="metadata-empty" colSpan={4}>{t("没有匹配的模型")}</td></tr>}
            </tbody>
          </table>
        </div>

        {selected && form && (
          <form className="metadata-editor" onSubmit={(event) => void save(event)}>
            <header>
              <div><span>{selected.provider.name}</span><strong>{selected.model.id}</strong></div>
              <span className={`metadata-source ${selected.model.isMetadataOverridden ? "is-custom" : ""}`}>{t(selected.model.isMetadataOverridden ? "用户覆盖" : selected.model.metadataSource === "endpoint" ? "端点数据" : "官方目录")}</span>
            </header>
            <label><span>{t("显示名称")}</span><input value={form.name} onChange={(event) => updateForm("name", event.target.value)} required /></label>
            <div className="metadata-editor-grid">
              <label><span>{t("上下文窗口")}</span><input type="number" min="0" step="1" value={form.contextWindow} onChange={(event) => updateForm("contextWindow", event.target.value)} /><small>tokens</small></label>
              <label><span>{t("最大输出")}</span><input type="number" min="0" step="1" value={form.maxOutputTokens} onChange={(event) => updateForm("maxOutputTokens", event.target.value)} /><small>tokens</small></label>
              <label><span>{t("输入价格")}</span><input type="number" min="0" step="any" value={form.input} onChange={(event) => updateForm("input", event.target.value)} /><small>$/1M</small></label>
              <label><span>{t("输出价格")}</span><input type="number" min="0" step="any" value={form.output} onChange={(event) => updateForm("output", event.target.value)} /><small>$/1M</small></label>
              <label><span>{t("缓存读取")}</span><input type="number" min="0" step="any" value={form.cacheRead} onChange={(event) => updateForm("cacheRead", event.target.value)} /><small>$/1M</small></label>
              <label><span>{t("缓存写入")}</span><input type="number" min="0" step="any" value={form.cacheWrite} onChange={(event) => updateForm("cacheWrite", event.target.value)} /><small>$/1M</small></label>
            </div>
            <p>{selected.model.metadataSourceUrl ? <>{t("数据参考")}：{new URL(selected.model.metadataSourceUrl).hostname}</> : t("兼容端点通常不提供价格；可在这里手动补充。")}</p>
            <footer>
              {selected.model.isMetadataOverridden && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void reset()}><RotateCcw size={13} />{t("恢复官方值")}</button>}
              <button className="primary-button" type="submit" disabled={Boolean(busy)}>{t(busy === "save" ? "保存中…" : "保存修改")}</button>
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
  const { t } = useI18n();
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
        <div><h2>{t("权限")}</h2><p>{t("减少重复确认，同时保留清晰的系统边界。")}</p></div>
        <span className={`sandbox-status ${sandboxAvailable ? "is-ready" : ""}`}>
          <i />{t(sandboxAvailable ? "命令沙箱可用" : "命令沙箱不可用")}
        </span>
      </header>
      <section className="permission-mode-grid" aria-label={t("权限模式")}>
        <button className={balanced ? "is-selected" : ""} type="button" disabled={busy || agentRunning} onClick={() => void selectMode("balanced")}>
          <span><strong>{t("平衡")}</strong><small>{t("推荐")}</small></span>
          <p>{t("工作区内读写自动执行；危险命令、越界访问仍需确认。")}</p>
          {balanced && <Check size={14} />}
        </button>
        <button className={!balanced ? "is-selected" : ""} type="button" disabled={busy || agentRunning} onClick={() => void selectMode("strict")}>
          <span><strong>{t("严格")}</strong></span>
          <p>{t("Shell 和文件修改逐次确认，适合陌生或敏感项目。")}</p>
          {!balanced && <Check size={14} />}
        </button>
      </section>
      <section className="simple-settings-card">
        <div className="settings-toggle-row"><span><strong>{t("Shell 命令")}</strong><small>{t(balanced && sandboxAvailable ? "限制写入工作区与临时目录，并拦截敏感凭据和未知网络" : "执行前展示完整命令并等待确认")}</small></span><span className={`policy-badge ${balanced && sandboxAvailable ? "policy-badge--allowed" : ""}`}>{t(balanced && sandboxAvailable ? "沙箱内允许" : "执行前询问")}</span></div>
        <div className="settings-toggle-row"><span><strong>{t("文件修改")}</strong><small>{t(balanced ? "edit 与 write 仅在规范化后的工作区路径内自动执行" : "edit 与 write 每次执行前询问")}</small></span><span className={`policy-badge ${balanced ? "policy-badge--allowed" : ""}`}>{t(balanced ? "工作区内允许" : "执行前询问")}</span></div>
        <div className="settings-toggle-row"><span><strong>{t("只读工具")}</strong><small>{t("read、grep、find、ls 可在所选工作目录运行")}</small></span><span className="policy-badge policy-badge--allowed">{t("自动允许")}</span></div>
        <div className="settings-toggle-row"><span><strong>{t("危险与越界操作")}</strong><small>{t("递归删除、丢弃 Git 变更、提权及工作区外访问")}</small></span><span className="policy-badge">{t("始终询问")}</span></div>
      </section>
      <p className="permission-footnote">
        {sandboxAvailable
          ? t("Shell 由 Anthropic Sandbox Runtime 隔离（{runtime}）。", { runtime: runtime.platform === "darwin" ? "macOS Seatbelt" : "Linux Bubblewrap" })
          : t("当前平台或系统依赖不支持 OS 级沙箱；平衡模式下 Shell 仍会询问，并可仅对本次任务授权。")}
      </p>
      {agentRunning && <p className="permission-inline-note">{t("任务运行期间不能切换权限模式。")}</p>}
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
}

function GeneralPanel({
  systemPrompt,
  resourceSettings,
  workspaceTrust,
  agentRunning,
  onSaveSystemPrompt,
  onSaveResourceSettings,
  onSetWorkspaceTrusted,
}: Pick<SettingsViewProps, "systemPrompt" | "resourceSettings" | "workspaceTrust" | "agentRunning" | "onSaveSystemPrompt" | "onSaveResourceSettings" | "onSetWorkspaceTrusted">) {
  const { language, setLanguage, t } = useI18n();
  const [content, setContent] = useState(systemPrompt.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [resourceBusy, setResourceBusy] = useState(false);
  const normalizedContent = content.trim();
  const changed = normalizedContent !== systemPrompt.content;

  useEffect(() => setContent(systemPrompt.content), [systemPrompt.content]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSaveSystemPrompt({ content });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function updateResources(workspaceContextEnabled: boolean) {
    setResourceBusy(true);
    setError("");
    try {
      await onSaveResourceSettings({ ...resourceSettings, workspaceContextEnabled });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setResourceBusy(false);
    }
  }

  async function updateTrust(trusted: boolean) {
    setResourceBusy(true);
    setError("");
    try {
      await onSetWorkspaceTrusted(trusted);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setResourceBusy(false);
    }
  }

  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>{t("通用")}</h2><p>{t("调整 Pi Desktop 的会话和系统行为。")}</p></div></header>
      <section className="simple-settings-card">
        <label className="settings-toggle-row"><span><strong>{t("语言")}</strong><small>{t("选择 Pi Desktop 的界面语言。")}</small></span><select className="native-select language-select" value={language} onChange={(event) => setLanguage(event.target.value as "zh-CN" | "en-US")}><option value="zh-CN">{t("简体中文")}</option><option value="en-US">English</option></select></label>
        <div className="settings-toggle-row"><span><strong>{t("流式过程")}</strong><small>{t("实时显示 thinking、文本增量和工具状态")}</small></span><span className="policy-badge policy-badge--allowed">{t("始终开启")}</span></div>
        <div className="settings-toggle-row"><span><strong>{t("工作区上下文")}</strong><small>{t("加载可信项目的 AGENTS.md、Skills 与 Pi Extensions")}</small></span><button className={`switch ${resourceSettings.workspaceContextEnabled ? "is-on" : ""}`} type="button" disabled={agentRunning || resourceBusy} aria-pressed={resourceSettings.workspaceContextEnabled} aria-label={t("启用工作区上下文")} onClick={() => void updateResources(!resourceSettings.workspaceContextEnabled)}><i /></button></div>
        {workspaceTrust && workspaceTrust.hasProjectResources && <div className="settings-toggle-row"><span><strong>{t("当前项目资源")}</strong><small title={workspaceTrust.path}>{workspaceTrust.path}</small></span><button className={`switch ${workspaceTrust.trusted ? "is-on" : ""}`} type="button" disabled={agentRunning || resourceBusy || !resourceSettings.workspaceContextEnabled} aria-pressed={workspaceTrust.trusted} aria-label={t("信任当前项目")} onClick={() => void updateTrust(!workspaceTrust.trusted)}><i /></button></div>}
      </section>
      <section className="system-prompt-card" aria-labelledby="system-prompt-title">
        <header>
          <span><strong id="system-prompt-title">{t("系统提示词")}</strong><small>{t("追加到 Pi 默认系统提示词，用于设置全局行为与回答偏好。")}</small></span>
          <span className="policy-badge policy-badge--allowed">{t("追加模式")}</span>
        </header>
        <label className="system-prompt-editor">
          <span>{t("自定义指令")}</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t("例如：默认使用简体中文回答；修改代码后运行相关测试。")}
            maxLength={100_000}
            disabled={saving}
            spellCheck={false}
          />
        </label>
        {error && <div className="settings-error" role="alert">{error}</div>}
        <footer>
          <small>{t(agentRunning ? "Agent 正在运行，结束当前任务后才能修改。" : "保存后会重启 Agent 会话，下一条消息立即生效。")}</small>
          <div>
            <button className="secondary-button" type="button" disabled={saving || !content} onClick={() => setContent("")}>{t("恢复默认")}</button>
            <button className="primary-button" type="button" disabled={saving || agentRunning || !changed} onClick={() => void save()}>{t(saving ? "保存中…" : "保存并重启 Agent")}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function AppearancePanel({ theme, onThemeChange }: Pick<SettingsViewProps, "theme" | "onThemeChange">) {
  const { t } = useI18n();
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>{t("外观")}</h2><p>{t("选择适合当前环境的界面主题。")}</p></div></header>
      <section className="theme-card-grid">
        {(["dark", "light"] as const).map((item) => (
          <button className={`theme-card ${theme === item ? "is-selected" : ""}`} key={item} type="button" onClick={() => onThemeChange(item)}>
            <span className={`theme-preview theme-preview--${item}`}><i /><b><em /><em /><em /></b></span>
            <span>{t(item === "dark" ? "深色" : "浅色")}{theme === item && <Check size={14} />}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

export function SettingsView(props: SettingsViewProps) {
  const { t } = useI18n();
  return (
    <section className="settings-view" aria-label={t("设置")}>
      <SettingsNavigation activeSection={props.activeSection} onBack={props.onBack} onSectionChange={props.onSectionChange} />
      <main className="settings-content">
        {props.activeSection === "models" && <ModelsPanel settings={props.settings} providerCatalog={props.providerCatalog} authFlow={props.authFlow} onSave={props.onSave} onDiscoverModels={props.onDiscoverModels} onTest={props.onTest} onLogin={props.onLogin} onAnswerAuthPrompt={props.onAnswerAuthPrompt} onCancelAuth={props.onCancelAuth} onLogout={props.onLogout} onDismissAuth={props.onDismissAuth} />}
        {props.activeSection === "model-metadata" && <ModelMetadataPanel settings={props.settings} providerCatalog={props.providerCatalog} onRefreshMetadata={props.onRefreshMetadata} onSaveMetadata={props.onSaveMetadata} onResetMetadata={props.onResetMetadata} />}
        {props.activeSection === "skills" && <SkillsPanel cwd={props.workspaceTrust?.path} agentRunning={props.agentRunning} />}
        {props.activeSection === "mcp" && <McpPanel cwd={props.workspaceTrust?.path} projectTrusted={Boolean(props.workspaceTrust?.trusted)} agentRunning={props.agentRunning} />}
        {props.activeSection === "permissions" && <PermissionsPanel runtime={props.permissionRuntime} agentRunning={props.agentRunning} onSave={props.onSavePermissions} />}
        {props.activeSection === "observability" && <ObservabilityPanel agentRunning={props.agentRunning} />}
        {props.activeSection === "general" && <GeneralPanel systemPrompt={props.systemPrompt} resourceSettings={props.resourceSettings} workspaceTrust={props.workspaceTrust} agentRunning={props.agentRunning} onSaveSystemPrompt={props.onSaveSystemPrompt} onSaveResourceSettings={props.onSaveResourceSettings} onSetWorkspaceTrusted={props.onSetWorkspaceTrusted} />}
        {props.activeSection === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
      </main>
    </section>
  );
}

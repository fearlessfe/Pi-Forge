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

/* 设置视图共享工具类组合（token v2，docs/design-refresh-apple.md 3.2/3.5）：
   按钮 13px/600 走 control-lg 高度档；表单控件 bg-fill + border-separator + radius-sm。 */
const primaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-[6px] rounded-sm border-0 bg-accent px-card text-body font-semibold text-accent-ink transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const secondaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const fieldInputClass =
  "h-control-lg w-full rounded-sm border border-separator bg-fill px-[11px] text-body text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32";
const selectTriggerClass =
  "flex h-control-lg w-full cursor-pointer items-center justify-between gap-base rounded-sm border border-separator bg-fill px-[11px] text-body text-label outline-none focus-visible:ring-2 focus-visible:ring-accent/32 data-[state=open]:border-accent disabled:pointer-events-none disabled:opacity-40";
const nativeSelectClass =
  "h-control-lg w-full cursor-pointer appearance-none rounded-sm border border-separator bg-fill pr-8 pl-[11px] text-body text-label outline-none focus-visible:ring-2 focus-visible:ring-accent/32";
const nativeSelectChevronClass = "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-label-3";
const fieldLabelClass = "mb-[7px] block text-caption font-semibold text-label-2";
const fieldNoteClass = "mt-[7px] block text-caption not-italic leading-normal text-label-3";
const settingsErrorClass = "mt-[14px] rounded-sm border border-red/32 bg-red/8 px-loose py-[10px] text-caption text-red";
const providerLogoClass = "grid size-[38px] flex-none place-items-center rounded-md bg-fill-2 font-serif text-title font-bold text-label";
const settingsToggleRowClass = "flex min-h-[70px] items-center justify-between gap-panel border-b border-separator last:border-b-0";
const toggleRowTextClass = "min-w-0";
const toggleRowTitleClass = "block text-body font-semibold text-label";
const toggleRowNoteClass = "mt-[5px] block text-caption text-label-2";

const settingsNavItemClass = (active: boolean) =>
  active
    ? "flex h-control-lg w-full cursor-pointer items-center gap-[10px] rounded-md bg-accent/16 px-[10px] text-left text-body text-label transition-colors duration-150 ease-apple"
    : "flex h-control-lg w-full cursor-pointer items-center gap-[10px] rounded-md px-[10px] text-left text-body text-label-2 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98]";

const policyBadgeClass = (allowed: boolean) =>
  allowed
    ? "flex-none rounded-full border border-green/32 bg-green/8 px-[9px] py-[6px] text-mini text-green"
    : "flex-none rounded-full border border-orange/32 bg-orange/8 px-[9px] py-[6px] text-mini text-orange";

const switchClass = (on: boolean) =>
  on
    ? "relative h-5 w-9 cursor-pointer rounded-full bg-accent p-0.5 transition-colors duration-150 ease-apple before:absolute before:-inset-1 before:content-[''] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
    : "relative h-5 w-9 cursor-pointer rounded-full bg-fill-2 p-0.5 transition-colors duration-150 ease-apple before:absolute before:-inset-1 before:content-[''] hover:bg-fill-3 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const switchKnobClass = (on: boolean) =>
  on
    ? "block size-4 translate-x-4 rounded-full border border-separator bg-knob shadow-1 transition-transform duration-150 ease-apple"
    : "block size-4 rounded-full border border-separator bg-knob shadow-1 transition-transform duration-150 ease-apple";

const configuredProviderClass = (selected: boolean) =>
  selected
    ? "overflow-hidden rounded-md border border-accent/32 bg-bg-grouped"
    : "overflow-hidden rounded-md border border-transparent bg-bg-grouped";
const configuredModelClass = (selected: boolean) =>
  selected
    ? "flex min-h-[46px] min-w-0 cursor-pointer items-center justify-between gap-base rounded-sm border border-accent/32 bg-accent/8 px-[9px] py-[7px] text-left text-label-2 transition-colors duration-150 ease-apple"
    : "flex min-h-[46px] min-w-0 cursor-pointer items-center justify-between gap-base rounded-sm border border-separator bg-bg-grouped-2 px-[9px] py-[7px] text-left text-label-2 transition-colors duration-150 ease-apple hover:bg-fill";

const metadataRowClass = (selected: boolean) =>
  selected
    ? "cursor-pointer bg-fill-3"
    : "cursor-pointer transition-colors duration-150 ease-apple hover:bg-fill";
const metadataSourceClass = (custom: boolean) =>
  custom
    ? "flex-none rounded-sm border border-accent/32 bg-accent/16 px-[6px] py-1 text-mini text-accent"
    : "flex-none rounded-sm border border-blue/32 bg-blue/8 px-[6px] py-1 text-mini text-blue";

const permissionModeClass = (selected: boolean) =>
  selected
    ? "relative min-h-[105px] cursor-pointer rounded-md border border-accent/32 bg-accent/8 p-[14px] text-left text-label-2 transition-colors duration-150 ease-apple disabled:pointer-events-none disabled:opacity-40"
    : "relative min-h-[105px] cursor-pointer rounded-md border border-separator bg-bg-grouped p-[14px] text-left text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";

const themeCardClass = (selected: boolean) =>
  selected
    ? "cursor-pointer rounded-md border border-accent/32 bg-bg-grouped p-base text-label ring-2 ring-accent/16 transition-colors duration-150 ease-apple"
    : "cursor-pointer rounded-md border border-separator bg-bg-grouped p-base text-label transition-colors duration-150 ease-apple hover:bg-fill";
/* 主题预览色板：深/浅示意色固定在定制层（非主题感知 token），此处仅做静态映射（3.5 规则 2）。 */
const themePreviewVariantClass = { dark: "theme-preview--dark", light: "theme-preview--light", system: "theme-preview--system" } as const;

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
    <aside className="border-r border-separator bg-material-sidebar px-card pt-card pb-section">
      <button className="flex h-control-lg w-full cursor-pointer items-center gap-base rounded-md px-[9px] text-body text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98]" type="button" onClick={onBack}><ArrowLeft size={16} /><span>{t("返回对话")}</span></button>
      <h1 className="mx-[9px] mt-[22px] mb-6 text-title font-semibold text-label">{t("设置")}</h1>
      {sections.map((section) => (
        <div className="mt-5" key={section.group}>
          <span className="mx-[10px] mb-[7px] block text-caption font-semibold text-label-3">{t(section.group)}</span>
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <button className={settingsNavItemClass(activeSection === item.id)} key={item.id} type="button" onClick={() => onSectionChange(item.id)}>
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
    <Select.Item className="select-item flex min-h-[34px] items-center justify-between rounded-sm px-[9px] text-caption" value={provider.id} key={provider.id}>
      <Select.ItemText>{provider.name}</Select.ItemText>
      <Select.ItemIndicator><Check size={14} /></Select.ItemIndicator>
    </Select.Item>
  );
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as ProviderId)}>
      <Select.Trigger className={selectTriggerClass} aria-label={t("模型提供商")}><Select.Value /><Select.Icon><ChevronDown size={14} /></Select.Icon></Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content w-[var(--radix-select-trigger-width)] max-h-[min(520px,var(--radix-select-content-available-height))]" position="popper" sideOffset={6}>
          <Select.Viewport className="max-h-[min(500px,var(--radix-select-content-available-height))]">
            {builtinProviders.length > 0 && (
              <Select.Group>
                <Select.Label className="px-[9px] pt-base pb-[5px] text-caption font-semibold uppercase tracking-[0.04em] text-label-3">{t("Pi 内置 Provider")}</Select.Label>
                {builtinProviders.map(renderProvider)}
              </Select.Group>
            )}
            {compatibleProviders.length > 0 && <Select.Separator className="mx-1 my-[6px] h-px bg-separator" />}
            {compatibleProviders.length > 0 && (
              <Select.Group>
                <Select.Label className="px-[9px] pt-base pb-[5px] text-caption font-semibold uppercase tracking-[0.04em] text-label-3">{t("自定义兼容端点")}</Select.Label>
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
      <Select.Trigger className={selectTriggerClass} aria-label={t("模型")}>
        <Select.Value placeholder={t("暂无可用模型")}><span className="block min-w-0 truncate text-left">{selectedModel?.name ?? value}</span></Select.Value>
        <Select.Icon><ChevronDown size={14} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content w-[min(430px,var(--radix-select-content-available-width))] min-w-[var(--radix-select-trigger-width)] max-h-[min(520px,var(--radix-select-content-available-height))]" position="popper" sideOffset={6}>
          <Select.Viewport className="max-h-[min(500px,var(--radix-select-content-available-height))]">
            <Select.Group>
              <Select.Label className="px-[9px] pt-base pb-[5px] text-caption font-semibold uppercase tracking-[0.04em] text-label-3">{t("自动获取的模型")}</Select.Label>
              {options.map((model) => (
                <Select.Item className="select-item model-select-item flex items-center justify-between rounded-sm px-[9px] text-caption" value={model.id} key={model.id}>
                  <Select.ItemText><span><strong>{model.name}</strong><small>{model.id}</small></span></Select.ItemText>
                  <Select.ItemIndicator><Check size={14} /></Select.ItemIndicator>
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
    <div className="w-full max-w-[820px]">
      <header className="mb-[27px] flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("大模型")}</h2><p className="text-body text-label-2">{t("真实配置 Pi Coding Agent 使用的提供商、端点、密钥与 thinking 级别。")}</p></div>
        <button className={primaryButtonClass} type="button" disabled={Boolean(busy)} onClick={() => void run("save")}>{t(busy === "save" ? "保存中…" : "保存设置")}</button>
      </header>

      <section className="rounded-md bg-bg-grouped p-card">
        <header className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-loose border-b border-separator pb-5">
          <span className={providerLogoClass}>{providerName[0]}</span>
          <span className="min-w-0"><strong className="block text-body font-semibold text-label">{providerName}</strong><small className="mt-1 block text-caption text-label-2">{provider?.kind === "compatible" ? t("自定义兼容端点") : `${t("Pi 内置 Provider")} · ${provider?.models.length ?? 0} ${t("个模型")}`}</small></span>
          <span className={credential ? "inline-flex items-center gap-[6px] text-caption text-green" : "inline-flex items-center gap-[6px] text-caption text-label-3"}><i className="size-[6px] rounded-full bg-current" />{t(providerHasOAuth ? "OAuth 已登录" : providerHasApiKey ? "API Key 已配置" : needsOAuth ? "需要 OAuth 登录" : "等待配置")}</span>
        </header>

        <div className="mt-5 grid grid-cols-2 gap-card">
          <label className="min-w-0"><span className={fieldLabelClass}>{t("提供商")}</span><ProviderSelect value={form.provider} providers={providerCatalog} onChange={changeProvider} /></label>
          <label className="min-w-0"><span className={fieldLabelClass}>{t("API 地址")}{provider?.kind === "builtin" ? t("（可选覆盖）") : ""}</span><input className={fieldInputClass} value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} spellCheck={false} placeholder={provider?.baseUrl || t("使用 Provider 的环境配置")} /></label>
          <div className="min-w-0">
            <span className={fieldLabelClass}>{t("模型")}</span>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-base">
              <ModelSelect value={form.modelId} models={provider?.models ?? []} onChange={(modelId) => update("modelId", modelId)} />
              <button className="inline-flex h-control-lg min-w-[104px] cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-accent/32 bg-accent/8 px-loose text-body font-semibold whitespace-nowrap text-accent transition-colors duration-150 ease-apple hover:bg-accent/16 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(busy) || !form.baseUrl.trim()} onClick={() => void discoverModels()}>
                <RefreshCw size={14} className={busy === "models" ? "is-spinning" : ""} />
                {t(busy === "models" ? "获取中…" : "获取模型")}
              </button>
            </div>
            <em className={modelFetchMessage ? "mt-[7px] block text-caption not-italic text-green" : "mt-[7px] block text-caption not-italic text-label-3"}>{modelFetchMessage ?? t("根据当前 API 地址和 Key 拉取模型列表")}</em>
          </div>
          <label className="min-w-0">
            <span className={fieldLabelClass}>{t("Thinking 级别")}</span>
            <span className="relative block">
              <select className={nativeSelectClass} value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value as ThinkingLevel)}>
                <option value="off">{t("关闭")}</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option>
              </select>
              <ChevronDown size={14} className={nativeSelectChevronClass} />
            </span>
          </label>
          <label className="col-span-full min-w-0">
            <span className={fieldLabelClass}>API Key</span>
            <div className="flex h-control-lg w-full items-center gap-base rounded-sm border border-separator bg-fill px-[11px] text-label-2 focus-within:ring-2 focus-within:ring-accent/32"><KeyRound size={14} className="flex-none text-label-3" /><input className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-caption text-label outline-none placeholder:text-label-3" type="password" disabled={needsOAuth} value={form.apiKey ?? ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={t(providerHasApiKey ? "已安全保存；留空则保持不变" : providerHasOAuth ? "当前使用 OAuth；输入 Key 并保存可切换" : needsOAuth ? "该 Provider 仅支持 OAuth" : provider?.kind === "compatible" ? "本地端点可留空；远程端点需要 Key" : "输入 API Key，或使用环境凭据")} /><small className="ml-auto flex-none text-caption text-green">{t(providerHasApiKey ? "系统加密存储" : providerHasOAuth ? "当前使用 OAuth" : needsOAuth ? "请登录" : "未保存")}</small></div>
            <em className={fieldNoteClass}>{t("API Key 与 OAuth Token 均由操作系统安全存储加密；Renderer 只能看到认证类型，无法读取凭据明文。")}</em>
          </label>
        </div>
      </section>

      <section className="mt-[22px]">
        <header className="mb-[11px] flex items-start justify-between gap-5">
          <span className="min-w-0"><strong className="block text-callout font-semibold text-label">{t("已配置 Provider")}</strong><small className="mt-[5px] block text-caption text-label-3">{t("这些 Provider 及其模型会同步出现在对话框的模型菜单中。")}</small></span>
          <span className="flex-none font-mono text-caption text-label-2 tabular-nums">{configuredProviders.length} Provider · {configuredModelCount} {t("个模型")}</span>
        </header>
        {configuredProviders.length === 0 ? (
          <div className="flex min-h-[72px] items-center gap-[11px] rounded-md border border-dashed border-separator bg-bg p-[14px]">
            <Sparkles size={16} className="flex-none text-accent" />
            <span className="min-w-0"><strong className="block text-caption font-semibold text-label-2">{t("暂未配置 Provider")}</strong><small className="mt-[5px] block text-caption text-label-3">{t("在上方填写凭据并保存后，会自动获取并显示支持的模型。")}</small></span>
          </div>
        ) : (
          <div className="grid gap-base">
            {configuredProviders.map((entry) => {
              const entryCredential = settings.credentials.find((item) => item.providerId === entry.id);
              const selected = form.provider === entry.id;
              const expanded = expandedProvider === entry.id;
              return (
                <article className={configuredProviderClass(selected)} key={entry.id}>
                  <button className="grid min-h-[58px] w-full cursor-pointer grid-cols-[31px_minmax(0,1fr)_auto_16px] items-center gap-[10px] px-loose py-base text-left text-label-2 transition-colors duration-150 ease-apple hover:bg-fill" type="button" aria-expanded={expanded} onClick={() => {
                    if (!selected) changeProvider(entry.id);
                    setExpandedProvider((current) => current === entry.id ? null : entry.id);
                  }}>
                    <span className={providerLogoClass}>{entry.name[0]}</span>
                    <span className="min-w-0"><strong className="block text-caption font-semibold text-label">{entry.name}</strong><small className="mt-1 block text-caption text-label-3">{t(entryCredential?.type === "oauth" ? "OAuth 已登录" : entryCredential?.type === "api_key" ? "API Key 已配置" : "兼容端点已配置")}</small></span>
                    <span className="font-mono text-caption text-label-2 tabular-nums">{entry.models.length} {t("个模型")}</span>
                    {expanded ? <ChevronDown size={14} className="text-label-2" /> : <span className="text-title leading-none text-label-2">›</span>}
                  </button>
                  {expanded && (
                    <div className="border-t border-separator pr-loose pb-loose pl-[53px]">
                      <header className="flex items-baseline justify-between gap-card pt-[11px] pb-base"><strong className="text-caption font-semibold text-label">{t("支持的模型")}</strong><small className="text-caption text-label-3">{t("选择模型后点击页面右上角“保存设置”生效")}</small></header>
                      {entry.models.length === 0 ? (
                        <p className="text-caption text-label-3">{t("暂未获取到模型，请检查网络或 Provider 配置。")}</p>
                      ) : (
                        <div className="grid max-h-[250px] grid-cols-2 gap-[6px] overflow-y-auto pr-1 [scrollbar-width:thin]">
                          {entry.models.map((model) => (
                            <button className={configuredModelClass(model.id === form.modelId)} type="button" key={model.id} onClick={() => selectConfiguredModel(entry, model.id)}>
                              <span className="min-w-0"><strong className="block truncate text-caption font-semibold">{model.name}</strong><small className="mt-1 block truncate font-mono text-caption text-label-3">{model.id}</small></span>
                              {model.id === form.modelId && <Check size={14} className="flex-none text-accent" />}
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
        <section className="mt-[14px] rounded-md bg-bg-grouped p-card">
          <header className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-[11px]">
            <span className="grid size-[34px] flex-none place-items-center rounded-sm bg-accent/16 text-accent"><LogIn size={16} /></span>
            <span className="min-w-0"><strong className="block text-body font-semibold text-label">{t("订阅账号登录")}</strong><small className="mt-[3px] block text-caption text-label-2">{provider.oauthName ?? `${providerName} OAuth`}</small></span>
            {providerHasOAuth ? (
              <button className={secondaryButtonClass} type="button" disabled={authBusy || Boolean(activeAuth)} onClick={() => void runAuth(() => onLogout(form.provider))}><LogOut size={14} />{t("退出登录")}</button>
            ) : (
              <button className={secondaryButtonClass} type="button" disabled={authBusy || Boolean(activeAuth)} onClick={() => void runAuth(() => onLogin(form.provider))}><ExternalLink size={14} />{t("使用浏览器登录")}</button>
            )}
          </header>

          {activeAuth && (
            <div className={activeAuth.status === "error" ? "mt-[14px] rounded-md border border-red/32 bg-bg p-[13px]" : "mt-[14px] rounded-md border border-separator bg-bg p-[13px]"}>
              {activeAuth.message && <p className="mb-[10px] text-caption leading-normal text-label-2">{activeAuth.message}</p>}
              {activeAuth.url && <code className="block truncate font-mono text-caption text-label-3">{activeAuth.url}</code>}
              {activeAuth.deviceCode && (
                <div className="mt-[10px] grid grid-cols-[auto_1fr] items-center gap-x-loose gap-y-[6px] rounded-sm bg-fill p-loose">
                  <span className="text-caption text-label-2">{t("设备码")}</span><strong className="font-mono text-title font-bold tracking-[0.08em] text-label">{activeAuth.deviceCode.userCode}</strong>
                  <small className="col-span-full font-mono text-caption text-label-3">{activeAuth.deviceCode.verificationUri}</small>
                </div>
              )}
              {activeAuth.prompt?.promptType === "select" && (
                <div className="mt-[11px] grid gap-[7px]">
                  {activeAuth.prompt.options?.map((option) => (
                    <button className="cursor-pointer rounded-sm border border-separator bg-bg-grouped-2 px-[11px] py-[10px] text-left transition-colors duration-150 ease-apple hover:border-accent hover:bg-fill" type="button" key={option.id} onClick={() => void runAuth(() => onAnswerAuthPrompt(activeAuth.prompt!.requestId, option.id))}>
                      <strong className="block text-caption font-semibold text-label-2">{option.label}</strong>{option.description && <small className="mt-[3px] block text-caption text-label-3">{option.description}</small>}
                    </button>
                  ))}
                </div>
              )}
              {activeAuth.prompt && activeAuth.prompt.promptType !== "select" && (
                <form className="mt-loose" onSubmit={(event) => { event.preventDefault(); void runAuth(() => onAnswerAuthPrompt(activeAuth.prompt!.requestId, authAnswer)); }}>
                  <label className="mb-[7px] block text-caption text-label-2">{activeAuth.prompt.message}</label>
                  <div className="flex gap-base"><input className="h-control-lg min-w-0 flex-1 rounded-sm border border-separator bg-fill px-[10px] text-body text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32" type={activeAuth.prompt.promptType === "secret" ? "password" : "text"} value={authAnswer} onChange={(event) => setAuthAnswer(event.target.value)} placeholder={activeAuth.prompt.placeholder} autoFocus /><button className={primaryButtonClass} type="submit" disabled={activeAuth.prompt.promptType !== "text" && !authAnswer.trim()}>{t("继续")}</button></div>
                </form>
              )}
              <footer className="mt-[10px] flex justify-end">
                {activeAuth.status === "running" ? <button className="cursor-pointer border-0 bg-transparent py-1 text-caption text-label-2 transition-colors duration-150 ease-apple hover:text-label" type="button" onClick={() => void onCancelAuth(activeAuth.loginId)}>{t("取消登录")}</button> : <button className="cursor-pointer border-0 bg-transparent py-1 text-caption text-label-2 transition-colors duration-150 ease-apple hover:text-label" type="button" onClick={onDismissAuth}>{t("关闭")}</button>}
              </footer>
            </div>
          )}
        </section>
      )}

      {error && <div className={settingsErrorClass} role="alert">{error}</div>}
      <footer className="mt-[22px] flex items-center border-t border-separator pt-[18px]">
        <button className={secondaryButtonClass} type="button" disabled={Boolean(busy)} onClick={() => void run("test")}>{t(busy === "test" ? "正在调用模型…" : "验证连接")}</button>
        <span className="ml-[11px] text-caption text-label-2">{t("验证会真实发送一条最小请求")}</span><small className="ml-auto text-caption text-label-2">{t("密钥不会出现在日志中")}</small>
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
    <div className="w-full max-w-[1080px]">
      <header className="mb-[18px] flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("模型元信息")}</h2><p className="text-body text-label-2">{t("查看上下文与价格，并维护供用量计费读取的模型数据。")}</p></div>
        <button className={secondaryButtonClass} type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>
          <RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={14} />{t(busy === "refresh" ? "正在同步" : "同步官方目录")}
        </button>
      </header>

      <section className="mb-[13px] flex min-h-[58px] items-center gap-base rounded-md bg-bg-grouped p-[10px]" aria-label={t("元信息摘要")}>
        <span className="grid min-w-[100px] grid-cols-[auto_auto] items-center justify-start gap-x-[7px] border-r border-separator px-[9px] py-[3px] text-accent"><Database size={16} /><strong className="text-body text-label">{providerCatalog.length}</strong><small className="col-start-2 text-caption text-label-3">{t("提供商")}</small></span>
        <span className="grid min-w-[100px] grid-cols-[auto_auto] items-center justify-start gap-x-[7px] border-r border-separator px-[9px] py-[3px] text-accent"><Sparkles size={16} /><strong className="text-body text-label">{allModels.length}</strong><small className="col-start-2 text-caption text-label-3">{t("模型")}</small></span>
        <span className="grid min-w-[100px] grid-cols-[auto_auto] items-center justify-start gap-x-[7px] border-r border-separator px-[9px] py-[3px] text-accent"><CircleDollarSign size={16} /><strong className="text-body text-label">{allModels.filter(({ model }) => (model.pricing?.input || model.pricing?.output)).length}</strong><small className="col-start-2 text-caption text-label-3">{t("含价格")}</small></span>
        <p className="mx-1 ml-auto text-right text-caption leading-normal text-label-3 [@media(max-width:1100px)]:hidden">{t("价格单位统一为 USD / 1M tokens；官方目录同步不会覆盖用户修改。")}</p>
      </section>

      <div className="mb-base grid grid-cols-[minmax(220px,1fr)_190px] gap-base">
        <label className="flex h-control-lg items-center gap-base rounded-sm border border-separator bg-fill px-[11px] text-label-3 focus-within:ring-2 focus-within:ring-accent/32"><Search size={14} /><input className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-label outline-none placeholder:text-label-3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索模型或提供商")} aria-label={t("搜索模型元信息")} /></label>
        <span className="relative block">
          <select className={nativeSelectClass} value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label={t("筛选模型提供商")}>
            <option value="all">{t("全部提供商")}</option>
            {providerCatalog.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
          </select>
          <ChevronDown size={14} className={nativeSelectChevronClass} />
        </span>
      </div>

      <div className="grid min-h-[450px] grid-cols-[minmax(430px,1.5fr)_minmax(300px,0.9fr)] overflow-hidden rounded-lg bg-bg-grouped [@media(max-width:1100px)]:grid-cols-1">
        <div className="max-h-[520px] overflow-y-auto border-r border-separator [scrollbar-width:thin] [@media(max-width:1100px)]:max-h-[360px] [@media(max-width:1100px)]:border-r-0 [@media(max-width:1100px)]:border-b">
          <table className="w-full table-fixed border-collapse">
            <thead><tr><th className="sticky top-0 z-10 w-[52%] border-b border-separator bg-bg-grouped/95 px-[9px] py-[10px] pl-[13px] text-left text-caption font-semibold text-label-3 backdrop-blur-[9px]">{t("模型")}</th><th className="sticky top-0 z-10 border-b border-separator bg-bg-grouped/95 px-[9px] py-[10px] text-right text-caption font-semibold text-label-3 backdrop-blur-[9px]">{t("上下文")}</th><th className="sticky top-0 z-10 border-b border-separator bg-bg-grouped/95 px-[9px] py-[10px] text-right text-caption font-semibold text-label-3 backdrop-blur-[9px]">{t("输入")}</th><th className="sticky top-0 z-10 border-b border-separator bg-bg-grouped/95 px-[9px] py-[10px] text-right text-caption font-semibold text-label-3 backdrop-blur-[9px]">{t("输出")}</th></tr></thead>
            <tbody>
              {visibleModels.map(({ provider, model }) => {
                const key = `${provider.id}\u0000${model.id}`;
                return (
                  <tr className={metadataRowClass(key === selectedKey)} key={key} onClick={() => setSelectedKey(key)}>
                    <td className="relative border-b border-separator pr-[9px] pl-[13px] text-left font-mono text-caption text-label-2"><button className="block w-full min-w-0 cursor-pointer border-0 bg-transparent py-[9px] text-left text-inherit" type="button" onClick={() => setSelectedKey(key)}><strong className="block truncate font-sans text-caption font-semibold text-label-2">{model.name}</strong><small className="mt-1 block truncate font-mono text-caption text-label-3">{provider.name} · {model.id}</small></button>{model.isMetadataOverridden && <i className="absolute top-[7px] right-1 rounded-sm bg-accent/16 px-1 py-0.5 font-sans text-mini not-italic text-accent">{t("已编辑")}</i>}</td>
                    <td className="relative border-b border-separator px-[9px] text-right font-mono text-caption text-label-2">{compactTokens(model.contextWindow)}</td>
                    <td className="relative border-b border-separator px-[9px] text-right font-mono text-caption text-label-2">{compactPrice(model.pricing?.input)}</td>
                    <td className="relative border-b border-separator px-[9px] text-right font-mono text-caption text-label-2">{compactPrice(model.pricing?.output)}</td>
                  </tr>
                );
              })}
              {visibleModels.length === 0 && <tr><td className="relative h-[100px] border-b border-separator px-[9px] text-center font-mono text-caption text-label-2" colSpan={4}>{t("没有匹配的模型")}</td></tr>}
            </tbody>
          </table>
        </div>

        {selected && form && (
          <form className="min-w-0 bg-fill p-[17px]" onSubmit={(event) => void save(event)}>
            <header className="mb-[17px] flex items-start justify-between gap-loose border-b border-separator pb-[13px]">
              <div className="min-w-0"><span className="mb-[5px] block text-caption text-label-3">{selected.provider.name}</span><strong className="block break-all font-mono text-caption font-semibold leading-[1.4] text-label">{selected.model.id}</strong></div>
              <span className={metadataSourceClass(Boolean(selected.model.isMetadataOverridden))}>{t(selected.model.isMetadataOverridden ? "用户覆盖" : selected.model.metadataSource === "endpoint" ? "端点数据" : "官方目录")}</span>
            </header>
            <label className="block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("显示名称")}</span><input className={fieldInputClass} value={form.name} onChange={(event) => updateForm("name", event.target.value)} required /></label>
            <div className="mt-[14px] grid grid-cols-2 gap-x-base gap-y-[13px]">
              <label className="relative block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("上下文窗口")}</span><input className={`${fieldInputClass} pr-[46px] font-mono`} type="number" min="0" step="1" value={form.contextWindow} onChange={(event) => updateForm("contextWindow", event.target.value)} /><small className="pointer-events-none absolute right-2 bottom-[12px] text-caption text-label-3">tokens</small></label>
              <label className="relative block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("最大输出")}</span><input className={`${fieldInputClass} pr-[46px] font-mono`} type="number" min="0" step="1" value={form.maxOutputTokens} onChange={(event) => updateForm("maxOutputTokens", event.target.value)} /><small className="pointer-events-none absolute right-2 bottom-[12px] text-caption text-label-3">tokens</small></label>
              <label className="relative block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("输入价格")}</span><input className={`${fieldInputClass} pr-[46px] font-mono`} type="number" min="0" step="any" value={form.input} onChange={(event) => updateForm("input", event.target.value)} /><small className="pointer-events-none absolute right-2 bottom-[12px] text-caption text-label-3">$/1M</small></label>
              <label className="relative block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("输出价格")}</span><input className={`${fieldInputClass} pr-[46px] font-mono`} type="number" min="0" step="any" value={form.output} onChange={(event) => updateForm("output", event.target.value)} /><small className="pointer-events-none absolute right-2 bottom-[12px] text-caption text-label-3">$/1M</small></label>
              <label className="relative block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("缓存读取")}</span><input className={`${fieldInputClass} pr-[46px] font-mono`} type="number" min="0" step="any" value={form.cacheRead} onChange={(event) => updateForm("cacheRead", event.target.value)} /><small className="pointer-events-none absolute right-2 bottom-[12px] text-caption text-label-3">$/1M</small></label>
              <label className="relative block min-w-0"><span className="mb-[6px] block text-caption font-semibold text-label-2">{t("缓存写入")}</span><input className={`${fieldInputClass} pr-[46px] font-mono`} type="number" min="0" step="any" value={form.cacheWrite} onChange={(event) => updateForm("cacheWrite", event.target.value)} /><small className="pointer-events-none absolute right-2 bottom-[12px] text-caption text-label-3">$/1M</small></label>
            </div>
            <p className="mt-[15px] min-h-[29px] text-caption leading-normal text-label-3">{selected.model.metadataSourceUrl ? <>{t("数据参考")}：{new URL(selected.model.metadataSourceUrl).hostname}</> : t("兼容端点通常不提供价格；可在这里手动补充。")}</p>
            <footer className="mt-[14px] flex justify-end gap-[7px] border-t border-separator pt-[14px]">
              {selected.model.isMetadataOverridden && <button className={secondaryButtonClass} type="button" disabled={Boolean(busy)} onClick={() => void reset()}><RotateCcw size={14} />{t("恢复官方值")}</button>}
              <button className={primaryButtonClass} type="submit" disabled={Boolean(busy)}>{t(busy === "save" ? "保存中…" : "保存修改")}</button>
            </footer>
          </form>
        )}
      </div>
      {message && <div className="mt-[10px] rounded-sm border border-green/32 bg-green/8 px-[11px] py-[9px] text-caption text-green" role="status">{message}</div>}
      {error && <div className={settingsErrorClass} role="alert">{error.replace(/^Error invoking remote method '[^']+': Error: /, "")}</div>}
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
    <div className="w-full max-w-[760px]">
      <header className="mb-[27px] flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("权限")}</h2><p className="text-body text-label-2">{t("减少重复确认，同时保留清晰的系统边界。")}</p></div>
        <span className={sandboxAvailable ? "inline-flex items-center gap-[7px] rounded-sm border border-green/32 bg-green/8 px-[9px] py-[6px] text-caption whitespace-nowrap text-green" : "inline-flex items-center gap-[7px] rounded-sm border border-orange/32 bg-orange/8 px-[9px] py-[6px] text-caption whitespace-nowrap text-orange"}>
          <i className="size-[6px] rounded-full bg-current" />{t(sandboxAvailable ? "命令沙箱可用" : "命令沙箱不可用")}
        </span>
      </header>
      <section className="mb-[13px] grid grid-cols-2 gap-base" aria-label={t("权限模式")}>
        <button className={permissionModeClass(balanced)} type="button" disabled={busy || agentRunning} onClick={() => void selectMode("balanced")}>
          <span className="flex items-center gap-[7px]"><strong className="text-callout font-semibold text-label">{t("平衡")}</strong><small className="rounded bg-accent/16 px-[5px] py-0.5 text-caption text-accent">{t("推荐")}</small></span>
          <p className="mt-base mr-[22px] max-w-[32em] text-caption leading-[1.55] text-label-2">{t("工作区内读写自动执行；危险命令、越界访问仍需确认。")}</p>
          {balanced && <Check size={14} className="absolute top-[14px] right-[13px] text-accent" />}
        </button>
        <button className={permissionModeClass(!balanced)} type="button" disabled={busy || agentRunning} onClick={() => void selectMode("strict")}>
          <span className="flex items-center gap-[7px]"><strong className="text-callout font-semibold text-label">{t("严格")}</strong></span>
          <p className="mt-base mr-[22px] max-w-[32em] text-caption leading-[1.55] text-label-2">{t("Shell 和文件修改逐次确认，适合陌生或敏感项目。")}</p>
          {!balanced && <Check size={14} className="absolute top-[14px] right-[13px] text-accent" />}
        </button>
      </section>
      <section className="rounded-md bg-bg-grouped px-card">
        <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("Shell 命令")}</strong><small className={toggleRowNoteClass}>{t(balanced && sandboxAvailable ? "限制写入工作区与临时目录，并拦截敏感凭据和未知网络" : "执行前展示完整命令并等待确认")}</small></span><span className={policyBadgeClass(Boolean(balanced && sandboxAvailable))}>{t(balanced && sandboxAvailable ? "沙箱内允许" : "执行前询问")}</span></div>
        <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("文件修改")}</strong><small className={toggleRowNoteClass}>{t(balanced ? "edit 与 write 仅在规范化后的工作区路径内自动执行" : "edit 与 write 每次执行前询问")}</small></span><span className={policyBadgeClass(balanced)}>{t(balanced ? "工作区内允许" : "执行前询问")}</span></div>
        <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("只读工具")}</strong><small className={toggleRowNoteClass}>{t("read、grep、find、ls 可在所选工作目录运行")}</small></span><span className={policyBadgeClass(true)}>{t("自动允许")}</span></div>
        <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("危险与越界操作")}</strong><small className={toggleRowNoteClass}>{t("递归删除、丢弃 Git 变更、提权及工作区外访问")}</small></span><span className={policyBadgeClass(false)}>{t("始终询问")}</span></div>
      </section>
      <p className="mx-0.5 mt-[11px] text-caption leading-[1.55] text-label-2">
        {sandboxAvailable
          ? t("Shell 由 Anthropic Sandbox Runtime 隔离（{runtime}）。", { runtime: runtime.platform === "darwin" ? "macOS Seatbelt" : "Linux Bubblewrap" })
          : t("当前平台或系统依赖不支持 OS 级沙箱；平衡模式下 Shell 仍会询问，并可仅对本次任务授权。")}
      </p>
      {agentRunning && <p className="mx-0.5 mt-[11px] text-caption leading-[1.55] text-orange">{t("任务运行期间不能切换权限模式。")}</p>}
      {error && <div className={settingsErrorClass} role="alert">{error}</div>}
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
    <div className="w-full max-w-[760px]">
      <header className="mb-[27px] flex min-h-[62px] items-start justify-between gap-5"><div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("通用")}</h2><p className="text-body text-label-2">{t("调整 Pi Desktop 的会话和系统行为。")}</p></div></header>
      <section className="rounded-md bg-bg-grouped px-card">
        <label className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("语言")}</strong><small className={toggleRowNoteClass}>{t("选择 Pi Desktop 的界面语言。")}</small></span><span className="relative block w-[180px] flex-none"><select className={nativeSelectClass} value={language} onChange={(event) => setLanguage(event.target.value as "zh-CN" | "en-US")}><option value="zh-CN">{t("简体中文")}</option><option value="en-US">English</option></select><ChevronDown size={14} className={nativeSelectChevronClass} /></span></label>
        <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("流式过程")}</strong><small className={toggleRowNoteClass}>{t("实时显示 thinking、文本增量和工具状态")}</small></span><span className={policyBadgeClass(true)}>{t("始终开启")}</span></div>
        <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("工作区上下文")}</strong><small className={toggleRowNoteClass}>{t("加载可信项目的 AGENTS.md、Skills 与 Pi Extensions")}</small></span><button className={switchClass(resourceSettings.workspaceContextEnabled)} type="button" disabled={agentRunning || resourceBusy} aria-pressed={resourceSettings.workspaceContextEnabled} aria-label={t("启用工作区上下文")} onClick={() => void updateResources(!resourceSettings.workspaceContextEnabled)}><i className={switchKnobClass(resourceSettings.workspaceContextEnabled)} /></button></div>
        {workspaceTrust && workspaceTrust.hasProjectResources && <div className={settingsToggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("当前项目资源")}</strong><small className={`${toggleRowNoteClass} truncate`} title={workspaceTrust.path}>{workspaceTrust.path}</small></span><button className={switchClass(Boolean(workspaceTrust.trusted))} type="button" disabled={agentRunning || resourceBusy || !resourceSettings.workspaceContextEnabled} aria-pressed={workspaceTrust.trusted} aria-label={t("信任当前项目")} onClick={() => void updateTrust(!workspaceTrust.trusted)}><i className={switchKnobClass(Boolean(workspaceTrust.trusted))} /></button></div>}
      </section>
      <section className="mt-[14px] rounded-md bg-bg-grouped p-card" aria-labelledby="system-prompt-title">
        <header className="flex items-center justify-between gap-5">
          <span className="min-w-0"><strong className="block text-body font-semibold text-label" id="system-prompt-title">{t("系统提示词")}</strong><small className="mt-[5px] block text-caption leading-normal text-label-2">{t("追加到 Pi 默认系统提示词，用于设置全局行为与回答偏好。")}</small></span>
          <span className={policyBadgeClass(true)}>{t("追加模式")}</span>
        </header>
        <label className="mt-[18px] block">
          <span className="mb-[7px] block text-caption font-semibold text-label-2">{t("自定义指令")}</span>
          <textarea
            className="min-h-[156px] w-full resize-y rounded-sm border border-separator bg-fill px-[13px] py-loose font-mono text-caption leading-[1.65] text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t("例如：默认使用简体中文回答；修改代码后运行相关测试。")}
            maxLength={100_000}
            disabled={saving}
            spellCheck={false}
          />
        </label>
        {error && <div className={settingsErrorClass} role="alert">{error}</div>}
        <footer className="mt-[14px] flex items-end justify-between gap-5">
          <small className="max-w-[34em] text-caption leading-normal text-label-2">{t(agentRunning ? "Agent 正在运行，结束当前任务后才能修改。" : "保存后会重启 Agent 会话，下一条消息立即生效。")}</small>
          <div className="flex flex-none gap-base">
            <button className={secondaryButtonClass} type="button" disabled={saving || !content} onClick={() => setContent("")}>{t("恢复默认")}</button>
            <button className={primaryButtonClass} type="button" disabled={saving || agentRunning || !changed} onClick={() => void save()}>{t(saving ? "保存中…" : "保存并重启 Agent")}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function AppearancePanel({ theme, onThemeChange }: Pick<SettingsViewProps, "theme" | "onThemeChange">) {
  const { t } = useI18n();
  return (
    <div className="w-full max-w-[760px]">
      <header className="mb-[27px] flex min-h-[62px] items-start justify-between gap-5"><div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("外观")}</h2><p className="text-body text-label-2">{t("选择适合当前环境的界面主题。")}</p></div></header>
      <section className="grid grid-cols-3 gap-[14px]">
        {(["system", "light", "dark"] as const).map((item) => (
          <button className={themeCardClass(theme === item)} key={item} type="button" onClick={() => onThemeChange(item)}>
            <span className={`grid h-[150px] grid-cols-[30%_1fr] overflow-hidden rounded-sm ${themePreviewVariantClass[item]}`}><i className="border-r" /><b className="px-[18px] py-[25px]"><em className="mb-[9px] block h-[7px] w-[42%] rounded-full" /><em className="mb-[9px] block h-[7px] w-[70%] rounded-full" /><em className="mb-[9px] block h-[7px] w-[70%] rounded-full" /></b></span>
            <span className="flex items-center justify-between px-1 pt-[11px] pb-0.5 text-caption font-semibold">{t(item === "system" ? "跟随系统" : item === "dark" ? "深色" : "浅色")}{theme === item && <Check size={14} />}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

export function SettingsView(props: SettingsViewProps) {
  const { t } = useI18n();
  return (
    <section className="grid h-[calc(100%-44px)] grid-cols-[304px_minmax(0,1fr)] bg-transparent [@media(max-width:1100px)]:grid-cols-[280px_minmax(0,1fr)]" aria-label={t("设置")}>
      <SettingsNavigation activeSection={props.activeSection} onBack={props.onBack} onSectionChange={props.onSectionChange} />
      <main className="min-w-0 overflow-y-auto bg-bg px-[64px] py-[46px] [@media(max-width:1100px)]:px-10 [@media(max-width:1100px)]:py-[38px]">
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

import * as Select from "@radix-ui/react-select";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  KeyRound,
  LockKeyhole,
  Palette,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelSettings, ProviderId, SaveModelSettings, ThinkingLevel } from "../contracts";
import type { SettingsSection, Theme } from "../types";

type SettingsViewProps = {
  activeSection: SettingsSection;
  settings: ModelSettings;
  theme: Theme;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onThemeChange: (theme: Theme) => void;
  onSave: (settings: SaveModelSettings) => Promise<void>;
  onTest: (settings: SaveModelSettings) => Promise<void>;
};

const sections: Array<{
  group: string;
  items: Array<{ id: SettingsSection; label: string; icon: typeof Sparkles }>;
}> = [
  { group: "AI", items: [{ id: "models", label: "大模型", icon: Sparkles }, { id: "permissions", label: "权限", icon: LockKeyhole }] },
  { group: "应用", items: [{ id: "general", label: "通用", icon: Settings2 }, { id: "appearance", label: "外观", icon: Palette }] },
];

const providerDefaults: Record<ProviderId, { baseUrl: string; modelId: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", modelId: "claude-sonnet-4-6" },
  openai: { baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.4" },
  "openai-compatible": { baseUrl: "http://127.0.0.1:11434/v1", modelId: "qwen3-coder" },
};

const modelPresets: Record<ProviderId, Array<{ id: string; description: string }>> = {
  anthropic: [
    { id: "claude-sonnet-4-6", description: "日常编码、工具调用与复杂推理的均衡选择。" },
    { id: "claude-opus-4-6", description: "适合大型代码库与高难度任务。" },
    { id: "claude-opus-4-7", description: "Anthropic 最新 Opus 模型入口。" },
  ],
  openai: [
    { id: "gpt-5.4", description: "通用 Agent 与编码任务。" },
    { id: "gpt-5.4-mini", description: "更低延迟与成本。" },
    { id: "gpt-5.3-codex", description: "面向软件工程的 Codex 模型。" },
  ],
  "openai-compatible": [],
};

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

function ProviderSelect({ value, onChange }: { value: ProviderId; onChange: (provider: ProviderId) => void }) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as ProviderId)}>
      <Select.Trigger className="select-trigger" aria-label="模型提供商"><Select.Value /><Select.Icon><ChevronDown size={14} /></Select.Icon></Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.Viewport>
            <Select.Item className="select-item" value="anthropic"><Select.ItemText>Anthropic</Select.ItemText><Select.ItemIndicator><Check size={13} /></Select.ItemIndicator></Select.Item>
            <Select.Item className="select-item" value="openai"><Select.ItemText>OpenAI</Select.ItemText><Select.ItemIndicator><Check size={13} /></Select.ItemIndicator></Select.Item>
            <Select.Item className="select-item" value="openai-compatible"><Select.ItemText>OpenAI Compatible</Select.ItemText><Select.ItemIndicator><Check size={13} /></Select.ItemIndicator></Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function ModelsPanel({ settings, onSave, onTest }: Pick<SettingsViewProps, "settings" | "onSave" | "onTest">) {
  const [form, setForm] = useState<SaveModelSettings>(() => editableSettings(settings));
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(editableSettings(settings)), [settings]);
  const presets = useMemo(() => modelPresets[form.provider], [form.provider]);
  const providerName = form.provider === "anthropic" ? "Anthropic" : form.provider === "openai" ? "OpenAI" : "OpenAI Compatible";
  const providerHasApiKey = settings.configuredProviders.includes(form.provider);

  function update<K extends keyof SaveModelSettings>(key: K, value: SaveModelSettings[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeProvider(provider: ProviderId) {
    setForm((current) => ({ ...current, provider, ...providerDefaults[provider], apiKey: "" }));
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

  return (
    <div className="settings-panel">
      <header className="settings-page-header">
        <div><h2>大模型</h2><p>真实配置 Pi Coding Agent 使用的提供商、端点、密钥与 thinking 级别。</p></div>
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("save")}>{busy === "save" ? "保存中…" : "保存设置"}</button>
      </header>

      <section className="provider-card">
        <header className="provider-heading">
          <span className="provider-logo">{providerName[0]}</span>
          <span><strong>{providerName}</strong><small>通过 Pi Coding Agent SDK 建立流式会话</small></span>
          <span className={`connection-status ${providerHasApiKey ? "" : "is-idle"}`}><i />{providerHasApiKey ? "已配置密钥" : "等待配置"}</span>
        </header>

        <div className="settings-form-grid">
          <label className="settings-field"><span>提供商</span><ProviderSelect value={form.provider} onChange={changeProvider} /></label>
          <label className="settings-field"><span>API 地址</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} spellCheck={false} /></label>
          <label className="settings-field"><span>模型 ID</span><input value={form.modelId} onChange={(event) => update("modelId", event.target.value)} spellCheck={false} placeholder="输入提供商的真实模型 ID" /></label>
          <label className="settings-field">
            <span>Thinking 级别</span>
            <select className="native-select" value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value as ThinkingLevel)}>
              <option value="off">关闭</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option>
            </select>
          </label>
          <label className="settings-field settings-field--full">
            <span>API Key</span>
            <div className="secret-input"><KeyRound size={14} /><input type="password" value={form.apiKey ?? ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={providerHasApiKey ? "已安全保存；留空则保持不变" : form.provider === "openai-compatible" ? "本地服务可留空" : "输入 API Key"} /><small>{providerHasApiKey ? "系统加密存储" : "未保存"}</small></div>
            <em>明文只提交给 Electron 主进程；持久化内容由操作系统安全存储加密，Renderer 无法读取。</em>
          </label>
        </div>
      </section>

      {presets.length > 0 && (
        <section className="default-model-section">
          <header><strong>模型预设</strong><small>也可以直接输入其他模型 ID</small></header>
          <div className="model-card-grid">
            {presets.map((model) => (
              <button className={`model-card ${model.id === form.modelId ? "is-selected" : ""}`} key={model.id} type="button" onClick={() => update("modelId", model.id)}>
                {model.id === form.modelId && <span className="model-check"><Check size={11} /></span>}
                <strong>{model.id}</strong><p>{model.description}</p>
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
        {props.activeSection === "models" && <ModelsPanel settings={props.settings} onSave={props.onSave} onTest={props.onTest} />}
        {props.activeSection === "permissions" && <PermissionsPanel />}
        {props.activeSection === "general" && <GeneralPanel />}
        {props.activeSection === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
      </main>
    </section>
  );
}

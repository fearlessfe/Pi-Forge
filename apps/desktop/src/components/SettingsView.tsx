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
import { modelOptions } from "../data";
import type { SettingsSection, Theme } from "../types";

type SettingsViewProps = {
  activeSection: SettingsSection;
  modelId: string;
  theme: Theme;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onModelChange: (modelId: string) => void;
  onThemeChange: (theme: Theme) => void;
  onSaved: () => void;
};

const sections: Array<{
  group: string;
  items: Array<{ id: SettingsSection; label: string; icon: typeof Sparkles }>;
}> = [
  {
    group: "AI",
    items: [
      { id: "models", label: "大模型", icon: Sparkles },
      { id: "permissions", label: "权限", icon: LockKeyhole },
    ],
  },
  {
    group: "应用",
    items: [
      { id: "general", label: "通用", icon: Settings2 },
      { id: "appearance", label: "外观", icon: Palette },
    ],
  },
];

function SettingsNavigation({
  activeSection,
  onBack,
  onSectionChange,
}: Pick<SettingsViewProps, "activeSection" | "onBack" | "onSectionChange">) {
  return (
    <aside className="settings-sidebar">
      <button className="settings-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>返回对话</span>
      </button>
      <h1>设置</h1>
      {sections.map((section) => (
        <div className="settings-nav-group" key={section.group}>
          <span>{section.group}</span>
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`settings-nav-item ${activeSection === item.id ? "is-active" : ""}`}
                key={item.id}
                type="button"
                onClick={() => onSectionChange(item.id)}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

function ProviderSelect() {
  return (
    <Select.Root defaultValue="anthropic">
      <Select.Trigger className="select-trigger" aria-label="模型提供商">
        <Select.Value />
        <Select.Icon><ChevronDown size={14} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.Viewport>
            <Select.Item className="select-item" value="anthropic">
              <Select.ItemText>Anthropic</Select.ItemText>
              <Select.ItemIndicator><Check size={13} /></Select.ItemIndicator>
            </Select.Item>
            <Select.Item className="select-item" value="openai">
              <Select.ItemText>OpenAI</Select.ItemText>
              <Select.ItemIndicator><Check size={13} /></Select.ItemIndicator>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function ModelsPanel({ modelId, onModelChange, onSaved }: Pick<SettingsViewProps, "modelId" | "onModelChange" | "onSaved">) {
  return (
    <div className="settings-panel">
      <header className="settings-page-header">
        <div>
          <h2>大模型</h2>
          <p>配置提供商、密钥以及新对话默认使用的模型。</p>
        </div>
        <button className="primary-button" type="button" onClick={onSaved}>保存设置</button>
      </header>

      <section className="provider-card">
        <header className="provider-heading">
          <span className="provider-logo">A</span>
          <span><strong>Anthropic</strong><small>通过 Anthropic API 连接 Claude 模型</small></span>
          <span className="connection-status"><i />连接正常</span>
        </header>

        <div className="settings-form-grid">
          <label className="settings-field">
            <span>提供商</span>
            <ProviderSelect />
          </label>
          <label className="settings-field">
            <span>API 地址</span>
            <input defaultValue="https://api.anthropic.com" spellCheck={false} />
          </label>
          <label className="settings-field settings-field--full">
            <span>API Key</span>
            <div className="secret-input">
              <KeyRound size={14} />
              <code>sk-ant-api03-••••••••••••••F3a</code>
              <small>系统钥匙串</small>
            </div>
            <em>密钥仅保存在操作系统钥匙串中，Renderer 无法读取明文。</em>
          </label>
        </div>
      </section>

      <section className="default-model-section">
        <header><strong>默认模型</strong><small>新建对话时仍可临时切换</small></header>
        <div className="model-card-grid">
          {modelOptions.map((model) => (
            <button
              className={`model-card ${model.id === modelId ? "is-selected" : ""}`}
              key={model.id}
              type="button"
              onClick={() => onModelChange(model.id)}
            >
              {model.id === modelId && <span className="model-check"><Check size={11} /></span>}
              <strong>{model.name}</strong>
              <p>{model.description}</p>
            </button>
          ))}
        </div>
      </section>

      <footer className="settings-panel-footer">
        <button className="secondary-button" type="button">验证连接</button>
        <span>上次验证：刚刚</span>
        <small>密钥不会出现在日志中</small>
      </footer>
    </div>
  );
}

function PermissionsPanel() {
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>权限</h2><p>控制 Agent 访问文件、执行命令和连接网络时的默认策略。</p></div></header>
      <section className="simple-settings-card">
        <div className="settings-toggle-row"><span><strong>工作区外文件访问</strong><small>每次访问选定目录以外的文件时询问</small></span><span className="policy-badge">始终询问</span></div>
        <div className="settings-toggle-row"><span><strong>外部网络访问</strong><small>请求连接外部服务时显示目标和影响</small></span><span className="policy-badge">始终询问</span></div>
        <div className="settings-toggle-row"><span><strong>安全的只读命令</strong><small>允许在工作区内自动执行查询类命令</small></span><button className="switch is-on" type="button" aria-label="启用安全的只读命令"><i /></button></div>
      </section>
    </div>
  );
}

function GeneralPanel() {
  return (
    <div className="settings-panel compact-settings-panel">
      <header className="settings-page-header"><div><h2>通用</h2><p>调整 Pi Desktop 的会话和系统行为。</p></div></header>
      <section className="simple-settings-card">
        <div className="settings-toggle-row"><span><strong>任务完成时通知</strong><small>应用不在前台时发送系统通知</small></span><button className="switch is-on" type="button"><i /></button></div>
        <div className="settings-toggle-row"><span><strong>自动恢复会话</strong><small>启动应用时恢复上次打开的对话</small></span><button className="switch is-on" type="button"><i /></button></div>
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
        {props.activeSection === "models" && <ModelsPanel modelId={props.modelId} onModelChange={props.onModelChange} onSaved={props.onSaved} />}
        {props.activeSection === "permissions" && <PermissionsPanel />}
        {props.activeSection === "general" && <GeneralPanel />}
        {props.activeSection === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
      </main>
    </section>
  );
}

import { AlertTriangle, BookOpen, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ResourceInventory } from "../contracts";
import { useI18n } from "../i18n";

type SkillsPanelProps = {
  cwd?: string;
  agentRunning: boolean;
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

/* 设置面板共享工具类组合（token v2，docs-internal/design-refresh-apple.md 3.2/3.5），与 D3-1 SettingsView 同一语言。 */
const secondaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const settingsErrorClass = "mt-loose rounded-sm border border-red/32 bg-red/8 px-loose py-loose text-caption text-red";
const permissionNoteClass = "mt-loose mr-0.5 ml-0.5 text-caption leading-[1.55] text-orange";
const switchClass = (on: boolean) =>
  on
    ? "relative h-5 w-9 cursor-pointer rounded-full bg-accent p-0.5 transition-colors duration-150 ease-apple before:absolute before:-inset-1 before:content-[''] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
    : "relative h-5 w-9 cursor-pointer rounded-full bg-fill-2 p-0.5 transition-colors duration-150 ease-apple before:absolute before:-inset-1 before:content-[''] hover:bg-fill-3 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const switchKnobClass = (on: boolean) =>
  on
    ? "block size-4 translate-x-4 rounded-full border border-separator bg-knob shadow-1 transition-transform duration-150 ease-apple"
    : "block size-4 rounded-full border border-separator bg-knob shadow-1 transition-transform duration-150 ease-apple";
const skillRowClass = (enabled: boolean) =>
  enabled
    ? "flex items-center gap-loose rounded-md border border-accent/32 bg-bg-grouped p-3"
    : "flex items-center gap-loose rounded-md border border-separator bg-bg-grouped p-3 opacity-40";

export function SkillsPanel({ cwd, agentRunning }: SkillsPanelProps) {
  const { t } = useI18n();
  const [inventory, setInventory] = useState<ResourceInventory>();
  const [query, setQuery] = useState("");
  const [settingScope, setSettingScope] = useState<"user" | "project">(cwd ? "project" : "user");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");

  async function refresh() {
    if (!window.piDesktop?.resources) return;
    setBusy("refresh");
    setError("");
    try {
      setInventory(await window.piDesktop.resources.inventory(cwd));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => {
    setSettingScope(cwd ? "project" : "user");
    void refresh();
  }, [cwd]);

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return inventory?.skills ?? [];
    return (inventory?.skills ?? []).filter((skill) => [skill.name, skill.description, skill.filePath, skill.source]
      .some((value) => value.toLocaleLowerCase().includes(normalized)));
  }, [inventory, query]);

  async function toggle(name: string, enabled: boolean) {
    if (!window.piDesktop?.resources) return;
    setBusy(name);
    setError("");
    try {
      setInventory(await window.piDesktop.resources.setSkillEnabled(name, enabled, cwd, settingScope));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="grid w-full max-w-[980px] content-start gap-3">
      <header className="mb-card flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("Skills")}</h2><p className="text-body text-label-2">{t("查看 Agent 当前可发现的技能、来源和诊断，并控制是否启用。")}</p></div>
        <button className={secondaryButtonClass} type="button" disabled={Boolean(busy) || agentRunning} onClick={() => void refresh()}><RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={14} />{t("重新加载")}</button>
      </header>

      <label className="flex items-center gap-base rounded-md border border-separator bg-bg-grouped px-3 text-label-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/32"><Search size={14} /><input className="h-control-lg w-full border-0 bg-transparent text-body text-label outline-none placeholder:text-label-3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索 Skill、描述或来源")} /></label>

      <section className="flex items-center justify-between gap-card rounded-md border border-separator bg-bg-grouped px-card py-loose">
        <span><strong className="block text-body font-semibold text-label">{t("启用范围")}</strong><small className="mt-tight block text-caption text-label-3">{t(settingScope === "project" ? "只调整当前项目；未覆盖的 Skill 继承全局设置。" : "调整所有项目的全局 Skill 开关。")}</small></span>
        <span className="inline-flex rounded-sm border border-separator bg-bg p-tight">{cwd && <button className={settingScope === "project" ? "h-control-md rounded-sm bg-accent px-loose text-caption font-semibold text-white" : "h-control-md rounded-sm px-loose text-caption font-semibold text-label-2"} type="button" onClick={() => setSettingScope("project")}>{t("当前项目")}</button>}<button className={settingScope === "user" ? "h-control-md rounded-sm bg-accent px-loose text-caption font-semibold text-white" : "h-control-md rounded-sm px-loose text-caption font-semibold text-label-2"} type="button" onClick={() => setSettingScope("user")}>{t("所有项目")}</button></span>
      </section>

      {inventory && (
        <div className="flex items-center gap-base">
          <span className="min-w-[70px] rounded-sm border border-separator bg-bg-grouped px-loose py-base"><strong className="block text-body font-semibold text-label">{inventory.skills.filter((skill) => settingScope === "project" ? skill.enabled : skill.globalEnabled).length}</strong><small className="block text-caption text-label-3">{t("已启用")}</small></span>
          <span className="min-w-[70px] rounded-sm border border-separator bg-bg-grouped px-loose py-base"><strong className="block text-body font-semibold text-label">{inventory.skills.length}</strong><small className="block text-caption text-label-3">{t("已发现")}</small></span>
          <span className="min-w-[70px] rounded-sm border border-separator bg-bg-grouped px-loose py-base"><strong className="block text-body font-semibold text-label">{inventory.diagnostics.length}</strong><small className="block text-caption text-label-3">{t("诊断")}</small></span>
          <code className="ml-auto min-w-0 truncate font-mono text-caption text-label-3" title={inventory.cwd}>{inventory.cwd}</code>
        </div>
      )}

      {inventory?.diagnostics.length ? <section className="grid gap-base">
        {inventory.diagnostics.map((diagnostic, index) => <div className="flex items-start gap-base rounded-sm border border-orange/32 bg-orange/8 px-loose py-base text-caption text-orange" key={`${diagnostic.path}:${index}`}><AlertTriangle size={14} className="mt-0.5 flex-none" /><span><strong className="mr-base uppercase">{diagnostic.type}</strong>{diagnostic.message}<small className="block text-label-3">{diagnostic.path}</small></span></div>)}
      </section> : null}

      <section className="grid gap-base">
        {visibleSkills.map((skill) => {
          const selectedEnabled = settingScope === "project" ? skill.projectEnabled !== false : skill.globalEnabled;
          const displayEnabled = settingScope === "project" ? skill.enabled : skill.globalEnabled;
          return (
            <article className={skillRowClass(displayEnabled)} key={`${skill.source}:${skill.filePath}`}>
              <span className="grid size-8 flex-none place-items-center rounded-sm bg-accent/8 text-accent"><BookOpen size={16} /></span>
              <span className="min-w-0 flex-1"><strong className="block text-body font-semibold text-label">{skill.name}</strong><p className="mt-1 mb-base text-caption leading-[1.45] text-label-2">{skill.description}</p><small className="block truncate text-caption text-label-3" title={skill.filePath}>{skill.scope} · {skill.sourceKind} · {skill.filePath}</small></span>
              <span className="flex gap-tight">{settingScope === "project" && !skill.globalEnabled && <em className="rounded-full border border-orange/32 px-base py-tight text-mini not-italic text-orange">{t("全局已停用")}</em>}{!skill.modelInvocable && <em className="rounded-full border border-separator px-base py-tight text-mini not-italic text-label-3">{t("仅命令")}</em>}<em className="rounded-full border border-separator px-base py-tight text-mini not-italic text-label-3">{skill.scope}</em></span>
              <button className={switchClass(selectedEnabled)} type="button" disabled={agentRunning || Boolean(busy) || (settingScope === "project" && !skill.globalEnabled)} aria-pressed={selectedEnabled} aria-label={t(selectedEnabled ? "停用 {name}" : "启用 {name}", { name: skill.name })} onClick={() => void toggle(skill.name, !selectedEnabled)}><i className={switchKnobClass(selectedEnabled)} /></button>
            </article>
          );
        })}
        {!busy && visibleSkills.length === 0 && <div className="grid min-h-[180px] place-items-center content-center gap-base text-caption text-label-3"><BookOpen size={18} /><strong className="text-label-2">{t("没有找到 Skills")}</strong><span>{t(query ? "换个关键词试试。" : "当前范围没有可用的 Skill。")}</span></div>}
      </section>
      {agentRunning && <p className={permissionNoteClass}>{t("任务运行期间不能修改 Skills。")}</p>}
      {error && <div className={settingsErrorClass} role="alert">{error}</div>}
    </div>
  );
}

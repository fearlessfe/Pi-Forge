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

export function SkillsPanel({ cwd, agentRunning }: SkillsPanelProps) {
  const { t } = useI18n();
  const [inventory, setInventory] = useState<ResourceInventory>();
  const [query, setQuery] = useState("");
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

  useEffect(() => { void refresh(); }, [cwd]);

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
      setInventory(await window.piDesktop.resources.setSkillEnabled(name, enabled, cwd));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="settings-panel skills-panel">
      <header className="settings-page-header skills-header">
        <div><h2>{t("Skills")}</h2><p>{t("查看 Agent 当前可发现的技能、来源和诊断，并控制是否启用。")}</p></div>
        <button className="secondary-button" type="button" disabled={Boolean(busy) || agentRunning} onClick={() => void refresh()}><RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={13} />{t("重新加载")}</button>
      </header>

      <label className="skills-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索 Skill、描述或来源")} /></label>

      {inventory && (
        <div className="skills-summary">
          <span><strong>{inventory.skills.filter((skill) => skill.enabled).length}</strong><small>{t("已启用")}</small></span>
          <span><strong>{inventory.skills.length}</strong><small>{t("已发现")}</small></span>
          <span><strong>{inventory.diagnostics.length}</strong><small>{t("诊断")}</small></span>
          <code title={inventory.cwd}>{inventory.cwd}</code>
        </div>
      )}

      {inventory?.diagnostics.length ? <section className="skills-diagnostics">
        {inventory.diagnostics.map((diagnostic, index) => <div key={`${diagnostic.path}:${index}`}><AlertTriangle size={13} /><span><strong>{diagnostic.type}</strong>{diagnostic.message}<small>{diagnostic.path}</small></span></div>)}
      </section> : null}

      <section className="skills-list">
        {visibleSkills.map((skill) => (
          <article className={skill.enabled ? "is-enabled" : ""} key={`${skill.source}:${skill.filePath}`}>
            <span className="skill-icon"><BookOpen size={16} /></span>
            <span className="skill-copy"><strong>{skill.name}</strong><p>{skill.description}</p><small title={skill.filePath}>{skill.scope} · {skill.sourceKind} · {skill.filePath}</small></span>
            <span className="skill-flags">{!skill.modelInvocable && <em>{t("仅命令")}</em>}<em>{skill.scope}</em></span>
            <button className={`switch ${skill.enabled ? "is-on" : ""}`} type="button" disabled={agentRunning || Boolean(busy)} aria-pressed={skill.enabled} aria-label={t(skill.enabled ? "停用 {name}" : "启用 {name}", { name: skill.name })} onClick={() => void toggle(skill.name, !skill.enabled)}><i /></button>
          </article>
        ))}
        {!busy && visibleSkills.length === 0 && <div className="skills-empty"><BookOpen size={20} /><strong>{t("没有找到 Skills")}</strong><span>{t(query ? "换个关键词试试。" : "当前范围没有可用的 Skill。")}</span></div>}
      </section>
      {agentRunning && <p className="permission-inline-note">{t("任务运行期间不能修改 Skills。")}</p>}
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
}

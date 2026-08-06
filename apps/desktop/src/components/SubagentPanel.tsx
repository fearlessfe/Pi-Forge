import { CirclePause, CirclePlay, History, RefreshCw, RotateCcw, Square, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SubagentRunInfo } from "../contracts";
import { useI18n } from "../i18n";

type SubagentPanelProps = {
  conversationId?: string | null;
  onHandoff(result: string): void;
};

const statusTone: Record<SubagentRunInfo["status"], string> = {
  queued: "text-orange",
  running: "text-accent",
  paused: "text-orange",
  completed: "text-green",
  error: "text-red",
  stopped: "text-label-3",
};
const statusLabel: Record<SubagentRunInfo["status"], string> = {
  queued: "排队中", running: "运行中", paused: "已暂停", completed: "已完成", error: "失败", stopped: "已停止",
};

export function SubagentPanel({ conversationId, onHandoff }: SubagentPanelProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<SubagentRunInfo[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const api = window.piDesktop?.agent;
    if (!api?.listSubagents) return;
    try {
      setRuns(await api.listSubagents());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [open, refresh]);

  async function mutate(id: string, action: "pause" | "resume" | "retry" | "stop") {
    const api = window.piDesktop?.agent;
    const operation = action === "pause" ? api?.pauseSubagent
      : action === "resume" ? api?.resumeSubagent
        : action === "retry" ? api?.retrySubagent
          : api?.stopSubagent;
    if (!operation) return;
    setBusy(id);
    try {
      await operation(id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function handoff(run: SubagentRunInfo) {
    if (!conversationId || !window.piDesktop?.agent.prepareSubagentHandoff) return;
    setBusy(run.id);
    try {
      onHandoff(await window.piDesktop.agent.prepareSubagentHandoff(run.id, conversationId));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return <div className="absolute top-[10px] right-[14px] z-20">
    <button className="inline-flex h-control-md cursor-pointer items-center gap-base rounded-sm border border-separator bg-bg-grouped px-loose text-caption text-label-2 shadow-1 transition-colors hover:bg-fill" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={t("后台子 Agent")}>
      <Users size={14} />{t("后台子 Agent")}
      {runs.some((run) => run.status === "running" || run.status === "queued") && <span className="size-2 rounded-full bg-accent animate-pulse" />}
    </button>
    {open && <aside className="mt-base grid max-h-[min(640px,calc(100vh-90px))] w-[min(440px,calc(100vw-28px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-separator bg-bg-grouped shadow-3" aria-label={t("子 Agent 历史与状态")}>
      <header className="flex min-h-[48px] items-center gap-base border-b border-separator px-loose">
        <History size={15} className="text-accent" /><strong className="text-callout text-label">{t("子 Agent 历史与状态")}</strong>
        <button className="ml-auto grid size-control-sm cursor-pointer place-items-center rounded-sm text-label-3 hover:bg-fill" type="button" onClick={() => void refresh()} aria-label={t("刷新")}><RefreshCw size={14} /></button>
        <button className="grid size-control-sm cursor-pointer place-items-center rounded-sm text-label-3 hover:bg-fill" type="button" onClick={() => setOpen(false)} aria-label={t("关闭")}><X size={15} /></button>
      </header>
      <div className="min-h-0 overflow-auto p-base">
        {error && <p className="m-0 mb-base rounded-sm border border-red/24 bg-red/8 p-base text-caption text-red">{error}</p>}
        {runs.length === 0 ? <p className="m-0 p-loose text-center text-caption text-label-3">{t("还没有后台子 Agent 任务。")}</p> : <div className="grid gap-base">
          {runs.map((run) => <article className="grid gap-base rounded-md border border-separator bg-bg p-loose" key={run.id}>
            <div className="flex min-w-0 items-center gap-base"><strong className="truncate text-callout text-label">{run.role}</strong><span className={`ml-auto shrink-0 font-mono text-caption ${statusTone[run.status]}`}>{t(statusLabel[run.status])}</span></div>
            <p className="m-0 line-clamp-3 text-caption leading-relaxed text-label-2">{run.task}</p>
            {(run.result || run.error) && <pre className={`m-0 max-h-36 overflow-auto whitespace-pre-wrap rounded-sm bg-bg-grouped p-base font-mono text-caption leading-relaxed ${run.error ? "text-red" : "text-label-2"}`}>{run.error || run.result}</pre>}
            <div className="flex flex-wrap items-center gap-tight text-caption text-label-3">
              <time>{new Date(run.updatedAt).toLocaleString(locale)}</time><span>·</span><span>{t("尝试 {count} 次", { count: run.attempt })}</span>
              <div className="ml-auto flex items-center gap-tight">
                {run.status === "running" && <button className="grid size-control-sm cursor-pointer place-items-center rounded-sm hover:bg-fill" disabled={busy === run.id} type="button" onClick={() => void mutate(run.id, "pause")} aria-label={t("暂停")}><CirclePause size={14} /></button>}
                {run.status === "paused" && <button className="grid size-control-sm cursor-pointer place-items-center rounded-sm hover:bg-fill" disabled={busy === run.id} type="button" onClick={() => void mutate(run.id, "resume")} aria-label={t("继续")}><CirclePlay size={14} /></button>}
                {(run.status === "error" || run.status === "stopped") && <button className="grid size-control-sm cursor-pointer place-items-center rounded-sm hover:bg-fill" disabled={busy === run.id} type="button" onClick={() => void mutate(run.id, "retry")} aria-label={t("重试")}><RotateCcw size={14} /></button>}
                {(run.status === "queued" || run.status === "running" || run.status === "paused") && <button className="grid size-control-sm cursor-pointer place-items-center rounded-sm text-red hover:bg-red/8" disabled={busy === run.id} type="button" onClick={() => void mutate(run.id, "stop")} aria-label={t("停止")}><Square size={13} /></button>}
                {run.status === "completed" && run.result && run.parentConversationId === conversationId && <button className="inline-flex h-control-sm cursor-pointer items-center gap-tight rounded-sm border border-separator px-base text-caption text-label-2 hover:bg-fill disabled:opacity-40" disabled={busy === run.id} type="button" onClick={() => void handoff(run)}>{t("移交到输入框")}</button>}
              </div>
            </div>
          </article>)}
        </div>}
      </div>
    </aside>}
  </div>;
}

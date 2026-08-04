import { Check, MessageSquarePlus, RotateCcw, ShieldCheck } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PlanReviewArtifact, PlanReviewDecision, ResolvePlanReviewInput } from "../contracts";
import { useI18n } from "../i18n";
import { planReviewBlocks } from "../plan-review";

type PlanReviewPanelProps = {
  reviews: PlanReviewArtifact[];
  onResolve: (input: ResolvePlanReviewInput) => Promise<void>;
};

const actionButton = "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/32";

function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n();
  const id = `plan-mermaid-${useId().replace(/[^a-z0-9_-]/gi, "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", suppressErrorRendering: true });
      const rendered = await mermaid.render(id, code);
      if (!cancelled) setSvg(rendered.svg);
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { cancelled = true; };
  }, [code, id]);
  if (error) return <pre className="overflow-auto rounded-sm border border-orange/32 bg-orange/8 p-loose text-caption text-orange" role="status"><code>{code}</code><span className="mt-base block">{t("Mermaid 渲染失败：{message}", { message: error })}</span></pre>;
  if (!svg) return <div className="rounded-sm border border-dashed border-separator p-loose text-caption text-label-3" role="status">{t("正在渲染 Mermaid…")}</div>;
  return <div className="overflow-auto rounded-sm border border-separator bg-white p-loose [&_svg]:mx-auto [&_svg]:max-w-full" role="img" aria-label={t("计划 Mermaid 图")} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const markdownComponents = {
  code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
    const code = String(children).replace(/\n$/, "");
    return className === "language-mermaid" ? <MermaidDiagram code={code} /> : <code className={className} {...props}>{children}</code>;
  },
};

function statusLabel(status: PlanReviewArtifact["status"]): string {
  return status === "approved" ? "已批准" : status === "changes_requested" ? "已要求修改" : "等待审阅";
}

function PlanReviewCard({ review, onResolve }: { review: PlanReviewArtifact; onResolve: PlanReviewPanelProps["onResolve"] }) {
  const { t } = useI18n();
  const [selectedVersionId, setSelectedVersionId] = useState(review.activeVersionId);
  const [selectedAnchor, setSelectedAnchor] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<PlanReviewDecision>();
  const [error, setError] = useState("");
  useEffect(() => { setSelectedVersionId(review.activeVersionId); setSelectedAnchor(undefined); setDrafts({}); }, [review.activeVersionId]);
  const version = review.versions.find((entry) => entry.id === selectedVersionId) ?? review.versions.at(-1);
  const blocks = useMemo(() => planReviewBlocks(version?.markdown ?? ""), [version?.markdown]);
  if (!version) return null;
  const editable = review.status === "pending" && version.id === review.activeVersionId;
  const annotationByAnchor = new Map(version.annotations.map((annotation) => [annotation.anchorId, annotation]));
  const comments = Object.values(drafts).filter((comment) => comment.trim()).length;

  const resolve = async (decision: PlanReviewDecision) => {
    setBusy(decision);
    setError("");
    try {
      await onResolve({
        reviewId: review.id,
        versionId: version.id,
        decision,
        annotations: blocks.flatMap((block) => drafts[block.id]?.trim() ? [{ anchorId: block.id, quote: block.quote, comment: drafts[block.id].trim() }] : []),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  return <article className="overflow-hidden rounded-md border border-accent/24 bg-bg-grouped shadow-1" aria-labelledby={`plan-review-${review.id}`}>
    <header className="flex flex-wrap items-start justify-between gap-card border-b border-separator bg-accent/8 px-card py-loose">
      <span className="min-w-0"><small className="text-mini font-semibold uppercase tracking-[0.08em] text-accent">{t("计划 Artifact")}</small><h3 className="mt-tight truncate text-title font-semibold text-label" id={`plan-review-${review.id}`}>{review.title}</h3><p className="mt-tight text-caption text-label-3">{t("批准计划不会自动批准 Shell、网络或文件越界操作。")}</p></span>
      <span className={review.status === "approved" ? "rounded-full border border-green/32 bg-green/8 px-base py-base text-caption text-green" : review.status === "changes_requested" ? "rounded-full border border-orange/32 bg-orange/8 px-base py-base text-caption text-orange" : "rounded-full border border-accent/32 bg-accent/8 px-base py-base text-caption text-accent"}>{t(statusLabel(review.status))}</span>
    </header>
    <nav className="flex gap-base overflow-x-auto border-b border-separator px-card py-base" aria-label={t("计划版本")}>{review.versions.map((entry) => <button className={entry.id === version.id ? "rounded-full bg-accent px-base py-base text-caption font-semibold text-accent-ink" : "cursor-pointer rounded-full bg-fill px-base py-base text-caption text-label-2 hover:bg-fill-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/32"} type="button" key={entry.id} onClick={() => { setSelectedVersionId(entry.id); setSelectedAnchor(undefined); }}>{`v${entry.number}`}</button>)}</nav>
    <div className="grid gap-base p-card">
      {blocks.map((block) => {
        const annotation = annotationByAnchor.get(block.id);
        const editing = editable && selectedAnchor === block.id;
        return <section className={editing ? "rounded-sm border border-accent/40 bg-accent/8 p-loose" : "group rounded-sm border border-transparent p-loose hover:border-separator hover:bg-fill"} key={block.id}>
          <div className="flex items-start gap-base"><div className="markdown-content min-w-0 flex-1 text-body leading-[1.7] text-label-2"><Markdown components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml>{block.markdown}</Markdown></div>{editable && <button className="invisible inline-flex size-control-md flex-none cursor-pointer items-center justify-center rounded-sm text-label-3 hover:bg-fill-2 hover:text-accent focus:visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/32 group-hover:visible" type="button" aria-label={t("为此段添加批注")} aria-pressed={editing} onClick={() => setSelectedAnchor(editing ? undefined : block.id)}><MessageSquarePlus size={15} /></button>}</div>
          {annotation && <blockquote className="mt-base rounded-sm border-l-2 border-orange bg-orange/8 px-loose py-base text-caption text-label-2"><strong className="text-orange">{t("批注")}</strong><p className="mt-tight whitespace-pre-wrap">{annotation.comment}</p></blockquote>}
          {editing && <label className="mt-base block text-caption font-semibold text-label-2">{t("对此段的修改建议")}<textarea className="mt-base min-h-[88px] w-full resize-y rounded-sm border border-separator bg-bg px-loose py-base text-body font-normal text-label outline-none focus:border-accent focus:ring-2 focus:ring-accent/16" maxLength={4000} value={drafts[block.id] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [block.id]: event.target.value }))} autoFocus /></label>}
        </section>;
      })}
    </div>
    {error && <div className="mx-card mb-base rounded-sm border border-red/32 bg-red/8 px-loose py-base text-caption text-red" role="alert">{error}</div>}
    {editable && <footer className="flex flex-wrap items-center justify-between gap-base border-t border-separator px-card py-loose"><span className="text-caption text-label-3" aria-live="polite">{comments > 0 ? t("已添加 {count} 条批注", { count: comments }) : t("点击段落旁的批注按钮提出修改。")}</span><span className="flex gap-base"><button className={actionButton} type="button" disabled={busy !== undefined || comments === 0} onClick={() => void resolve("changes_requested")}><RotateCcw size={14} />{t("要求修改")}</button><button className={`${actionButton} border-accent/32 bg-accent text-accent-ink hover:bg-accent-hover`} type="button" disabled={busy !== undefined} onClick={() => void resolve("approved")}><ShieldCheck size={14} />{t("批准计划")}</button></span></footer>}
    {!editable && version.decision && <footer className="flex items-center gap-base border-t border-separator px-card py-loose text-caption text-label-2"><Check size={14} className={version.decision === "approved" ? "text-green" : "text-orange"} />{t(version.decision === "approved" ? "此版本已批准" : "此版本已返回修改")}</footer>}
  </article>;
}

export function PlanReviewPanel({ reviews, onResolve }: PlanReviewPanelProps) {
  if (reviews.length === 0) return null;
  return <section className="mx-auto grid w-[min(860px,100%)] gap-loose px-card py-loose" aria-label="Plan review">{reviews.map((review) => <PlanReviewCard key={review.id} review={review} onResolve={onResolve} />)}</section>;
}

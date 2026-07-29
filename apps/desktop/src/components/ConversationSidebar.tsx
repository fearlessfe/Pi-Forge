import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Folder,
  FileJson,
  FileText,
  GitFork,
  MessageSquare,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { shortcutLabel } from "../keyboard";
import { useI18n } from "../i18n";
import type { Conversation, Project } from "../types";
import { BrandMark } from "./BrandMark";

const iconButtonClass = "grid size-control-sm cursor-pointer place-items-center rounded-sm text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label-2 active:bg-fill-2 active:scale-[0.98]";
const sectionTitleClass = "flex h-control-sm items-center justify-between px-loose text-caption font-semibold text-label-3";
const sidebarEmptyClass = "text-caption leading-normal text-label-3";
const menuItemClass = "dropdown-item flex min-h-control-md items-center gap-base rounded-sm px-loose text-caption";

function primaryNavItemClass(active: boolean, collapsed: boolean) {
  return `flex h-control-lg cursor-pointer items-center gap-loose rounded-md text-callout transition-colors duration-150 ease-apple ${active ? "bg-accent/16 text-label" : "text-label-2 hover:bg-fill active:bg-fill-2 active:scale-[0.98]"} ${collapsed ? "justify-center px-0" : "px-loose"}`;
}

type ConversationSidebarProps = {
  activePrimary: "chat" | "plugins";
  collapsed: boolean;
  conversations: Conversation[];
  projects: Project[];
  selectedConversationId: string | null;
  searchRequest: number;
  onToggleCollapsed: () => void;
  onSelectConversation: (conversationId: string, project?: Project) => void;
  onNewChat: () => void;
  onNewProjectChat: (project: Project) => void;
  onRenameConversation: (conversationId: string, title: string, project?: Project) => Promise<void>;
  onForkConversation: (conversationId: string, project?: Project) => Promise<void>;
  onExportConversation: (conversationId: string, format: "markdown" | "json") => Promise<void>;
  onSetConversationArchived: (conversationId: string, archived: boolean) => Promise<void>;
  onSetConversationTags: (conversationId: string, tags: string[]) => Promise<void>;
  onDeleteConversation: (conversationId: string, project?: Project) => Promise<void>;
  conversationActionsDisabled: boolean;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onOpenPet: () => void;
};

function matchesConversation(conversation: Conversation, query: string) {
  return [conversation.title, conversation.subtitle, conversation.searchText, ...conversation.tags].some((value) => value.toLocaleLowerCase().includes(query));
}

function ConversationRow({
  conversation,
  project,
  selected,
  actionsDisabled,
  onSelect,
  onRename,
  onFork,
  onExport,
  onSetArchived,
  onSetTags,
  onDelete,
}: {
  conversation: Conversation;
  project?: Project;
  selected: boolean;
  actionsDisabled: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onFork: () => Promise<void>;
  onExport: (format: "markdown" | "json") => Promise<void>;
  onSetArchived: (archived: boolean) => Promise<void>;
  onSetTags: (tags: string[]) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const rowClassName = `group grid min-h-[43px] w-full grid-cols-[minmax(0,1fr)_28px] items-center gap-px rounded-md px-1 py-0.5 text-left transition-colors duration-150 ease-apple ${selected ? "bg-accent/16 text-label" : "text-label-2 hover:bg-fill active:bg-fill-2 active:scale-[0.98]"}${project ? " relative before:absolute before:-left-[13px] before:top-[21px] before:h-px before:w-[9px] before:bg-separator before:content-['']" : ""}`;

  useEffect(() => {
    if (!editing) setTitle(conversation.title);
  }, [conversation.title, editing]);

  if (editing) {
    return (
      <form className={`grid min-h-[43px] w-full grid-cols-[18px_minmax(0,1fr)_28px_28px] items-center gap-tight rounded-md bg-fill-2 px-[6px] py-[5px]${project ? " relative before:absolute before:-left-[13px] before:top-[21px] before:h-px before:w-[9px] before:bg-separator before:content-['']" : ""}`} onSubmit={(event) => {
        event.preventDefault();
        const nextTitle = title.trim().replace(/\s+/g, " ");
        if (!nextTitle || saving) return;
        setSaving(true);
        void onRename(nextTitle).then(() => setEditing(false)).catch(() => {}).finally(() => setSaving(false));
      }}>
        <MessageSquare size={14} className="text-accent" />
        <input
          autoFocus
          className="h-control-sm min-w-0 rounded-sm border border-separator bg-bg px-2 text-caption text-label outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/32"
          value={title}
          maxLength={60}
          aria-label={t("重命名“{title}”", { title: conversation.title })}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setTitle(conversation.title);
              setEditing(false);
            }
          }}
        />
        <button type="submit" className="grid size-control-sm cursor-pointer place-items-center rounded-sm text-accent transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" aria-label={t("保存名称")} disabled={!title.trim() || saving}><Check size={14} /></button>
        <button type="button" className="grid size-control-sm cursor-pointer place-items-center rounded-sm text-label-3 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" aria-label={t("取消重命名")} disabled={saving} onClick={() => { setTitle(conversation.title); setEditing(false); }}><X size={14} /></button>
      </form>
    );
  }

  return (
    <div className={rowClassName}>
      <button className="grid min-h-[37px] min-w-0 cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-base px-[6px] py-[5px] text-left" type="button" onClick={onSelect}>
        <MessageSquare size={14} className="text-label-3" />
        <span className="min-w-0">
          <strong className="block truncate text-callout font-medium">{conversation.title}</strong>
          <small className="mt-tight block truncate font-mono text-caption text-label-3">{conversation.tags.length > 0 ? `${conversation.subtitle} · ${conversation.tags.join(" · ")}` : conversation.subtitle}</small>
        </span>
        <time className="font-mono text-caption text-label-3">{conversation.updatedAt}</time>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="grid size-control-sm cursor-pointer place-items-center rounded-sm text-label-3 opacity-0 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:bg-fill-2 data-[state=open]:text-label data-[state=open]:opacity-100 disabled:opacity-40"
            type="button"
            aria-label={t("管理“{title}”", { title: conversation.title })}
            title={t(actionsDisabled ? "Agent 运行中暂不可管理会话" : "管理会话")}
            disabled={actionsDisabled}
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content w-40" side="right" align="start" sideOffset={6}>
            <DropdownMenu.Item className={`${menuItemClass} text-label-2`} onSelect={() => setEditing(true)}>
              <Pencil size={14} /><span>{t("重命名")}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItemClass} text-label-2`} onSelect={() => void onFork()}>
              <GitFork size={14} /><span>{t("Fork 会话")}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItemClass} text-label-2`} onSelect={() => {
              const value = window.prompt(t("输入标签，用逗号分隔（最多 8 个）"), conversation.tags.join(", "));
              if (value !== null) void onSetTags(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean));
            }}>
              <Tags size={14} /><span>{t("编辑标签")}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItemClass} text-label-2`} onSelect={() => void onExport("markdown")}>
              <FileText size={14} /><span>{t("导出 Markdown")}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItemClass} text-label-2`} onSelect={() => void onExport("json")}>
              <FileJson size={14} /><span>{t("导出 JSON")}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItemClass} text-label-2`} onSelect={() => void onSetArchived(!conversation.archived)}>
              {conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}<span>{t(conversation.archived ? "恢复会话" : "归档会话")}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItemClass} text-red`} onSelect={() => {
              if (window.confirm(t("确定删除“{title}”吗？此操作不可恢复。", { title: conversation.title }))) void onDelete();
            }}>
              <Trash2 size={14} /><span>{t("删除对话")}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function ProjectGroup({
  project,
  forceOpen,
  selectedConversationId,
  onSelectConversation,
  onNewProjectChat,
  onRenameConversation,
  onForkConversation,
  onExportConversation,
  onSetConversationArchived,
  onSetConversationTags,
  onDeleteConversation,
  conversationActionsDisabled,
}: {
  project: Project;
  forceOpen: boolean;
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string, project: Project) => void;
  onNewProjectChat: (project: Project) => void;
  onRenameConversation: (conversationId: string, title: string, project: Project) => Promise<void>;
  onForkConversation: (conversationId: string, project: Project) => Promise<void>;
  onExportConversation: (conversationId: string, format: "markdown" | "json") => Promise<void>;
  onSetConversationArchived: (conversationId: string, archived: boolean) => Promise<void>;
  onSetConversationTags: (conversationId: string, tags: string[]) => Promise<void>;
  onDeleteConversation: (conversationId: string, project: Project) => Promise<void>;
  conversationActionsDisabled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(project.conversations.some(({ id }) => id === selectedConversationId));

  return (
    <Collapsible.Root
      className="mb-tight"
      open={forceOpen || open}
      onOpenChange={(nextOpen) => {
        if (!forceOpen) setOpen(nextOpen);
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_28px_28px] items-center gap-px">
        <Collapsible.Trigger className="grid min-h-[50px] w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-base rounded-md px-base py-[7px] text-left text-label-3 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98]" type="button">
          <Folder size={16} className="text-accent" />
          <span className="min-w-0">
            <strong className="block truncate text-callout font-semibold text-label">{project.name}</strong>
            <code className="mt-tight block truncate font-mono text-caption text-label-3">{project.path}</code>
          </span>
        </Collapsible.Trigger>
        <button
          className="grid size-control-sm cursor-pointer place-items-center rounded-sm text-label-3 transition-colors duration-150 ease-apple hover:bg-accent/8 hover:text-accent active:bg-accent/16 active:scale-[0.98]"
          type="button"
          aria-label={t("在“{name}”中新建会话", { name: project.name })}
          title={t("新建项目会话")}
          onClick={() => onNewProjectChat(project)}
        >
          <Plus size={14} />
        </button>
        <Collapsible.Trigger className={iconButtonClass} type="button" aria-label={`${t(forceOpen || open ? "收起" : "展开")} “${project.name}”`}>
          {forceOpen || open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="relative mt-px mb-tight ml-card overflow-hidden pl-[13px] before:absolute before:top-[2px] before:bottom-[9px] before:left-0 before:w-px before:bg-separator before:content-['']">
        {project.conversations.length === 0 ? (
          <p className={`${sidebarEmptyClass} mx-0 mt-tight mb-base`}>{t("暂无对话")}</p>
        ) : project.conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            project={project}
            selected={selectedConversationId === conversation.id}
            actionsDisabled={conversationActionsDisabled}
            onSelect={() => onSelectConversation(conversation.id, project)}
            onRename={(title) => onRenameConversation(conversation.id, title, project)}
            onFork={() => onForkConversation(conversation.id, project)}
            onExport={(format) => onExportConversation(conversation.id, format)}
            onSetArchived={(archived) => onSetConversationArchived(conversation.id, archived)}
            onSetTags={(tags) => onSetConversationTags(conversation.id, tags)}
            onDelete={() => onDeleteConversation(conversation.id, project)}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function ConversationSidebar({
  activePrimary,
  collapsed,
  conversations,
  projects,
  selectedConversationId,
  searchRequest,
  onToggleCollapsed,
  onSelectConversation,
  onNewChat,
  onNewProjectChat,
  onRenameConversation,
  onForkConversation,
  onExportConversation,
  onSetConversationArchived,
  onSetConversationTags,
  onDeleteConversation,
  conversationActionsDisabled,
  onAddProject,
  onOpenSettings,
  onOpenPlugins,
  onOpenPet,
}: ConversationSidebarProps) {
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();

  useEffect(() => {
    if (searchOpen && !collapsed) searchInputRef.current?.focus();
  }, [collapsed, searchOpen]);

  useEffect(() => {
    if (searchRequest <= 0 || collapsed) return;
    setSearchOpen(true);
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [collapsed, searchRequest]);

  const activeConversations = useMemo(() => conversations.filter((conversation) => !conversation.archived), [conversations]);
  const activeProjects = useMemo(() => projects.map((project) => ({
    ...project,
    conversations: project.conversations.filter((conversation) => !conversation.archived),
  })), [projects]);
  const archivedEntries = useMemo(() => [
    ...conversations.filter((conversation) => conversation.archived).map((conversation) => ({ conversation, project: undefined as Project | undefined })),
    ...projects.flatMap((project) => project.conversations.filter((conversation) => conversation.archived).map((conversation) => ({ conversation, project }))),
  ].filter(({ conversation }) => !normalizedQuery || matchesConversation(conversation, normalizedQuery)), [conversations, normalizedQuery, projects]);
  const filteredConversations = useMemo(
    () => normalizedQuery ? activeConversations.filter((conversation) => matchesConversation(conversation, normalizedQuery)) : activeConversations,
    [activeConversations, normalizedQuery],
  );
  const filteredProjects = useMemo(() => activeProjects.flatMap((project) => {
    if (!normalizedQuery) return [project];
    const projectMatches = [project.name, project.path].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    const matchingConversations = project.conversations.filter((conversation) => matchesConversation(conversation, normalizedQuery));
    return projectMatches || matchingConversations.length > 0
      ? [{ ...project, conversations: projectMatches ? project.conversations : matchingConversations }]
      : [];
  }), [activeProjects, normalizedQuery]);
  const noSearchResults = Boolean(normalizedQuery) && filteredConversations.length === 0 && filteredProjects.length === 0 && archivedEntries.length === 0;

  function toggleSearch() {
    if (collapsed) return;
    if (searchOpen) setSearchQuery("");
    setSearchOpen(!searchOpen);
  }

  return (
    <aside className="material-sidebar grid min-h-0 min-w-0 grid-rows-[auto_auto_1fr_auto]">
      <header className={`flex h-[58px] items-center gap-loose ${collapsed ? "justify-center px-0" : "px-card"}`}>
        {!collapsed && <BrandMark />}
        {!collapsed && <strong className="text-headline">Pi Forge</strong>}
        <button
          className={`${iconButtonClass} ${collapsed ? "" : "ml-auto"}`}
          type="button"
          aria-label={t(collapsed ? "展开侧栏" : "收起侧栏")}
          title={t(collapsed ? "展开侧栏" : "收起侧栏")}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </header>

      <nav className={`grid gap-tight border-b border-separator pt-base pb-loose ${collapsed ? "px-base" : "px-loose"}`} aria-label={t("主要导航")}>
        <button className={primaryNavItemClass(activePrimary === "chat", collapsed)} type="button" onClick={onNewChat} title={t("新建对话")} aria-current={activePrimary === "chat" ? "page" : undefined}>
          <Plus size={18} />
          {!collapsed && <span>{t("新建对话")}</span>}
          {!collapsed && <kbd className="ml-auto grid h-5 min-w-[23px] place-items-center rounded-sm border border-separator bg-bg px-[5px] font-mono text-mini font-semibold text-label-3">{shortcutLabel("N")}</kbd>}
        </button>
        <button className={primaryNavItemClass(activePrimary === "plugins", collapsed)} type="button" onClick={onOpenPlugins} title={t("插件中心")} aria-current={activePrimary === "plugins" ? "page" : undefined}>
          <Package size={16} />
          {!collapsed && <span>{t("插件中心")}</span>}
        </button>
      </nav>

      <div className={`min-h-0 overflow-y-auto px-base pt-card pb-loose [scrollbar-width:thin] ${collapsed ? "hidden" : ""}`}>
        {searchOpen ? (
          <div className="mx-tight mb-loose grid h-control-md grid-cols-[18px_minmax(0,1fr)_24px] items-center gap-tight rounded-md border border-separator bg-bg-grouped pr-tight pl-loose text-label-3 focus-within:border-accent">
            <Search size={14} />
            <input
              ref={searchInputRef}
              className="min-w-0 border-0 bg-transparent text-caption text-label outline-none placeholder:text-label-3"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") toggleSearch();
              }}
              placeholder={t("搜索对话或项目")}
              aria-label={t("搜索对话或项目")}
            />
            <button type="button" className="grid size-6 cursor-pointer place-items-center rounded-sm text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98]" onClick={toggleSearch} aria-label={t("关闭搜索")}><X size={14} /></button>
          </div>
        ) : (
          <div className={sectionTitleClass}>
            <span>{t("普通对话")}</span>
            <button className={iconButtonClass} type="button" aria-label={t("搜索对话")} onClick={toggleSearch}>
              <Search size={14} />
            </button>
          </div>
        )}

        {filteredConversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={selectedConversationId === conversation.id}
            actionsDisabled={conversationActionsDisabled}
            onSelect={() => onSelectConversation(conversation.id)}
            onRename={(title) => onRenameConversation(conversation.id, title)}
            onFork={() => onForkConversation(conversation.id)}
            onExport={(format) => onExportConversation(conversation.id, format)}
            onSetArchived={(archived) => onSetConversationArchived(conversation.id, archived)}
            onSetTags={(tags) => onSetConversationTags(conversation.id, tags)}
            onDelete={() => onDeleteConversation(conversation.id)}
          />
        ))}
        {!normalizedQuery && conversations.length === 0 && <p className={`${sidebarEmptyClass} mx-loose mt-tight`}>{t("暂无普通对话")}</p>}

        <div className={`${sectionTitleClass} mt-card`}>
          <span>{t("项目")}</span>
          <button className={iconButtonClass} type="button" aria-label={t("添加项目")} onClick={onAddProject}>
            <Plus size={14} />
          </button>
        </div>
        {filteredProjects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            forceOpen={Boolean(normalizedQuery)}
            selectedConversationId={selectedConversationId}
            onSelectConversation={onSelectConversation}
            onNewProjectChat={onNewProjectChat}
            onRenameConversation={onRenameConversation}
            onForkConversation={onForkConversation}
            onExportConversation={onExportConversation}
            onSetConversationArchived={onSetConversationArchived}
            onSetConversationTags={onSetConversationTags}
            onDeleteConversation={onDeleteConversation}
            conversationActionsDisabled={conversationActionsDisabled}
          />
        ))}
        {!normalizedQuery && projects.length === 0 && <p className={`${sidebarEmptyClass} mx-loose mt-tight`}>{t("暂无项目")}</p>}
        {archivedEntries.length > 0 && <div className={`${sectionTitleClass} mt-card`}><span>{t("已归档")}</span><Archive size={14} /></div>}
        {archivedEntries.map(({ conversation, project }) => <ConversationRow
          key={`archive:${conversation.id}`}
          conversation={conversation}
          project={project}
          selected={selectedConversationId === conversation.id}
          actionsDisabled={conversationActionsDisabled}
          onSelect={() => onSelectConversation(conversation.id, project)}
          onRename={(title) => onRenameConversation(conversation.id, title, project)}
          onFork={() => onForkConversation(conversation.id, project)}
          onExport={(format) => onExportConversation(conversation.id, format)}
          onSetArchived={(archived) => onSetConversationArchived(conversation.id, archived)}
          onSetTags={(tags) => onSetConversationTags(conversation.id, tags)}
          onDelete={() => onDeleteConversation(conversation.id, project)}
        />)}
        {noSearchResults && <p className={`${sidebarEmptyClass} mt-card text-center`}>{t("没有找到“{query}”", { query: searchQuery.trim() })}</p>}
      </div>

      <div className="border-t border-separator p-base">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className={`grid h-12 w-full cursor-pointer items-center gap-base rounded-md text-left text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] data-[state=open]:bg-fill ${collapsed ? "grid-cols-1 justify-items-center px-0" : "grid-cols-[30px_1fr_20px] px-loose"}`} type="button" title={t("本地账户")}>
              <span className="grid size-[30px] place-items-center rounded-md bg-accent/16 font-mono text-caption font-bold text-accent">PI</span>
              {!collapsed && <span className="min-w-0">
                <strong className="block truncate text-callout font-semibold text-label">{t("Pi 用户")}</strong>
                <small className="mt-tight block truncate text-caption text-label-3">{t("所有数据保存在本机")}</small>
              </span>}
              {!collapsed && <MoreHorizontal size={16} className="text-label-3" />}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content w-[280px]" side="top" align="start" sideOffset={8}>
              <div className="mb-tight border-b border-separator px-loose pt-base pb-loose text-caption text-label-3">{t("Pi 用户")} · {t("本地账户")}</div>
              <DropdownMenu.Item className="dropdown-item grid min-h-[46px] grid-cols-[28px_minmax(0,1fr)_16px] items-center gap-base rounded-md px-loose py-[7px]" onSelect={onOpenPet}>
                <span className="grid size-control-sm place-items-center rounded-md bg-fill-2 text-label-2"><Sparkles size={16} /></span>
                <span className="min-w-0"><strong className="block text-caption font-semibold">{t("宠物")}</strong><small className="mt-tight block text-caption text-label-3">{t("陪伴模式与个性设置")}</small></span>
                <ChevronRight size={14} />
              </DropdownMenu.Item>
              <DropdownMenu.Item className="dropdown-item grid min-h-[46px] grid-cols-[28px_minmax(0,1fr)_16px] items-center gap-base rounded-md px-loose py-[7px]" onSelect={onOpenSettings}>
                <span className="grid size-control-sm place-items-center rounded-md bg-fill-2 text-label-2"><Settings size={16} /></span>
                <span className="min-w-0"><strong className="block text-caption font-semibold">{t("设置")}</strong><small className="mt-tight block text-caption text-label-3">{t("模型、权限与应用偏好")}</small></span>
                <ChevronRight size={14} />
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </aside>
  );
}

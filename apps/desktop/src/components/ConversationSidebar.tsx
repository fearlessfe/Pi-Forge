import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { shortcutLabel } from "../keyboard";
import type { Conversation, Project } from "../types";
import { BrandMark } from "./BrandMark";

type ConversationSidebarProps = {
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
  onDeleteConversation: (conversationId: string, project?: Project) => Promise<void>;
  conversationActionsDisabled: boolean;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onOpenPet: () => void;
};

function matchesConversation(conversation: Conversation, query: string) {
  return [conversation.title, conversation.subtitle].some((value) => value.toLocaleLowerCase().includes(query));
}

function ConversationRow({
  conversation,
  project,
  selected,
  actionsDisabled,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  project?: Project;
  selected: boolean;
  actionsDisabled: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const rowClassName = `conversation-row ${project ? "conversation-row--project" : ""} ${selected ? "is-active" : ""}`;

  useEffect(() => {
    if (!editing) setTitle(conversation.title);
  }, [conversation.title, editing]);

  if (editing) {
    return (
      <form className={`${rowClassName} conversation-row--editing`} onSubmit={(event) => {
        event.preventDefault();
        const nextTitle = title.trim().replace(/\s+/g, " ");
        if (!nextTitle || saving) return;
        setSaving(true);
        void onRename(nextTitle).then(() => setEditing(false)).catch(() => {}).finally(() => setSaving(false));
      }}>
        <MessageSquare size={14} />
        <input
          autoFocus
          value={title}
          maxLength={60}
          aria-label={`重命名“${conversation.title}”`}
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
        <button type="submit" aria-label="保存名称" disabled={!title.trim() || saving}><Check size={13} /></button>
        <button type="button" aria-label="取消重命名" disabled={saving} onClick={() => { setTitle(conversation.title); setEditing(false); }}><X size={13} /></button>
      </form>
    );
  }

  return (
    <div className={rowClassName}>
      <button className="conversation-select" type="button" onClick={onSelect}>
        <MessageSquare size={14} />
        <span>
          <strong>{conversation.title}</strong>
          <small>{conversation.subtitle}</small>
        </span>
        <time>{conversation.updatedAt}</time>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="conversation-actions"
            type="button"
            aria-label={`管理“${conversation.title}”`}
            title={actionsDisabled ? "Agent 运行中暂不可管理会话" : "管理会话"}
            disabled={actionsDisabled}
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content conversation-menu" side="right" align="start" sideOffset={6}>
            <DropdownMenu.Item className="dropdown-item conversation-menu-item" onSelect={() => setEditing(true)}>
              <Pencil size={13} /><span>重命名</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item conversation-menu-item is-danger" onSelect={() => {
              if (window.confirm(`确定删除“${conversation.title}”吗？此操作不可恢复。`)) void onDelete();
            }}>
              <Trash2 size={13} /><span>删除对话</span>
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
  onDeleteConversation,
  conversationActionsDisabled,
}: {
  project: Project;
  forceOpen: boolean;
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string, project: Project) => void;
  onNewProjectChat: (project: Project) => void;
  onRenameConversation: (conversationId: string, title: string, project: Project) => Promise<void>;
  onDeleteConversation: (conversationId: string, project: Project) => Promise<void>;
  conversationActionsDisabled: boolean;
}) {
  const [open, setOpen] = useState(project.conversations.some(({ id }) => id === selectedConversationId));

  return (
    <Collapsible.Root
      className="project-group"
      open={forceOpen || open}
      onOpenChange={(nextOpen) => {
        if (!forceOpen) setOpen(nextOpen);
      }}
    >
      <div className="project-header-row">
        <Collapsible.Trigger className="project-trigger" type="button">
          <Folder size={15} className="project-folder" />
          <span className="project-copy">
            <strong>{project.name}</strong>
            <code>{project.path}</code>
          </span>
        </Collapsible.Trigger>
        <button
          className="project-new-chat"
          type="button"
          aria-label={`在“${project.name}”中新建会话`}
          title="新建项目会话"
          onClick={() => onNewProjectChat(project)}
        >
          <Plus size={14} />
        </button>
        <Collapsible.Trigger className="project-toggle" type="button" aria-label={`${forceOpen || open ? "收起" : "展开"}“${project.name}”`}>
          {forceOpen || open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="project-thread-list">
        {project.conversations.length === 0 ? (
          <p className="sidebar-empty sidebar-empty--project">暂无对话</p>
        ) : project.conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            project={project}
            selected={selectedConversationId === conversation.id}
            actionsDisabled={conversationActionsDisabled}
            onSelect={() => onSelectConversation(conversation.id, project)}
            onRename={(title) => onRenameConversation(conversation.id, title, project)}
            onDelete={() => onDeleteConversation(conversation.id, project)}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function ConversationSidebar({
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
  onDeleteConversation,
  conversationActionsDisabled,
  onAddProject,
  onOpenSettings,
  onOpenPlugins,
  onOpenPet,
}: ConversationSidebarProps) {
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

  const filteredConversations = useMemo(
    () => normalizedQuery ? conversations.filter((conversation) => matchesConversation(conversation, normalizedQuery)) : conversations,
    [conversations, normalizedQuery],
  );
  const filteredProjects = useMemo(() => projects.flatMap((project) => {
    if (!normalizedQuery) return [project];
    const projectMatches = [project.name, project.path].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    const matchingConversations = project.conversations.filter((conversation) => matchesConversation(conversation, normalizedQuery));
    return projectMatches || matchingConversations.length > 0
      ? [{ ...project, conversations: projectMatches ? project.conversations : matchingConversations }]
      : [];
  }), [normalizedQuery, projects]);
  const noSearchResults = Boolean(normalizedQuery) && filteredConversations.length === 0 && filteredProjects.length === 0;

  function toggleSearch() {
    if (collapsed) return;
    if (searchOpen) setSearchQuery("");
    setSearchOpen(!searchOpen);
  }

  return (
    <aside className={`conversation-sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <header className="sidebar-brand-row">
        <BrandMark />
        <strong>Pi Desktop</strong>
        <button
          className="icon-button sidebar-collapse"
          type="button"
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
        </button>
      </header>

      <nav className="sidebar-primary-nav" aria-label="主要导航">
        <button className="primary-nav-item is-active" type="button" onClick={onNewChat} title="新建对话">
          <Plus size={18} />
          <span>新建对话</span>
          <kbd>{shortcutLabel("N")}</kbd>
        </button>
        <button className="primary-nav-item" type="button" onClick={onOpenPlugins} title="插件">
          <Package size={17} />
          <span>插件</span>
        </button>
      </nav>

      <div className="sidebar-list">
        {searchOpen ? (
          <div className="sidebar-search">
            <Search size={14} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") toggleSearch();
              }}
              placeholder="搜索对话或项目"
              aria-label="搜索对话或项目"
            />
            <button type="button" onClick={toggleSearch} aria-label="关闭搜索"><X size={13} /></button>
          </div>
        ) : (
          <div className="sidebar-section-title">
            <span>普通对话</span>
            <button className="icon-button" type="button" aria-label="搜索对话" onClick={toggleSearch}>
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
            onDelete={() => onDeleteConversation(conversation.id)}
          />
        ))}
        {!normalizedQuery && conversations.length === 0 && <p className="sidebar-empty">暂无普通对话</p>}

        <div className="sidebar-section-title sidebar-section-title--projects">
          <span>项目</span>
          <button className="icon-button" type="button" aria-label="添加项目" onClick={onAddProject}>
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
            onDeleteConversation={onDeleteConversation}
            conversationActionsDisabled={conversationActionsDisabled}
          />
        ))}
        {!normalizedQuery && projects.length === 0 && <p className="sidebar-empty">暂无项目</p>}
        {noSearchResults && <p className="sidebar-search-empty">没有找到“{searchQuery.trim()}”</p>}
      </div>

      <div className="sidebar-user-zone">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="user-trigger" type="button" title="本地账户">
              <span className="user-avatar">PZ</span>
              <span>
                <strong>Pengzhen</strong>
                <small>所有数据保存在本机</small>
              </span>
              <MoreHorizontal size={17} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content user-menu" side="top" align="start" sideOffset={8}>
              <div className="dropdown-account">Pengzhen · 本地账户</div>
              <DropdownMenu.Item className="dropdown-item user-menu-item" onSelect={onOpenPet}>
                <span className="menu-item-icon"><Sparkles size={15} /></span>
                <span><strong>宠物</strong><small>陪伴模式与个性设置</small></span>
                <ChevronRight size={14} />
              </DropdownMenu.Item>
              <DropdownMenu.Item className="dropdown-item user-menu-item" onSelect={onOpenSettings}>
                <span className="menu-item-icon"><Settings size={15} /></span>
                <span><strong>设置</strong><small>模型、权限与应用偏好</small></span>
                <ChevronRight size={14} />
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </aside>
  );
}

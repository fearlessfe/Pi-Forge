import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Package,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { projects, regularConversations } from "../data";
import type { Project } from "../types";
import { BrandMark } from "./BrandMark";

type ConversationSidebarProps = {
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string, project?: Project) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onOpenPet: () => void;
};

function ProjectGroup({
  project,
  selectedConversationId,
  onSelectConversation,
}: {
  project: Project;
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string, project: Project) => void;
}) {
  const [open, setOpen] = useState(project.id === "pi-desktop");

  return (
    <Collapsible.Root className="project-group" open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="project-trigger">
        <Folder size={15} className="project-folder" />
        <span className="project-copy">
          <strong>{project.name}</strong>
          <code>{project.path}</code>
        </span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </Collapsible.Trigger>
      <Collapsible.Content className="project-thread-list">
        {project.conversations.map((conversation) => (
          <button
            className={`conversation-row conversation-row--project ${
              selectedConversationId === conversation.id ? "is-active" : ""
            }`}
            key={conversation.id}
            type="button"
            onClick={() => onSelectConversation(conversation.id, project)}
          >
            <MessageSquare size={14} />
            <span>
              <strong>{conversation.title}</strong>
              <small>{conversation.subtitle}</small>
            </span>
            <time>{conversation.updatedAt}</time>
          </button>
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function ConversationSidebar({
  selectedConversationId,
  onSelectConversation,
  onNewChat,
  onOpenSettings,
  onOpenPlugins,
  onOpenPet,
}: ConversationSidebarProps) {
  return (
    <aside className="conversation-sidebar">
      <header className="sidebar-brand-row">
        <BrandMark />
        <strong>Pi Desktop</strong>
        <button className="icon-button sidebar-collapse" type="button" aria-label="收起侧栏">
          <ChevronsLeft size={17} />
        </button>
      </header>

      <nav className="sidebar-primary-nav" aria-label="主要导航">
        <button className="primary-nav-item is-active" type="button" onClick={onNewChat}>
          <Plus size={18} />
          <span>新建对话</span>
          <kbd>⌘N</kbd>
        </button>
        <button className="primary-nav-item" type="button" onClick={onOpenPlugins}>
          <Package size={17} />
          <span>插件</span>
          <small>6</small>
        </button>
      </nav>

      <div className="sidebar-list">
        <div className="sidebar-section-title">
          <span>普通对话</span>
          <button className="icon-button" type="button" aria-label="搜索对话">
            <Search size={14} />
          </button>
        </div>
        {regularConversations.map((conversation) => (
          <button
            className={`conversation-row ${selectedConversationId === conversation.id ? "is-active" : ""}`}
            key={conversation.id}
            type="button"
            onClick={() => onSelectConversation(conversation.id)}
          >
            <MessageSquare size={14} />
            <span>
              <strong>{conversation.title}</strong>
              <small>{conversation.subtitle}</small>
            </span>
            <time>{conversation.updatedAt}</time>
          </button>
        ))}

        <div className="sidebar-section-title sidebar-section-title--projects">
          <span>项目</span>
          <button className="icon-button" type="button" aria-label="添加项目">
            <Plus size={14} />
          </button>
        </div>
        {projects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            selectedConversationId={selectedConversationId}
            onSelectConversation={onSelectConversation}
          />
        ))}
      </div>

      <div className="sidebar-user-zone">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="user-trigger" type="button">
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

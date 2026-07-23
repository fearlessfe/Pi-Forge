import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowUp, Check, ChevronDown, Copy, Folder, Paperclip, RotateCcw } from "lucide-react";
import { useState } from "react";
import { modelOptions, projects } from "../data";
import type { ChatTurn, Project } from "../types";
import { BrandMark } from "./BrandMark";

type NewChatViewProps = {
  project: Project | null;
  turns: ChatTurn[];
  modelId: string;
  prompt: string;
  onPromptChange: (value: string) => void;
  onProjectChange: (project: Project | null) => void;
  onModelChange: (modelId: string) => void;
  onSubmit: () => void;
  onRetry: (turnId: string) => void;
};

function ModelMenu({ modelId, onModelChange }: Pick<NewChatViewProps, "modelId" | "onModelChange">) {
  const selectedModel = modelOptions.find((model) => model.id === modelId) ?? modelOptions[0];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="composer-tool-button model-trigger" type="button">
          {selectedModel.name}
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content model-menu" align="start" sideOffset={8}>
          {modelOptions.map((model) => (
            <DropdownMenu.Item
              key={model.id}
              className={`dropdown-item model-menu-item ${model.id === modelId ? "is-selected" : ""}`}
              onSelect={() => onModelChange(model.id)}
            >
              <span><strong>{model.name}</strong><small>{model.description}</small></span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function DirectoryMenu({
  project,
  compact = false,
  onProjectChange,
}: Pick<NewChatViewProps, "project" | "onProjectChange"> & { compact?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={compact ? "composer-tool-button compact-directory-trigger" : "directory-trigger"} type="button">
          <Folder size={15} />
          <span>{compact ? project?.name ?? "普通对话" : project ? "更换目录" : "选择目录"}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content directory-menu" align="start" sideOffset={8}>
          <div className="dropdown-label">选择最近使用的工作目录</div>
          {projects.map((item) => (
            <DropdownMenu.Item className="dropdown-item directory-item" key={item.id} onSelect={() => onProjectChange(item)}>
              <Folder size={15} />
              <span><strong>{item.name}</strong><code>{item.path}</code></span>
            </DropdownMenu.Item>
          ))}
          {project && (
            <DropdownMenu.Item className="dropdown-item directory-item" onSelect={() => onProjectChange(null)}>
              <span className="directory-empty">×</span>
              <span><strong>移除工作目录</strong><code>转为普通对话</code></span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function InitialComposer(props: NewChatViewProps) {
  return (
    <section className="new-chat-view" aria-label="新建对话">
      <div className="composer-stage">
        <header className="composer-heading">
          <span className="orbit-mark"><BrandMark compact /><i /></span>
          <h1>{props.project ? `在 ${props.project.name} 中开始新对话` : "今天想一起做什么？"}</h1>
          <p>
            {props.project
              ? "Pi 将以该目录为边界读取文件、执行命令并追踪变更。"
              : "直接提问，或选择工作目录开始一个项目对话。"}
          </p>
        </header>

        <form
          className="composer-card"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <textarea
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            placeholder="描述你想分析、构建或修改的内容…"
            aria-label="对话内容"
          />
          <div className="composer-toolbar">
            <button className="composer-tool-button" type="button" aria-label="添加附件"><Paperclip size={15} /></button>
            <ModelMenu modelId={props.modelId} onModelChange={props.onModelChange} />
            <button className="send-button" type="submit" aria-label="发送" disabled={!props.prompt.trim()}><ArrowUp size={17} /></button>
          </div>
        </form>

        <div className="conversation-context">
          <DirectoryMenu project={props.project} onProjectChange={props.onProjectChange} />
          <span className="context-copy">
            <strong>{props.project ? props.project.path : "普通对话"}</strong>
            <small>{props.project ? `项目对话 · 新对话会归入 ${props.project.name}` : "未关联工作目录，Pi 不会读取本地项目文件"}</small>
          </span>
        </div>
        <p className="context-hint">
          {props.project ? "工作区外访问仍需单独授权。" : "选择目录后，这条对话会自动归入对应项目。"}
        </p>
      </div>
    </section>
  );
}

function ConversationTurn({
  turn,
  onRetry,
}: {
  turn: ChatTurn;
  onRetry: (turnId: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyQuestion() {
    try {
      await navigator.clipboard.writeText(turn.question);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = turn.question;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <article className="qa-pair">
      <section className="qa-message qa-question" aria-label="用户消息">
        <div className="message-bubble-stack message-bubble-stack--user">
          <div className="question-content">{turn.question}</div>
          <div className="message-actions">
            <button type="button" onClick={copyQuestion} aria-label="复制用户输入">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            <button type="button" onClick={() => onRetry(turn.id)} aria-label="重新发送用户输入">
              <RotateCcw size={13} />
              <span>重试</span>
            </button>
          </div>
        </div>
      </section>
      <section className="qa-message qa-answer" aria-label="Agent 回答">
        <div className="answer-content"><p>{turn.answer}</p></div>
      </section>
    </article>
  );
}

function ActiveConversation(props: NewChatViewProps) {
  return (
    <section className="active-conversation" aria-label="当前对话">
      <div className="conversation-scroll" aria-live="polite">
        <div className="conversation-turns">
          {props.turns.map((turn) => <ConversationTurn key={turn.id} turn={turn} onRetry={props.onRetry} />)}
        </div>
      </div>
      <footer className="conversation-dock">
        <form
          className="compact-composer"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <textarea
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            placeholder="继续给 Pi 指令…"
            aria-label="继续对话"
          />
          <div className="compact-composer-toolbar">
            <button className="composer-tool-button" type="button" aria-label="添加附件"><Paperclip size={15} /></button>
            <ModelMenu modelId={props.modelId} onModelChange={props.onModelChange} />
            <DirectoryMenu compact project={props.project} onProjectChange={props.onProjectChange} />
            <button className="send-button" type="submit" aria-label="发送" disabled={!props.prompt.trim()}><ArrowUp size={17} /></button>
          </div>
        </form>
        <p className="dock-context">
          {props.project ? <><Folder size={12} /><code>{props.project.path}</code><span>工作区外访问仍需授权</span></> : <><span>普通对话</span><span>未关联工作目录</span></>}
        </p>
      </footer>
    </section>
  );
}

export function NewChatView(props: NewChatViewProps) {
  return props.turns.length ? <ActiveConversation {...props} /> : <InitialComposer {...props} />;
}

# Pi Desktop

Pi Desktop 是一个基于 Pi Coding Agent 构建的桌面端 AI 编程助手。它计划在保留 Pi Agent 能力的基础上，提供更加直观的图形界面，用于管理工作区、与 Agent 对话、查看工具执行过程、审核代码变更以及操作集成终端。

> 当前项目已完成 Renderer 前端脚手架与核心页面，本文档同时描述产品方向、技术方案和后续实施范围。

前端页面脚手架已经落地在 `apps/desktop`，当前可运行会话首页、项目对话树、设置页面和深浅主题。Electron 主进程、Pi Adapter 与本地存储仍在后续实施范围内。

## 本地开发

需要 Node.js 20+ 与 pnpm 10+。

```bash
pnpm install
pnpm dev
```

默认地址为 `http://127.0.0.1:4173`。

```bash
pnpm typecheck
pnpm build
```

## 项目目标

Pi Desktop 希望把 Coding Agent 的完整工作流整合到一个桌面应用中：

- 选择本地项目并创建独立会话
- 通过对话提出开发、分析和调试任务
- 实时查看模型输出、思考状态与工具调用过程
- 查看并审核 Agent 产生的文件修改和代码 Diff
- 在应用内观察和操作终端任务
- 停止、重试、恢复和管理历史会话
- 配置模型提供商、模型及 Agent 权限

项目重点不是简单地为命令行套一层窗口，而是为 Agent 的事件流、工具调用、权限审批和代码变更设计原生桌面交互。

## 产品原则

- **过程透明**：用户可以清楚看到 Agent 正在做什么、调用了什么工具以及修改了哪些文件。
- **用户可控**：危险操作、敏感资源访问和越界行为必须经过明确授权。
- **会话可恢复**：应用重启后仍能继续查看和恢复工作上下文。
- **本地优先**：项目文件、终端和会话数据默认在本机处理与存储。
- **引擎解耦**：通过适配层接入 Pi，避免 UI 直接依赖 Pi 的内部实现细节。
- **渐进增强**：先完成稳定的单工作区 Agent 闭环，再扩展多任务、插件和远程能力。

## 总体架构

```text
┌─────────────────────────────────────────────────────┐
│ Electron Renderer                                   │
│ React UI · Conversation · Tool Calls · Diff · Shell │
└──────────────────────────┬──────────────────────────┘
                           │ Typed IPC
┌──────────────────────────▼──────────────────────────┐
│ Electron Main Process                               │
│ Window · Lifecycle · Security · Native Integration  │
├─────────────────────────────────────────────────────┤
│ Application Services                                │
│ Workspace · Session · Approval · Settings · Storage │
├─────────────────────────────────────────────────────┤
│ Pi Adapter                                          │
│ Agent Session · Event Mapping · Tools · Cancellation│
└───────────────┬───────────────────┬─────────────────┘
                │                   │
        ┌───────▼────────┐  ┌──────▼───────────────┐
        │ Pi Coding Agent│  │ Local System         │
        │ Model + Agent  │  │ Files · PTY · Keychain│
        └────────────────┘  └──────────────────────┘
```

### 进程边界

Pi Desktop 将遵循 Electron 的进程隔离模型：

- **Renderer 进程**只负责界面渲染和用户交互，不直接访问 Node.js、文件系统、API Key 或 Shell。
- **Preload 层**通过白名单暴露类型安全、范围有限的 IPC API。
- **Main 进程**负责窗口生命周期、系统集成、密钥访问及应用服务调度。
- **Agent 执行层**承载 Pi Session 和工具执行；随着任务复杂度提升，可迁移到独立 Worker 或子进程，减少 Agent 任务对桌面主进程的影响。

## 技术选型

### 桌面运行时：Electron

选择 Electron 作为首个版本的桌面运行时：

- Pi 与 Electron 都处于 Node.js/TypeScript 生态，集成路径最短。
- Node.js 可以自然承载 Agent、文件系统、子进程和终端能力。
- Electron 具备成熟的跨平台打包、自动更新和系统集成方案。
- Renderer 与主进程可以共享 TypeScript 类型定义，便于维护 IPC 契约。

Tauri 的安装体积和资源占用更有优势，但接入 Pi 通常还需要额外维护 Node.js sidecar。项目早期优先降低集成复杂度，后续可以根据性能与分发需求重新评估。

### 前端：React + TypeScript

- **React**：适合构建对话流、工具调用卡片、Diff 面板等状态密集型界面。
- **TypeScript**：统一 UI、IPC 和 Pi 适配层的数据模型，降低事件协议出错概率。
- **Vite**：提供快速的本地开发和前端构建体验。

### 状态与数据请求

- **Zustand**：管理窗口内的交互状态、当前会话和流式事件，API 简洁且适合桌面应用。
- **TanStack Query**：用于会话列表、设置、工作区等异步数据的读取、缓存与刷新。

两者职责分离：短生命周期 UI 状态进入 Zustand，具有服务端式读写语义的数据通过 Query 管理。

### 本地存储：SQLite

SQLite 用于保存：

- 工作区信息
- 会话元数据
- 消息及工具调用记录
- 权限决策与应用设置

数据库只保存结构化业务数据。大段终端输出或其他高容量内容可以按需转存为本地文件，并由数据库记录索引。

### 系统密钥：操作系统 Keychain

模型提供商的 API Key 不写入普通配置文件或数据库，统一通过操作系统的安全凭据存储能力管理。Renderer 只能获取“是否已配置”等脱敏状态，不能读取明文密钥。

### 集成终端：xterm.js + PTY

- **xterm.js** 负责 Renderer 中的终端显示与输入。
- **PTY** 运行在受信任的后端进程中，负责启动和管理真实 Shell。

终端会话和 Agent 工具调用需要分别标识，避免普通交互终端绕过 Agent 的权限策略。

### 代码 Diff 与编辑体验

首个版本优先提供只读 Diff 审核能力，候选实现包括 Monaco Editor 的 Diff Editor。完整代码编辑器不是 MVP 的必要条件；用户仍可从 Pi Desktop 打开系统中已安装的编辑器继续工作。

### UI 与样式

- **Tailwind CSS**：用于布局、主题和设计 Token。
- **Radix UI / shadcn/ui**：用于对话框、菜单、提示、选择器等可访问性基础组件。
- 图标库将在实现阶段统一选定，避免同时引入多套视觉风格。

## Pi 集成策略

Pi Desktop 优先通过 Pi 提供的程序化能力创建和控制 Agent Session，而不是解析终端 UI 的文本输出。

应用内部将增加独立的 `PiAdapter`，负责：

- 创建、恢复和结束 Agent Session
- 发送用户消息并取消正在执行的任务
- 将 Pi 事件转换为稳定的应用事件
- 映射模型输出、工具调用、状态变化和错误
- 注入工作区、权限策略和模型配置
- 隔离 Pi 版本升级带来的 API 变化

Renderer 只依赖应用自己的事件协议，例如：

```ts
type AgentEvent =
  | { type: "message.delta"; sessionId: string; text: string }
  | { type: "tool.started"; sessionId: string; callId: string; tool: string }
  | { type: "tool.updated"; sessionId: string; callId: string; output: string }
  | { type: "tool.completed"; sessionId: string; callId: string; success: boolean }
  | { type: "approval.requested"; sessionId: string; requestId: string }
  | { type: "session.completed"; sessionId: string };
```

以上仅用于说明事件边界，最终字段将根据 Pi 的实际 API 和 UI 需求确定。

## MVP 范围

第一阶段以打通一个可靠的单工作区开发闭环为目标。

### 包含

- 打开和记忆本地工作区
- 创建、切换和恢复 Agent 会话
- 发送消息并显示流式回复
- 展示工具调用状态及输出
- 停止正在运行的 Agent
- 查看本次任务产生的文件 Diff
- 对敏感工具调用进行允许或拒绝
- 配置模型提供商与模型
- 在系统 Keychain 中保存 API Key
- 基础集成终端
- 深色与浅色主题

### 暂不包含

- 完整 IDE 能力
- 多 Agent 并行编排
- 云端会话同步
- 团队协作和账号体系
- 移动端或 Web 端
- 插件市场
- 自动更新服务的生产部署

## 安全设计

Coding Agent 可以读取文件、执行命令并修改代码，因此安全边界属于核心功能，而不是后续补充项。

- Electron 启用 `contextIsolation`，关闭 Renderer 的 Node.js 集成。
- IPC 使用显式白名单并验证所有参数，不暴露通用命令执行接口。
- Agent 默认限制在用户选定的工作区内访问文件。
- 命令执行、工作区外访问及其他敏感能力采用可配置的审批策略。
- API Key 只在受信任的后端进程中使用，日志和错误信息必须脱敏。
- 所有长时间运行的任务都需要支持取消、超时和异常恢复。
- Diff 只用于辅助审核；不能把“显示了 Diff”等同于用户已授权写入。

## 建议目录结构

```text
pi-desktop/
├── apps/
│   └── desktop/
│       ├── src/main/       # Electron 主进程
│       ├── src/preload/    # 安全 IPC Bridge
│       └── src/renderer/   # React 应用
├── packages/
│   ├── agent/              # Pi Adapter 与 Agent 服务
│   ├── contracts/          # IPC、事件和领域类型
│   ├── storage/            # SQLite 与数据访问
│   └── ui/                 # 可复用 UI 组件
├── docs/                   # 架构、协议与产品文档
└── README.md
```

项目初期可以先保持较少的包数量；只有出现清晰的跨进程或复用边界后，再拆分独立 package。

## 实施路线

### 阶段一：基础闭环

- 初始化 Monorepo、Electron、React 和 TypeScript
- 定义 IPC 与 Agent Event 协议
- 接入 Pi 并完成流式对话
- 展示工具调用并支持停止任务

### 阶段二：开发工作流

- 工作区与历史会话持久化
- 文件变更追踪和 Diff 审核
- 权限审批流程
- 集成终端

### 阶段三：产品化

- 模型与密钥管理
- 崩溃恢复、日志与诊断
- 应用打包、签名和自动更新
- 性能、可访问性与跨平台验证

## 平台计划

开发阶段优先支持 macOS，架构上避免依赖单一平台能力，并为 Windows 和 Linux 保留适配层。正式声明跨平台支持前，需要分别验证 PTY、Keychain、Shell、文件权限、应用签名和自动更新链路。

## 当前状态

项目处于设计与脚手架准备阶段。下一步是初始化工程结构，并完成一个最小技术验证：从桌面 UI 创建 Pi Session、发送消息、接收流式事件以及停止任务。

## License

许可证尚未确定。在明确 Pi 相关依赖的许可证兼容性及项目发布方式后补充。

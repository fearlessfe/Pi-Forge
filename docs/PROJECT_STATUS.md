# Pi Forge 当前项目状态与后续工作

> 最后审计：2026-08-06
> 适用范围：当前 `main` 分支的 `apps/desktop` 参考实现
> 文档用途：新对话、需求评审和迭代规划的状态入口。开始较大任务前先阅读本文，再以当前源码和测试复核相关条目。

## 1. 使用与维护规则

本文是项目进度的“活文档”，不是不可变的产品承诺。

- **源码和自动化测试是事实来源**；本文、README 或旧路线图冲突时，以当前源码为准并同步修正文档。
- 完成功能后，在同一个改动中更新对应状态、证据路径和验证结果。
- 新增路线图项目时，必须标注优先级、完成定义和依赖，避免只写宽泛方向。
- 不要把“已有接口或 UI 槽位”写成“完整能力已交付”；部分完成项应明确剩余边界。
- 不要自动重放可能产生副作用的中断工具调用，除非已经建立可靠的幂等协议。

建议新对话先执行：

1. 阅读 `AGENTS.md` 和本文；
2. 查看 `git status --short` 与最近提交；
3. 针对将要修改的领域读取对应源码和测试；
4. 在项目要求的 Node/pnpm 环境中运行相关验证。

## 2. 当前已完成基线

本地桌面 Agent 核心闭环已经可用，主要包括：

- 模型 Provider、兼容端点、API Key/OAuth 与系统凭据链；
- 本地会话持久化、恢复、Fork、重命名、标签、归档和导出；
- Pi Session、多轮上下文、compaction、上下文预算、Token 和费用记录；
- 工具调用、用户询问、计划审阅、停止、steering 和 follow-up 队列；
- 独立 Runtime 子进程、RPC timeout、heartbeat、崩溃熔断和安全续跑记录；
- 不同会话使用隔离 Runtime，最多允许 3 个主任务并行；
- 文件 Diff、修改审阅、哈希保护回退；
- 工作区边界、项目信任、权限审批和 macOS/Linux 命令沙箱；
- 用户级/可信项目级 stdio 与 Streamable HTTP MCP；
- 插件预验证、完整性校验、内容扫描、禁用 lifecycle scripts 和 legacy 重验；
- 扩展、技能、Prompt、主题和包资源管理；
- 持久化 Subagent Session、运行状态与 usage 记录；
- 本地 Trace、OTLP HTTP 导出、内容采集等级和凭据脱敏；
- 集成终端、内置浏览器和浏览器页面标注；
- Markdown 安全外链和受工作区约束的文件引用打开；
- 会话索引、分页、服务端搜索和 `conversation.updated` 增量事件；
- 流式事件批处理、消息 memo、真实视口测量和有界 DOM 窗口化；
- 双主题、reduced-motion、forced-colors、缩放和 golden 验证脚本。
- MIT 开源许可证及 README/package 分发元数据；
- Renderer 崩溃熔断、无响应提示、受控重载和活动 Agent 事件恢复；
- 原生平台 packaged-app 启动冒烟、精确 Release 产物校验和 SHA-256 校验清单。

关键证据：

- Runtime 并发：`apps/desktop/electron/agent-runtime-pool.ts`
- Runtime 可靠性：`apps/desktop/electron/agent-runtime-client.ts`
- Agent 主服务：`apps/desktop/electron/agent-service.ts`
- 会话增量事件：`apps/desktop/src/contracts.ts`、`apps/desktop/src/conversation-updates.ts`
- 长会话窗口化：`apps/desktop/src/conversation-window.ts`
- 性能 fixture：`apps/desktop/src/conversation-performance-fixture.ts`
- 工作区文件链接：`apps/desktop/src/conversation-presentation.ts`、`apps/desktop/electron/main.ts`
- Subagent 持久化：`apps/desktop/electron/subagent-run-store.ts`
- Trace：`apps/desktop/electron/observability-service.ts`、`apps/desktop/electron/trace-aggregator.ts`

## 3. 路线图状态

### P0：公开发布前阻断项

#### P0-1 正式开源许可证

**状态：已完成。** 根目录包含 MIT `LICENSE`，README、根 package 和桌面 package 已同步许可证元数据。

完成定义：

- 确认许可证；
- 添加正式 `LICENSE`；
- 同步 README、贡献说明和分发元数据。

#### P0-2 安装包签名、公证与可信发布

**状态：部分完成。** Release 会校验精确产物集合、拒绝自动更新 metadata，并生成 `SHA256SUMS`；平台签名、公证、SBOM 和 provenance 仍未完成。

证据：

- `.github/workflows/release.yml`
- `apps/desktop/package.json`

完成定义：

- macOS Developer ID 签名、hardened runtime、entitlements 和 notarization；
- Windows Authenticode；
- Release 验证签名、公证和安装后启动；
- 补充 SBOM 和 artifact provenance。

#### P0-3 Packaged-app 发布冒烟

**状态：已完成。** 每个平台在上传前启动 unpacked packaged app，验证 preload、IPC、Runtime handshake 和 node-pty；任何失败都会阻止发布。

证据：

- `.github/workflows/release.yml`
- `apps/desktop/scripts/smoke-packaged.mjs`
- `apps/desktop/scripts/verify-release-assets.mjs`

完成定义：

- 每个平台至少验证安装包/解包应用能启动；
- 验证 preload/IPC、Runtime handshake 和基础会话；
- 对支持的平台验证 node-pty；
- 失败时阻止发布。

### P1：近期产品与可靠性

#### P1-1 Renderer 崩溃与无响应恢复

**状态：已完成。** Main 处理崩溃、无响应和页面代际，连续崩溃后停止自动重载；Renderer 重连后恢复 Runtime 状态并从有界事件 journal 重建活动 turn，不自动重放工具调用。

完成定义：

- 处理 `render-process-gone`、`unresponsive` 和 `responsive`；
- 提供恢复页或受控重载；
- 重载后重新同步仍在运行的 Agent 状态；
- 连续崩溃时停止自动重载并显示日志位置。

主要位置：`apps/desktop/electron/main.ts`、`apps/desktop/electron/renderer-recovery.ts`、`apps/desktop/src/App.tsx`。

#### P1-2 完整、可查询、可重放的 Runtime 事件流

**状态：未完成。** 当前有 Session JSONL 和聚合 Trace span，但没有完整桌面 Runtime 事件存储。

完成定义：

- 持久化稳定版本的完整运行事件；
- 支持按 conversation/run/turn/tool call 查询；
- 支持 checkpoint、offset 和 schema 迁移；
- 能重放状态，不把 Trace span 或 Session 消息误当作完整事件流。

#### P1-3 稳定公共契约与定制 Agent SDK

**状态：部分完成（公共契约 v0 第一阶段）。** 仓库已有真实 `packages/runtime-contracts` workspace package，Desktop client/worker 通过它共享版本化 Runtime envelope、method/capability/error 语义、Session/Event 类型和运行时 schema validator。协议 v0 使用精确版本兼容；必需 capability 缺失、未知方法、版本不兼容和 malformed envelope 都会 fail closed。该 package 仍为私有 `0.0.0` 内部预发布契约，不是稳定 v1。

已完成边界：

- compatibility fixtures、schema validation、JSON round-trip 和 capability negotiation 测试；
- client/worker method 清单穷尽性检查，以及 client 对畸形 worker 消息的断路；
- 凭据、MCP、浏览器和桌面服务 host RPC 仍保留在 Electron 私有层，没有进入公共 package。

剩余工作：完整耐久事件流及其 offset/checkpoint/迁移语义、可发布 SDK、最小示例 Agent 和模板、v1 兼容政策；这些均不属于本阶段。

完成定义：

- 提取并版本化 Runtime、Session、Event 和 Hand 契约；
- 提供 SDK、最小示例 Agent 和模板；
- 明确兼容性、错误和生命周期语义；
- 不破坏 Renderer/Main/Runtime 的安全边界。

当前相关位置：

- `packages/runtime-contracts`
- `apps/desktop/src/contracts.ts`
- `apps/desktop/electron/agent-runtime-protocol.ts`
- `pnpm-workspace.yaml`

#### P1-4 持久化、可恢复的后台 Subagent 调度

**状态：部分完成。** 已有持久 Session、运行记录和 usage，但 Subagent 仍作为父任务工具调用执行；应用重启后不能自动继续。

剩余工作：

- 独立后台生命周期；
- 持久任务队列、暂停、继续和重试；
- 独立历史和状态 UI；
- 重启恢复策略；
- Agent handoff 与结果移交。

证据：

- `apps/desktop/electron/agent-service.ts`
- `apps/desktop/electron/subagent-run-store.ts`

#### P1-5 浏览器隐私与标注截图生命周期

**状态：未完成。** 浏览器固定使用 `persist:pi-desktop-browser`；标注截图直接写临时目录。

完成定义：

- 清除 Cookie、缓存和站点存储；
- 可选临时隐私 partition；
- UI 显示持久/隐私状态；
- 截图记录 owner、创建时间、TTL 和容量上限；
- 启动时异步清理无引用过期文件。

主要位置：`apps/desktop/electron/browser-service.ts`。

#### P1-6 CI 中的 UI/Electron/可访问性门禁

**状态：部分完成。** 验证脚本已经存在，但未接入 CI/Release。

现有脚本：

- `pnpm verify:tokens`
- `pnpm verify:renderer`
- `pnpm verify:electron`
- `pnpm verify:a11y`
- `pnpm verify:golden`

剩余工作：

- PR 快速车道接入 tokens、renderer smoke 和关键 Electron IPC；
- nightly 接入完整 a11y/golden/Electron；
- release 已接入 packaged-app 启动；剩余升级/回滚测试。

证据：`.github/workflows/ci.yml`、`.github/workflows/release.yml`。

#### P1-7 性能与 bundle 自动预算

**状态：部分完成。** 已有 100-turn fixture、视口窗口化、DOM 和流式刷新预算常量，但没有真实 Performance trace 和 CI bundle gate。

剩余工作：

- 固化 Chromium/React Profiler trace；
- 建立启动时间和主 chunk 大小预算；
- CI 超阈值失败或要求解释；
- 保存同 fixture 的前后对比证据。

证据：

- `apps/desktop/src/conversation-performance-fixture.ts`
- `apps/desktop/src/conversation-window.ts`

### P2：平台化与长期方向

#### P2-1 未完成工具调用的幂等重放

**状态：未完成。** 当前恢复通过新 prompt 要求 Agent 检查现状，不会自动重放中断工具调用。

需要：工具执行 ID、提交记录、去重协议和副作用确认。建立这些能力前必须保持当前 fail-safe 行为。

主要位置：

- `apps/desktop/electron/agent-runtime-pool.ts`
- `apps/desktop/electron/runtime-recovery-store.ts`

#### P2-2 可 Provision、可替换的远程 Sandbox

**状态：未完成。** 当前只有本机工作区命令沙箱。

长期方向：Local/Docker/Remote 后端、环境 Provision、快照、回收和统一执行接口。

主要位置：`apps/desktop/electron/workspace-command-sandbox.ts`。

#### P2-3 Agent 之间共享或移交 Hands

**状态：未完成。** 还没有 Hand 租约、委托、撤销和跨 Agent 审计协议。

#### P2-4 凭据代理和细粒度完整审计

**状态：部分完成。** 已有 `safeStorage`、权限、工作区策略和 Trace 脱敏；尚缺短期凭据、按 Agent/Tool/Resource 授权、租约和独立凭据代理。

#### P2-5 Evaluate、多角色模型路由和 Training Bridge

**状态：未完成。** 尚无完整 LLM Judge、Self Verify、Benchmark 管理、角色到模型映射，以及 SFT/RL 轨迹导出流水线。

方向文档：`docs-internal/harnessx-expansion-plan.md`。

#### P2-6 内建 Memory / Learning 子系统

**状态：部分完成。** 插件提供者槽位、配置、加载过滤和 UI 已存在，但项目本身没有内建 Extract/Store/Retrieve Memory 或自动学习实现。

证据：

- `apps/desktop/electron/capability-policy.ts`
- `apps/desktop/electron/capability-store.ts`
- `apps/desktop/src/components/PluginsPanel.tsx`

#### P2-7 企业控制面

**状态：未完成。** 包括组织/项目/环境策略、企业身份、私有部署控制面、团队协作、云端同步、分布式调度和内部 Agent/工具目录。

### 明确占位功能

#### Pi 宠物 / 陪伴模式

**状态：未实现。** UI 已有入口，点击只显示“后续版本接入”。

证据：

- `apps/desktop/src/components/ConversationSidebar.tsx`
- `apps/desktop/src/App.tsx`

在正式实现前，可选择保留并标记预览，或移除用户可见入口，避免误导。

## 4. 工程结构后续项

这些不是独立产品能力，但影响稳定性和迭代效率：

- 顶层和面板级 `ErrorBoundary` 尚未实现；
- `apps/desktop/src/App.tsx` 仍约 1,473 行；
- `apps/desktop/electron/agent-service.ts` 仍约 1,512 行；
- `apps/desktop/electron/main.ts` 仍约 727 行，IPC 注册尚未完全按域拆分；
- 多个 Renderer 组件直接访问 `window.piDesktop`，没有统一领域 API 入口；
- 目前只有 `TerminalPanel` 懒加载，Settings、Plugin Center、Markdown 等仍可继续按测量结果拆分；
- 根目录缺少 `.node-version`、Volta 或 mise 等本地 Node 固定文件；
- UI 组件和若干 Electron 入口仍被单元覆盖率排除，需要 E2E/设计车道补足，而不是简单追求覆盖率数字。

相关旧计划：`docs-internal/refactor-plan.md`。执行时应重新按当前代码评估，不要照搬旧行号或已完成项。

## 5. 已确认过时的旧描述

以下旧文档内容已经落后于当前源码，后续不应再当作未完成项：

1. **“同一应用实例只运行一个主 Agent 任务”**：当前最多支持 3 个不同会话并行。
2. **“内置 Subagent 是内存 Session”**：当前已有持久 Session 和 `SubagentRunStore`，但还不能后台恢复。
3. **“Markdown 工作区文件引用不可打开”**：已实现 Renderer 分类和 Main 工作区/realpath 校验。
4. **“长历史只有最近 80 条和手动扩窗”**：已实现真实视口测量、动态高度和有界 DOM 窗口化。
5. **“缺少统一 `conversation.updated`”**：契约、Runtime 和 Renderer 已接通。
6. **“缺少 100-turn 性能 fixture”**：fixture 和预算逻辑已存在；缺的是浏览器 trace 与 CI gate。

需要后续同步的文档：

- `README.md`
- `README.zh-CN.md`
- `docs-internal/client-optimization-roadmap-2026-07.md`

## 6. 建议执行顺序

### 如果近期准备公开发布

1. 签名和公证；
2. SBOM 与 artifact provenance；
3. 自动更新、升级验证和回滚；
4. CI 接入 Electron、renderer 和 a11y 门禁。

### 如果近期继续建设 Agent 平台

1. 定义稳定 Event/Runtime/Session/Hand 契约；
2. 实现完整耐久事件流和查询 API；
3. 提取可发布 Runtime/SDK 与示例模板；
4. 将 Subagent 提升为持久后台调度单元；
5. 再设计幂等工具协议、远程 Sandbox 和 Hand 移交。

### 如果近期聚焦桌面体验

1. 浏览器隐私和截图清理；
2. 移除或实现“Pi 宠物”占位入口；
3. ErrorBoundary 与领域 API 收敛；
4. 用真实性能数据决定进一步懒加载和结构拆分。

## 7. 最近一次验证状态

2026-08-06 当前改动验证：

- `pnpm lint`：通过；
- `pnpm typecheck`：通过；
- `pnpm test`：通过（Runtime contracts 1 个文件/9 项，Desktop 62 个文件/427 项）；
- `pnpm test:coverage`：通过（Runtime contracts statement 97.32%、branch 86.66%、function 98.55%、line 96.66%；Desktop statement 89.73%、branch 82.97%、function 92.22%、line 93.92%）；
- `pnpm build`：通过，包含 `@pi-forge/runtime-contracts` declaration/ESM 构建和 Desktop 生产构建；
- `pnpm package:dir` 与 `pnpm package`：Apple Silicon macOS 本机通过；
- packaged smoke：通过 preload、IPC、Runtime handshake 和 node-pty；
- Release 产物脚本：真实 macOS DMG/ZIP 校验通过，7 个跨平台 fixture 的 `SHA256SUMS` 生成通过，注入 `.blockmap` 后按预期拒绝发布集合。

发布前仍应运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

涉及 UI/Electron 时再运行相关 `verify:*` 车道。

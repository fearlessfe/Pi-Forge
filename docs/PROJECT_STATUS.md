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
- 持久化后台 Subagent 队列、Session、六态生命周期、usage、重启恢复和显式结果移交；
- 本地 Trace、OTLP HTTP 导出、内容采集等级和凭据脱敏；
- 集成终端、内置浏览器、持久/隐私浏览模式和有生命周期的页面标注截图；
- Markdown 安全外链和受工作区约束的文件引用打开；
- 会话索引、分页、服务端搜索和 `conversation.updated` 增量事件；
- 流式事件批处理、消息 memo、真实视口测量和有界 DOM 窗口化；
- 双主题、reduced-motion、forced-colors、缩放和 golden 验证脚本。
- MIT 开源许可证及 README/package 分发元数据；
- Renderer 崩溃熔断、无响应提示、受控重载和活动 Agent 事件恢复；
- 原生平台 packaged-app 启动冒烟、精确 Release 产物校验和 SHA-256 校验清单。
- PR/push 的 token、renderer、关键 Electron IPC 快速门禁，以及 nightly/手动完整 UI、a11y、golden、Electron 门禁。

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

**状态：已完成。** Electron Main 现在将完整桌面 `AgentEvent` 追加到独立的版本化 JSONL 事实日志；每条记录在对外可查询前完成 `fsync`，并获得全局单调 offset、稳定 event ID、记录时间以及 conversation/run/turn/tool call 作用域。

Renderer 通过严格 schema 校验的 preload API 按作用域、事件类型和 `afterOffset` 分页查询；命名 checkpoint 独立原子持久化。存储可以把旧版无 manifest 的 `events.jsonl` 迁移为 v1，恢复迁移中断和末尾 torn write，并拒绝未知未来版本。状态重放从事实事件归约出 run、turn、流式文本和工具生命周期，不依赖 Trace span 或 Session 消息冒充事件流。

完成定义：

- 持久化稳定版本的完整运行事件；
- 支持按 conversation/run/turn/tool call 查询；
- 支持 checkpoint、offset 和 schema 迁移；
- 能重放状态，不把 Trace span 或 Session 消息误当作完整事件流。

证据：

- `apps/desktop/electron/runtime-event-store.ts`
- `apps/desktop/electron/runtime-event-store.test.ts`
- `apps/desktop/electron/main.ts`
- `apps/desktop/electron/preload.cts`
- `packages/runtime-contracts/src/events.ts`

#### P1-3 稳定公共契约与定制 Agent SDK

**状态：已完成。** `@pi-forge/runtime-contracts` 与 `@pi-forge/runtime-sdk` 均为可发布的公开 `1.0.0` package。协议 major 为 v1；Desktop client/worker 与 SDK client/host 共享版本化 envelope、method/capability/error、Runtime/Session/Event/Hand 类型和 fail-closed validator。

已完成边界：

- v1 compatibility fixtures、schema validation、JSON round-trip、capability negotiation、heartbeat、timeout 和结构化错误测试；
- 公开兼容政策明确 v1 内可兼容的可选 capability/field，以及必须升级 protocol major 的破坏性变化；
- transport-neutral SDK 提供校验 client、Agent host、`defineAgent` manifest factory、请求分发和事件订阅；
- `templates/basic-agent` 是纳入 workspace typecheck/test/build 的最小可运行 Agent 模板；
- client/worker method 清单穷尽性检查，以及 Desktop 与 SDK client 对畸形消息的断路；
- 凭据、MCP、浏览器和桌面服务 host RPC 仍保留在 Electron 私有层，没有进入公共 package。

完成定义：

- 提取并版本化 Runtime、Session、Event 和 Hand 契约；
- 提供 SDK、最小示例 Agent 和模板；
- 明确兼容性、错误和生命周期语义；
- 不破坏 Renderer/Main/Runtime 的安全边界。

当前相关位置：

- `packages/runtime-contracts`
- `packages/runtime-sdk`
- `templates/basic-agent`
- `apps/desktop/src/contracts.ts`
- `apps/desktop/electron/agent-runtime-protocol.ts`
- `pnpm-workspace.yaml`

#### P1-4 持久化、可恢复的后台 Subagent 调度

**状态：已完成。** 内置 Subagent 工具现在只向 Main 权威路由的专用 control Runtime 入队，并立即把 queued 记录返回给父 Agent；父任务完成、停止或 conversation worker 回收不会终止后台任务。

持久 store v2 提供 `queued/running/paused/completed/error/stopped` 六态、FIFO、attempt、原子 `fsync` 写入、v1 迁移、未知未来版本 fail-closed，以及把重启时的 running 任务安全恢复到队列。单例 scheduler 支持暂停、继续、重试、停止和同一 child Session 的恢复续跑；所有 child 执行硬限制为 `read/grep/find/ls`，禁用扩展、MCP、浏览器和写工具。

Renderer 提供独立历史/状态面板和生命周期操作。完成结果只能在 Main 验证 parent conversation 与完成状态后显式填入父会话输入框，不会自动触发新的模型请求。Subagent 生命周期同时写入完整 Runtime 事件流。

证据：

- `apps/desktop/electron/subagent-run-store.ts`
- `apps/desktop/electron/subagent-scheduler.ts`
- `apps/desktop/electron/agent-runtime-pool.ts`
- `apps/desktop/src/components/SubagentPanel.tsx`
- `packages/runtime-contracts/src/session.ts`

证据：

- `apps/desktop/electron/agent-service.ts`
- `apps/desktop/electron/subagent-run-store.ts`

#### P1-5 浏览器隐私与标注截图生命周期

**状态：已完成。** 浏览器保留 `persist:pi-desktop-browser` 持久 partition，并可切换到 Main 生成的临时内存 partition；UI 持续显示当前模式。关闭或离开隐私模式会销毁对应 `WebContentsView`，清空其 session 数据、HTTP cache 并关闭连接，不销毁或清理持久 View/session。

Renderer 只能请求清理枚举化的 Cookie、HTTP cache 或 local/session storage，不能指定 partition；Main 使用严格 IPC schema 验证后执行。localStorage 通过 Electron session 清理，sessionStorage 通过销毁目标 WebContents 的浏览上下文清理。

标注截图由独立 artifact store 管理，metadata 包含 owner、创建时间、TTL/过期时间、字节数和路径；默认 TTL 24 小时、最多 32 张、总计 256 MiB。启动时异步删除没有 manifest 引用、已过期或超出配额的截图。

完成定义：

- 清除 Cookie、缓存和站点存储；
- 可选临时隐私 partition；
- UI 显示持久/隐私状态；
- 截图记录 owner、创建时间、TTL 和容量上限；
- 启动时异步清理无引用过期文件。

主要位置：`apps/desktop/electron/browser-service.ts`。

其他证据：

- `apps/desktop/electron/browser-artifact-store.ts`
- `apps/desktop/electron/ipc-input-validation.ts`
- `apps/desktop/src/components/BrowserWorkbench.tsx`
- `apps/desktop/electron/browser-service.test.ts`
- `apps/desktop/electron/browser-artifact-store.test.ts`

#### P1-6 CI 中的 UI/Electron/可访问性门禁

**状态：已完成。** PR/push 快速车道在固定 Node/pnpm 版本的 Ubuntu Runner 上执行 token、四场景双主题 renderer smoke，以及真实 preload/主题 IPC 往返；nightly/手动车道在 macOS 上执行完整 renderer、a11y、Electron 与 golden 验证。两条车道缓存 pnpm 与固定 Playwright Chromium，失败时上传已有截图、diff 和分步日志。

验证入口：

- `pnpm verify:tokens`
- `pnpm verify:renderer:smoke`
- `pnpm verify:electron:smoke`
- `pnpm verify:renderer`
- `pnpm verify:electron`
- `pnpm verify:a11y`
- `pnpm verify:golden`

分层边界：

- smoke 模式是新增的显式入口，不改变现有完整命令；renderer smoke 只跳过易受共享 Runner 负载影响的 PERF-01 时延/长会话探针，Electron smoke 只跳过真实 node-pty 与原生 WebContentsView 场景；
- golden 依赖三条完整车道在同一 macOS Runner 产出截图，且只比较、不自动更新人工确认的基线，因此不进入每个 PR；
- Release 已接入各原生平台 packaged-app 启动；自动更新、升级与回滚测试仍未完成，归入发布可靠性后续工作。

证据：`.github/workflows/ci.yml`、`.github/workflows/ui-verification.yml`、`.github/workflows/release.yml`、`docs/design/verify-*-lane.mjs`。

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
- UI 组件和若干 Electron 入口仍被单元覆盖率排除，由 renderer/Electron/a11y 设计车道补证；仍需按风险扩充真实交互覆盖，而不是简单追求单元覆盖率数字。

相关旧计划：`docs-internal/refactor-plan.md`。执行时应重新按当前代码评估，不要照搬旧行号或已完成项。

## 5. 已确认过时的旧描述

以下旧文档内容已经落后于当前源码，后续不应再当作未完成项：

1. **“同一应用实例只运行一个主 Agent 任务”**：当前最多支持 3 个不同会话并行。
2. **“内置 Subagent 仍绑定父工具调用”**：当前已由专用 control Runtime 持久后台调度，可独立暂停、继续、重试并在重启后恢复。
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
4. 在 Windows/Linux 扩充签名后安装、升级和回滚的 UI 取证。

### 如果近期继续建设 Agent 平台

1. 定义稳定 Event/Runtime/Session/Hand 契约；
2. 实现完整耐久事件流和查询 API；
3. 提取可发布 Runtime/SDK 与示例模板；
4. 扩展 Subagent 调度策略与可选并发上限；
5. 再设计幂等工具协议、远程 Sandbox 和 Hand 移交。

### 如果近期聚焦桌面体验

1. 移除或实现“Pi 宠物”占位入口；
2. ErrorBoundary 与领域 API 收敛；
3. 用真实性能数据决定进一步懒加载和结构拆分。

## 7. 最近一次验证状态

2026-08-06 Runtime 事件流、Runtime v1/SDK、后台 Subagent、浏览器隐私与 UI CI 集成验证：

- `pnpm lint`：通过；
- `pnpm typecheck`：通过；
- Runtime contracts v1：通过（2 个文件、10 项测试）；Runtime SDK：通过（1 个文件、11 项测试），覆盖率 statements 96.89%、branches 91.36%、functions/lines 100%；基础 Agent 模板：通过（1 个文件、1 项测试）；
- Desktop test/coverage：通过（66 个文件、459 项测试）；覆盖率 statements 88.11%、branches 82.13%、functions 89.46%、lines 92.56%；Runtime contracts 覆盖率 statements 97.60%、branches 86.66%、functions 98.78%、lines 96.90%；
- `pnpm build`：合并态通过，包含 `@pi-forge/runtime-contracts` declaration/ESM 构建和 Desktop 生产构建；
- `pnpm verify:tokens`：通过（54 个 token 工具类）；
- `pnpm verify:renderer:smoke` 与完整 `pnpm verify:renderer`：通过（四场景双主题、100-turn 性能场景、无 console/pageerror）；
- `pnpm verify:electron:smoke`：通过（真实 preload、BrowserWindow 背景与主题 IPC 往返）；
- `pnpm verify:electron`：通过 Main/Preload/IPC、Runtime init、终端、浏览器双主题，以及持久/隐私 partition、三类清理和隐私 View 销毁真实链路。当前远程 macOS 可达到的内容区为 1440×893，因此使用 `PI_DESKTOP_VERIFY_CONTENT_HEIGHT=893`；脚本默认黄金基线仍为 1440×897；
- `pnpm verify:a11y`：通过 reduced-motion、forced-colors 和 125%/150% 缩放断言。
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

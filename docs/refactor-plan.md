# Pi Desktop 改造方案

基于 2026-07 架构评审（见下"问题清单"）制定。总原则：**不改变三层边界架构方向**（渲染层 / 主进程 / Agent Runtime），优先消除安全与稳定性风险，再做可维护性拆分；每阶段独立交付、可验证，不做大爆炸式重写。

## 问题清单（评审结论摘要）

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| P1 | Runtime 重启无熔断，init 崩溃会无限重启 | `electron/agent-runtime-client.ts:297-319` | 高 |
| P2 | 进程边界层（runtime client/worker、main.ts）无直接测试且被排除出覆盖率 | `vitest.config.ts` | 高 |
| P3 | 渲染层传入的 `cwd` 只校验存在性，可任意重定义权限策略的工作区边界 | `agent-service.ts:1782-1790` | 高 |
| P4 | 渲染层无 CSP | `index.html`、`main.ts` | 中高 |
| P5 | 11 个依赖使用 `latest` 说明符（含 TypeScript、Vite） | `apps/desktop/package.json` | 中高 |
| P6 | `agent-service.ts` 1807 行 god object，ResourceLoader 构造重复 3 次 | `electron/agent-service.ts` | 中 |
| P7 | `App.tsx` 1108 行 / 28 个 useState / 20-30 props 钻取；桥接访问模式不统一 | `src/App.tsx` | 中 |
| P8 | `react/exhaustive-deps` 被禁用，存在真实陈旧闭包风险 | `.oxlintrc.json`、`App.tsx:232-278, 964-980` | 中 |
| P9 | 渲染层 UI 实质无测试（组件全部排除出覆盖率，仅 1 个 server-render 测试） | `vitest.config.ts:24-27` | 中 |
| P10 | CI 不跑 `pnpm build`，构建破坏可混过 CI | `.github/workflows/ci.yml` | 中 |
| P11 | `styles.css` 7025 行单文件 + Tailwind 接入但零使用 | `src/styles.css` | 低 |
| P12 | 插件安装无 tarball 完整性哈希校验 | `electron/plugin-service.ts` | 低 |
| P13 | 产品命名分裂（Pi Forge / Pi Desktop）；无 ErrorBoundary；store 持久化样板重复 ~10 处 | 多处 | 低 |

---

## 阶段 0：工程纪律加固（1~2 天，纯低风险）

**目标**：不动架构，先把"静默漂移"类的风险钉死。

1. **钉死依赖版本**（P5）
   - `apps/desktop/package.json` 中 11 个 `latest` 全部改为 lockfile 当前解析出的精确版本（react 19.2.8、vite 8.1.5、typescript 7.0.2、tailwindcss 4.3.3 等）。
   - 评估是否给 TypeScript 7.x（原生工具链，过新）回退到 5.x 稳定线——单独验证 `pnpm build && pnpm test` 后决定，不强行回退。
   - 验收：`pnpm install --frozen-lockfile` 无 diff；lint/typecheck/test 全绿。
2. **CI 增加构建检查**（P10）
   - `.github/workflows/ci.yml` 新增 job 或在现有 job 追加 `pnpm build`（ubuntu 即可，不需要打包）。
   - 验收：人为制造一个 Vite 构建错误，CI 变红。
3. **补 CSP**（P4）
   - 在 `main.ts` 用 `session.defaultSession.webRequest.onHeadersReceived` 注入 CSP（覆盖 dev server 与打包两种加载方式，比 index.html meta 更可靠）。基线：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`，dev 模式下放行 `connect-src ws://127.0.0.1:4173`（HMR）。
   - 注意先验证 `react-markdown` 输出、xterm、Radix 在内联样式上的实际需求，宁可 `'unsafe-inline'` 仅限 style。
   - 验收：dev 与 `pnpm package:dir` 两种模式下应用功能正常；DevTools 无 CSP 违规报错。
4. **修正 `tsconfig.test.json` include 漂移**（P13）：把 `response-usage`、`file-changes`、`terminal-urls`、`i18n` 等新测试文件补进 include，或改为 glob。
5. **命名统一决策**（P13）：产品名二选一（建议跟随仓库名统一为 "Pi Forge" 或确认对外品牌为 "Pi Desktop"），改 `package.json` productName 或 `App.tsx:987` 及 i18n 文案。纯文案/配置修改。

---

## 阶段 1：Runtime 边界加固与测试（3~5 天）

**目标**：进程边界层从"零直接测试"变为有熔断、有回归保护。

1. **重启熔断**（P1）
   - `agent-runtime-client.ts`：滑动窗口统计崩溃次数（如 60 秒内 ≥3 次），进入 `crash-looping` 状态：停止自动重启，通过既有事件通道通知渲染层，提供"手动重试"IPC。
   - `contracts.ts` / preload / `App.tsx` 同步增加该状态与重试方法（遵循 AGENTS.md 的契约三路更新要求）。
2. **`agent-runtime-client.test.ts`**（P2）
   - mock `child_process.fork`，覆盖：协议版本握手失败、pending 请求在子进程 exit 时全部 reject、重启退避序列、熔断触发、`RuntimeRecoveryStore` 标记 interrupted、host.request 反向调用路由。
   - 是否把 client/worker 移出覆盖率排除名单：移出 client，worker 保持排除（它是薄 dispatcher，价值低）。
3. **工作区 cwd 约束**（P3）
   - 在 `resource-store.ts` 持久化"用户选择过的工作区"列表（打开目录时记录）。
   - `agent:send` 及所有接受 cwd 的 IPC：校验 cwd ∈ 已记录工作区（realpath 规范化后比较），拒绝则报错。
   - 同步更新 `resource-store.test.ts` 与相关 agent-service 测试。
4. **插件完整性校验**（P12，可并入本阶段）：安装时记录并校验 npm `dist.integrity`（ssri 或手写 sha512 base64 比对，避免新依赖）。

**阶段验收**：新增测试全绿；模拟 worker 启动即崩，应用在 3 次后进入熔断态且 UI 可见；非法 cwd 的 `agent:send` 被拒。

---

## 阶段 2：拆分 `agent-service.ts`（5~8 天）

**目标**：1807 行 → 门面 + 4 个内聚模块，不改变任何对外行为。

按既有测试（`agent-service.test.ts` 1143 行）做保护网，逐块平移，每步跑测试：

1. **`file-changes.ts`**（约 300 行）：变更捕获、diff、回滚、hash 冲突校验（现 `agent-service.ts:1658-1747` 一带）。这是安全敏感逻辑，测试同步平移。
2. **`model-catalog.ts`**（约 250 行）：模型目录、发现、HTTP 探测（430-482 一带）。
3. **`conversation-history.ts`**：历史、fork、导出、元数据。
4. **ResourceLoader 工厂**：三处重复的 `DefaultResourceLoader` 构造（873-895、1190-1252、1306-1341）抽成一个工厂函数，插件过滤闭包收敛到一处。
5. `AgentService` 保留为门面，组合以上模块；13 个构造依赖随拆分自然缩减。

**阶段验收**：`agent-service.ts` < 800 行；`pnpm lint && pnpm typecheck && pnpm test:coverage` 全绿，覆盖率不下降；行为零变化（不改测试断言，只改导入路径）。

---

## 阶段 3：渲染层状态与结构重构（5~8 天）

**目标**：拆掉 `App.tsx` god component，统一桥接访问，消除闭包隐患。不引入新依赖。

1. **统一桥接入口**：新建 `src/api.ts`，封装 `window.piDesktop` 为带类型的领域模块（`api.agent`、`api.plugins`…）。所有组件（`PluginsPanel`、`BrowserWorkbench` 等 20 处直接调用）改为经 `api.ts`，为后续测试 mock 提供单点。
2. **按域拆分状态**：28 个 useState 按域收敛为 4~5 个 custom hook（`useAgentSession`、`useConversations`、`useSettings`、`useWorkbenchLayout`），用 Context 提供给深层组件，消灭 20~30 个 props 的钻取（`SettingsView` ~30 props、`NewChatView` 23 props）。`applyAgentEvent`（`App.tsx:76-166`，已是纯函数）直接迁移为 reducer。
3. **重新启用 `react/exhaustive-deps`**（P8）：先修 `App.tsx:232-278`（订阅 effect 缺 `t`/`refresh*`）与 `964-980`（闭包捕获 `startNewChat`）两处已知问题，再全局启用并清零告警。
4. **加 `ErrorBoundary`**：顶层一个 + 各面板级一个，渲染异常不再白屏整个应用。
5. 顺手治理：会话内 `conversationTurns`/`conversationContexts` 缓存加上限（如 LRU 100 条）。

**阶段验收**：`App.tsx` < 300 行；lint（含 exhaustive-deps）零告警；人工双主题冒烟通过。

---

## 阶段 4：样式与 UI 测试策略（需团队决策后执行）

这两项是路线决策，不预设结论：

1. **样式二选一**（P11）
   - 方案 A（推荐）：保留手写 CSS，移除 Tailwind 依赖与 Vite 插件；把 `styles.css` 按组件域拆分为 `styles/` 下多文件（tokens、layout、chat、settings…），CSS 变量设计令牌不动。理由：7025 行已是事实上的设计系统，迁移 Tailwind 成本大收益小。
   - 方案 B：逐步迁移 Tailwind 工具类，冻结 `styles.css` 新增。仅在团队明确偏好 Tailwind 时选择。
2. **UI 测试二选一**（P9）
   - 方案 A（推荐，成本低）：Vitest + happy-dom/jsdom + Testing Library，覆盖关键交互组件（`NewChatView` 消息流、`SettingsView` 表单、`PluginsPanel`），借助阶段 3 的 `api.ts` mock 桥接。
   - 方案 B：把 `docs/design/` 的 Playwright 脚本正规化为 E2E 车道并接入 CI。成本高，建议作为后续增强。
3. 决策后取消 `vitest.config.ts` 对 `src/components/**` 的覆盖率豁免（逐步收紧，可先从新测试覆盖的文件开始）。

---

## 不做的事

- 不重写三层架构、不更换 SDK、不引入状态管理库（zustand/redux）——Context + reducer 足以覆盖当前规模。
- 不追求 runtime 子进程的"安全沙箱化"（明文 key 必须送达调模型的一侧，这是模型调用的固有约束），只做崩溃隔离的加固。
- 不做存储层抽象（`JsonFileStore` 样板去重）——~10 处 × 30 行的重复在当前阶段可接受，可在阶段 2 顺手做，不单独立项。

## 排期与依赖关系

```
阶段 0（1~2d）──┬──> 阶段 1（3~5d，P1/P2/P3 安全项）
                └──> 阶段 2（5~8d）──> 阶段 3（5~8d）──> 阶段 4（视决策）
```

- 阶段 1 与阶段 2 可并行（不同文件）。
- 阶段 3 依赖阶段 2 完成（避免 `agent-service` 契约变动与渲染层重构互相干扰）。
- 每个阶段独立 PR、独立验收；任何阶段中止都不影响已交付价值。

# Pi Desktop 样式改造方案 — 苹果设计语言方向（Tailwind v4 重构）

> 依据：Apple Human Interface Guidelines（[Color](https://developer.apple.com/design/human-interface-guidelines/color)、[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、[Typography](https://developer.apple.com/design/human-interface-guidelines/typography)）+ 对 `apps/desktop/src/styles.css`（7,033 行）的全量审计。已经过三轮评审修订。
> **路线决策（已确认）**：用 **Tailwind CSS v4** 重构样式，替换 7,033 行手写 CSS 单文件。依赖已就绪（`tailwindcss@4.3.3` + `@tailwindcss/vite` 已在 package.json，`@import "tailwindcss"` 与 Vite 插件实际已在运行，但**零 utility 使用**）。
> **改动范围**：以 CSS/Tailwind 为主，**允许以下最小 TS/Electron 改动**（纯样式无法实现的部分）：① `TerminalPanel.tsx` 的 xterm 主题随亮暗切换（当前 16 个色值硬编码在 TerminalPanel.tsx:37-50，xterm 在渲染进程内，无需 IPC）；② `browser-service.ts:286` 的原生视图背景随主题设置；③ Electron 窗口背景色。②③ 需要新增一条跨进程主题同步链路（见 3.6）。除此之外不动组件逻辑。

## 一、苹果设计语言的核心原则（调研结论）

1. **语义化动态颜色**：颜色按用途命名（label / secondaryLabel / separator / systemBackground…），而非按外观；每个颜色必须同时提供明暗两套变体，且不在代码里硬编码具体色值。
2. **用色克制**：强调色只留给"真正需要强调的元素"（关键操作、状态指示）；界面基色是中性灰。材质（Liquid Glass）上更要少彩色，彩色放在内容层。
3. **材质与层级**：导航/控件层（sidebar、toolbar）用半透明材质浮在内容层之上，帮助建立"功能层 vs 内容层"的层级感；内容层用标准材质区分分组。
4. **排版即可读性**：SF 字体族，层级靠字重（Regular/Medium/Semibold）而非字号轰炸；数字用等宽数字（tabular-nums）；代码用 SF Mono。（HIG 以 point 和系统文本样式表达，无全局 CSS 像素硬门槛；本项目自订可读性底线，见 3.2。）
5. **连续的圆角语言**：圆角分级且克制（小控件 ~6px、卡片 ~10-12px、面板 ~14-16px），全 App 一致。
6. **柔和的环境阴影**：低透明度、小范围的投影表达层级，不用重黑投影，不用彩色发光。
7. **尊重系统设置**：`prefers-reduced-motion` 下关闭装饰动画；焦点环微妙而可见；明暗外观尊重用户选择（本项目范围：首次启动尊重系统偏好，后续保留手动选择，见第七节）。

## 二、现状审计摘要（与 HIG 的差距）

| # | 问题 | 证据 |
|---|------|------|
| 1 | **变量缺失 bug**：`--panel`（styles.css:850, :870，横幅背景）与 `--muted-strong`（styles.css:5590，`.skill-copy`）被引用但从未定义，相关样式实际失效 | styles.css:850, :870, :5590 |
| 2 | **微排版**：全 App 最常用字号是 9.5px，大量 8/8.5/9px 标签，长期阅读吃力 | 9.5px×37 处 |
| 3 | **霓虹绿品牌色** `#7bf1a8` 高饱和，用于发光投影、扫描动画、焦点环等几十处 alpha 变体 | styles.css:16, :202, :1450 |
| 4 | **圆角混乱**：实际使用 15+ 种半径（2~18px 含非对称），3 个 token 只用了 16 次 | 全文统计 |
| 5 | **硬编码色绕过 token 形成深色孤岛**：终端主题 16 色硬编码在 TerminalPanel.tsx:37-50；浏览器原生视图 `setBackgroundColor("#0b0f15")`（browser-service.ts:286）；侧栏等另有硬编码 hex。浏览器工作台**已有部分浅色覆盖**（styles.css:1209-1218），故目标是"消除剩余深色孤岛"而非从零支持浅色 | 见左 |
| 6 | **浅色主题不完整**：`--running`/`--warning`/`--danger` 仅深色定义 | styles.css:36-54 |
| 7 | **重黑投影**（`rgb(0 0 0 / 46%)`、70px 模糊）与彩色发光混用 | :1514, :3559 |
| 8 | **无半透明 chrome**：窗口栏、侧栏均为不透明纯色；`backdrop-filter` 全文仅 2 处 | :4761, :6614 |
| 9 | **动效繁忙**：4 个重复 spinner keyframes、扫描/波浪动画，无 `prefers-reduced-motion` | :2591-2612 |
| 10 | **密度过高**：控件高 25~34px、间距 6~10px，VSCode 式密度 | :61 |
| 11 | **动态类名拼接**：`notice--${notice.type}`（App.tsx:1121）、`is-${state}`（McpPanel.tsx:206）等——迁移到 Tailwind 时必须处理（见 3.5 规则 2） | 见左 |

## 三、Tailwind v4 架构设计

### 3.1 总体结构

```
src/styles.css          ← 唯一样式入口（@import "tailwindcss" + @theme + 定制层）
  ├─ @theme             ← token v2（语义色/字号/圆角/阴影/间距/动效），派生全部工具类
  ├─ 主题变量层          ← :root（深色默认）+ [data-theme="light"] 覆盖
  └─ 定制层（@layer）    ← 工具类表达不了的部分，目标 <1500 行
```

**双主题策略——用 CSS 变量翻转，不用 `dark:` 变体**：现有机制是 `:root` 深色 + `[data-theme="light"]` 浅色覆盖，默认深色。语义 token 定义为主题感知的 CSS 变量，再通过 `@theme inline` 桥接给 Tailwind：

```css
:root {
  --label: #ffffff;
  --label-2: rgb(235 235 245 / 60%);
  --separator: rgb(84 84 88 / 60%);
  --bg: #1c1c1e;
  /* …深色全套 */
}
:root[data-theme="light"] {
  --label: #000000;
  --label-2: rgb(60 60 67 / 72%);
  --separator: rgb(60 60 67 / 12%);
  --bg: #f5f5f7;
  /* …浅色全套 */
}
@theme inline {
  --color-label: var(--label);
  --color-label-2: var(--label-2);
  --color-separator: var(--separator);
  --color-bg: var(--bg);
  /* … */
}
```

组件里写 `text-label-2 border-separator bg-bg-grouped`，主题切换由变量自动完成——组件 className 里**不出现任何 `dark:` 前缀**，这是语义化双主题最干净的形态。

### 3.2 token v2（写进 `@theme` / 主题变量层）

**语义色（取 Apple system 色值的明暗变体）：**

| 语义 | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `accent`（品牌绿，降饱和） | `#30d158` | `#1f7a36` | 仅关键操作、激活态、发送按钮 |
| `accent-ink`（accent 上的文字） | `#06130a` | `#ffffff` | 发送按钮等实心 accent 控件的文字/图标 |
| `blue`（运行中） | `#0a84ff` | `#006ee0` | 运行状态、链接 |
| `orange`（警告） | `#ff9f0a` | `#b25000` | 警告 |
| `red`（危险） | `#ff453a` | `#d70015` | 危险、错误 |
| `green`（成功） | `#30d158` | `#1f7a36` | 成功 |

**对比度约束（实心 accent 控件统一 `bg-accent text-accent-ink`，禁止"accent + 白字"的例外写法）：**
- 深色：`#30d158` 底 + 深色字 `#06130a`，实测对比度 ≈ 9.40:1，超 AAA。
- 浅色：accent 取 `#1f7a36`（比常规 systemGreen 调深一档），配白字实测 ≈ 5.39:1，过 WCAG AA 正文线。
- 品牌绿色保留（产品识别度），但从霓虹薄荷 `#7bf1a8` 降到 Apple systemGreen 饱和度；**取消所有彩色发光投影**；accent 的 alpha 变体用 `bg-accent/8`、`bg-accent/16`、`bg-accent/32` 记法，**统一且仅保留 8/16/32% 三档**（badge 等所有场景同此约束）。
- 浅色 `blue` / `green` / `orange` 较 Apple system 色值调深一档（`#006ee0` / `#1f7a36` / `#b25000`）：浅色底上原值不达 WCAG AA 4.5:1 正文线，调深后实测 4.5~5.4:1（深色主题色值不变）；浅色 `label-2` 相应从 60% 提到 72%（#f5f5f7 上 4.52:1）。
- 语义色 10px 粗体徽章文字按"状态指示"处理：以 8/16/32 档位的语义色底色 + 本色文字呈现，不再另行追求正文级对比度。

**中性色（参考 macOS 动态系统色）：**

| 语义 | 深色 | 浅色 |
|---|---|---|
| `bg`（窗口基底） | `#1c1c1e` | `#f5f5f7` |
| `bg-grouped` / `bg-grouped-2` | `#2c2c2e` / `#3a3a3c` | `#ffffff` / `#f2f2f4` |
| `fill` / `fill-2` / `fill-3`（控件填充） | `rgb(120 120 128 / 16/24/32%)` | `rgb(120 120 128 / 12/16/20%)` |
| `separator` | `rgb(84 84 88 / 60%)` | `rgb(60 60 67 / 12%)` |
| `label` / `label-2` / `label-3` / `label-4` | `#fff` / `60%` / `38%` / `22%` | `#000` / `72%` / `38%` / `22%` |

**交互状态 token（新增）：** 状态不靠各组件即兴发挥，统一定义：
- hover：`bg-fill`（列表项/ghost 按钮）；pressed：`bg-fill-2` + `scale-[0.98]`；selected：`bg-fill-3`
- disabled：`opacity-40` + `pointer-events-none`（唯一允许的透明度档位）
- focus-visible：见下方"焦点环"定义
- 这些语义同样映射为变量（`--state-hover` 等）供定制层使用

**间距 token（新增，解决密度问题）：** 4px 基准网格，写入 `@theme` 的 `--spacing-*` 语义词：`gap-tight: 4px`、`gap: 8px`、`gap-loose: 12px`、`pad-control: 8px 12px`、`pad-card: 16px`、`pad-panel: 20px`、`section: 32px`。控件高度档位：28px（紧凑工具钮）/ 32px（标准按钮输入）/ 36px（主按钮），替代现有 25~34px 散值。

**半透明 chrome（新增语义变量）：** `--material-sidebar`、`--material-chrome`（深色 `rgb(28 28 30 / 82%/72%)`，浅色 `rgb(246 246 248 / 78%/72%)`）。**关于真实模糊的说明见 3.3"材质方案的两级策略"**。

**排版（`@theme` 的 `--font-*` / `--text-*`）：**

- `--font-sans: -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`（不打包 Geist，系统字体即 SF）
- `--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace`
- 字号阶梯：`--text-mini: 10px`（仅 badge/快捷键）、`--text-caption: 11px`、`--text-callout: 12px`、`--text-body: 13px`、`--text-headline: 13px`（600）、`--text-title: 17px`、`--text-large-title: 22px`
- **项目可读性底线（非 HIG 硬性规定）：界面文字最小 11px**（badge/快捷键 10px 例外）；字重只用 400/500/600/700（现有 620/630/650 依赖未打包的变量字体，就近归并）；数字/代码 `tabular-nums` + `--font-mono`

**圆角（`--radius-*`）**：`sm: 6px`（按钮/输入）、`md: 10px`（卡片）、`lg: 14px`（浮层/终端面板）、`full`（头像/badge）。其余 15+ 种散值全部收敛。

**阴影（`--shadow-*`，完整 CSS 值）：**

```css
@theme {
  --shadow-1: 0 1px 2px rgb(0 0 0 / 18%);
  --shadow-2: 0 8px 24px rgb(0 0 0 / 32%);
  --shadow-3: 0 16px 48px rgb(0 0 0 / 40%);
}
/* 浅色主题在变量层覆盖为：/ 6%、10%、14% */
```

柔和环境影，无彩色发光。

**焦点环（修正版，避免全局 box-shadow 覆盖组件投影）：**

```css
/* 全局只保证 outline —— 不碰 box-shadow，避免覆盖按钮/卡片原有阴影 */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

柔光环不作为全局规则，在需要的组件上用 Tailwind 可组合工具类：`focus-visible:ring-2 focus-visible:ring-accent/32`（透明度与 8/16/32 档位保持一致；ring 基于 box-shadow 但与组件阴影共存于组件自身定义处，可组合、可审查）。outline 必须始终保留：box-shadow/ring 会被 `overflow: hidden` 裁剪、在 Windows 强制颜色模式下消失，而 outline 在 forced-colors 下由系统接管仍可见。验收包含 forced-colors 模式检查。

**动效（Tailwind v4 的正确实现方式，已在 tailwindcss@4.3.3 实测）：** v4 中 `duration-*` 是动态数值工具（`duration-150`、`duration-250` 开箱即用，不需要自定义 token）；easing 的 v4 命名空间是 **`--ease-*`**（不是 v3 的 `--transition-timing-function-*`，后者不会生成 `ease-apple`）：

```css
@theme {
  --ease-apple: cubic-bezier(0.25, 0.1, 0.25, 1);
}
```

组件统一写 `transition-colors duration-150 ease-apple` / `duration-250`（仅两档，替代现有 `.14s`/`.18s`/`180ms` 混用）。如确需具名时长，用 `@utility duration-fast { transition-duration: 150ms; }`，不依赖不会自动生成 utility 的 `--transition-*`/`--duration-*` 变量。`prefers-reduced-motion` 规则写在定制层。

### 3.3 材质方案的两级策略（"假 blur"问题的修正）

**事实**：`.desktop-window` 是不透明 `var(--bg)` 铺满窗口（styles.css:112），侧栏/窗口栏背后没有可被模糊的内容——`backdrop-filter` 在这种结构下不会产生真实内容透射，只会得到"半透明灰"。因此：

- **跨平台默认（本方案交付物）**：窗口栏/侧栏/toast 使用半透明 chrome（`--material-*` 变量 + `backdrop-filter` 作为渐进增强写法保留），目标是**"半透明材质感"的视觉分层**，不承诺真实 vibrancy。验收标准按"半透明 + 可读性"判定，不按"模糊内容透射"判定。
- **macOS 增强（独立后续项，不在本方案工作量内）**：Electron `BrowserWindow` 的 `vibrancy: "sidebar"` / `backgroundMaterial` + 透明窗口方案，可产生真实窗口级模糊。需单独验证：性能（backdrop 合成开销）、可读性（桌面壁纸复杂时）、与 CSP/截图脚本的兼容性、非 macOS 平台的降级路径。验证通过前不进入默认交付。

### 3.4 定制层边界（Tailwind 表达不了的部分）

保留在 `styles.css` 定制层（`@layer`）的内容，目标总量 <1500 行：

1. **材质复合类**（`.material-sidebar` 等：半透明背景 + backdrop-filter + 内边框组合）
2. **动画**：合并后的 1 个 spinner keyframes、呼吸脉冲、`prefers-reduced-motion` 全局关闭装饰动画
3. **react-markdown 渲染 DOM 的排版**（`.markdown-body` 类作用域样式）
4. **xterm 终端容器覆盖**（终端配色本体走渲染进程内 TS 主题同步，见改动范围①）、Radix `[data-state]` 的少数复杂选择器
5. **复杂伪元素纹理**（chat-main 网格纹理，降为 2~3% 中性灰）
6. **全局 `:focus-visible` outline**（3.2 定义）
7. **动态语义类**：`notice--success/error`、`is-connected/...` 等运行期拼接的修饰类（见 3.5 规则 2），连同其基础类一起保留在定制层

### 3.5 组件迁移约定（含两条硬性规则）

**规则 1 — 迁移即删除（解决旧 CSS 级联压制）。** 旧 CSS 是未分层的 author CSS，在级联层级（cascade layers）上高于位于 `utilities` 层的 Tailwind 工具类——只要旧规则还在，新写的 `bg-fill`、`rounded-lg` 可能静默不生效。因此：
- 每迁移一个组件，**在同一次改动中删除该组件对应的全部旧 CSS 规则**；
- 被删规则引用的旧类名同步从 tsx 移除，迁移后 grep 该类名应为零引用；
- D5 不再承担"删旧 CSS"的主体工作，只清理迁移完成后剩余的孤儿规则（未被任何 tsx 引用的死代码）。

**规则 2 — Tailwind 类名必须是完整字面量（静态扫描约束）。** Tailwind 按源码文本扫描生成 CSS，`bg-${tone}` 这类拼接不会产生任何样式。因此：
- 条件样式使用**静态映射**：`const toneClass = { success: "border-green/40 bg-green/10", error: "border-red/40 bg-red/10" }[notice.type]`——映射值里的每个类都是完整字面量，可被扫描到；
- `notice--${type}`、`is-${state}` 这类**动态语义类继续保留在定制层**（连同基础类），不强行改造成 utility；
- 禁止以任何形式拼接 Tailwind 类名；不使用 safelist 作为常规手段。

其余约定：
- className 用工具类组合；重复 ≥3 次的组合才提取为定制层组件类（避免 premature abstraction）
- 不再新增任何裸 hex / px 半径 / px 字号到 tsx；视觉值必须命中 `@theme` token（迁移期 grep 检查）
- 每个组件迁移完立即按第六节验收矩阵验收
- tsx 改动仅限 className、条件类的静态映射化、必要的结构微调，外加改动范围声明的 TS/Electron 改动；组件逻辑、事件、i18n key 不动

### 3.6 跨进程主题同步（改动范围②③的完整链路）

主题状态目前只存在于渲染进程（`App.tsx` 写 `documentElement.dataset.theme` + localStorage），主进程无感知，因此浏览器原生视图背景和窗口背景无法只在 `browser-service.ts` 一处改。需要一条完整的 `appearance:set-theme` 链路（遵循 AGENTS.md 的契约三路更新要求）：

1. `src/contracts.ts`：`PiDesktopApi` 增加 `appearance.setTheme(theme: "dark" | "light")`，主题类型入契约
2. `electron/preload.cts`：暴露对应方法
3. `electron/main.ts`：`ipcMain.handle` 校验入参（仅接受 `"dark" | "light"`），调用 `BrowserService.setTheme(theme)` 并对主窗口 `BrowserWindow.setBackgroundColor(...)`
4. `electron/browser-service.ts`：新增 `setTheme`，原生 `WebContentsView` 的 `setBackgroundColor` 随主题切换
5. `src/App.tsx`：主题切换 effect 中调用该 IPC（保留现有 dataset.theme + localStorage 逻辑）
6. **测试**：`browser-service.test.ts` 或新增测试覆盖 `setTheme` 的颜色映射；IPC 校验逻辑按 main.ts 现有模式保持薄层

xterm 终端在渲染进程内（改动①），主题切换时直接更新 `Terminal.options.theme`，**不需要 IPC**。终端配色从 `--terminal-*` CSS 变量读取（在主题变量层随亮暗定义两套，TSX 中通过 `getComputedStyle` 取值），避免在 TSX 里重新维护两套硬编码色值。

## 四、分组件迁移清单（D2~D4 的执行单元）

| 顺序 | 区域 | 关键改动 | 预估 |
|---|---|---|---|
| 1 | App shell + 窗口栏 | 半透明 chrome 窗口栏；网格布局工具类化；`notice--${type}` 静态映射化 | 0.5d |
| 2 | 会话侧栏 | 半透明 chrome；hover `bg-fill`、selected `bg-fill-3`（替代绿底）；section 标题 11px/600 句首大写 | 0.5~1d |
| 3 | Composer + 新对话视图 | 卡片 `rounded-lg` + `bg-bg-grouped` + `shadow-2`；发送按钮 `bg-accent text-accent-ink`（非白字）去发光；正文 13/14px | 1d |
| 4 | 消息流/工具卡片/inspector | 边框降 `border-separator`；meta 文字 9.5→11px；4 个 spinner 合并 | 1.5d |
| 5 | 设置视图 | iOS 式分组列表（`bg-bg-grouped` 卡片 + `border-separator` 行间线）；按钮 13px/600 | 1d |
| 6 | 插件中心（32 个 class 前缀，最大） | badge 语义色 16% 底 + 本色文字（遵守 8/16/32 档位）；卡片去边框改填充分层 | 1.5d |
| 7 | 终端 + 浏览器工作台 | 终端主题渲染进程内同步（改动①）+ `appearance:set-theme` 链路（3.6）+ 消除剩余深色孤岛；`shadow-3` | 1.5d |
| 8 | MCP/Skills/可观测性/横幅/toast | `is-${state}` 类保留定制层 + 静态映射其余条件类；toast 半透明 chrome | 1d |
| — | 图标 | 维持 lucide，统一 strokeWidth 1.5、尺寸 14/16/18 三档（向 SF Symbols 细权重靠拢）；空状态/展示性装饰图标允许 24~30px 的例外尺寸 | 随各组件 |

## 五、实施阶段与验收

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| D0 | `@theme` token v2（含间距/状态 token）+ 主题变量层 + 定制层骨架 + **`--panel`/`--muted-strong` 直接替换为 token v2 语义（grep 确认零引用，不留兼容别名）** + 补齐浅色语义色 + **验收车道建设**（见下） | 2.5d | build 绿；工具类可用；双主题切换正常；两条验收车道跑通并产出基线 |
| D1 | 排版阶梯 + base 样式（字号/字重/行高） | 1d | 全文搜不到 <11px 正文（badge 除外）；双主题目检 |
| D2 | 迁移 shell/侧栏/composer/消息流（清单 1-4） | 3.5d | 每组件过验收矩阵；旧 CSS 同步删除 |
| D3 | 迁移设置/插件中心（清单 5-6） | 2.5d | 同上 |
| D4 | 迁移终端/浏览器/其余面板（清单 7-8，含 3.6 跨进程主题链路 + 其测试） | 3d | 终端/浏览器在浅色主题下无深色孤岛；`appearance:set-theme` 测试通过 |
| D5 | 动效收敛 + reduced-motion + 焦点环 + 清理孤儿旧规则 + 全量黄金图回归 | 1d | styles.css < 1500 行；grep 无旧类名引用；forced-colors 检查通过 |
| 合计 | | **~13.5d** | |

**D0 验收车道建设（前置条件）**：现有 `docs/design/verify-frontend.mjs` 是普通 Chromium 访问 Vite 页面，**无法验证 Electron 窗口背景、原生 WebContentsView、preload/IPC 驱动的终端与浏览器状态**。因此 D0 建设两条车道：
- **渲染层车道（Chromium + mock bridge）**：为截图脚本提供可控的 `window.piDesktop` mock，覆盖纯渲染层场景（新对话/活跃对话/设置/插件等）的双主题截图与交互状态。该车道**不得宣称覆盖终端、原生浏览器视图**。
- **Electron 车道（Playwright `_electron.launch`）**：覆盖窗口背景、原生 WebContentsView 主题、终端真实状态、`appearance:set-theme` 链路。**注意：Playwright 的 `firstWindow().screenshot()` 不一定包含独立合成的 WebContentsView**——原生浏览器视图的验收应通过对该视图 `webContents.capturePage()` 截图、可观察状态断言（背景色值、主题字段）或 `BrowserService` 的单元测试补证，不能只看整窗截图。

**基线与黄金图策略（按阶段演进，本次是主动 redesign）：**
- **D0**：截取**旧版结构回归基线**，仅用于发现意外破坏（布局错位、元素丢失），**不以"与旧图一致"为通过条件**；
- **D1**：排版/base 样式完成后，为全局排版建立**阶段基线**（只用于 D1 自身范围）；
- **D2–D4**：每个组件迁移完成并人工确认后，将该组件的新截图**提升为黄金图**——组件 redesign 发生在此期间，不允许拿 D1 的图约束 D2–D4 的预期变化；
- **D5**：用最终**全量黄金图**做整体回归。

全程门禁：`pnpm lint`、`pnpm typecheck`、`pnpm test` 保持绿（`NewChatView.test.tsx` 的 server-render 断言涉及 className，迁移时同步更新）。

## 六、验收矩阵（每个组件迁移完成后逐项过）

1. **场景 × 主题**：深色/浅色 × 新对话 / 活跃对话 / 设置 / 插件中心 / 浏览器工作台 / 终端，共 12 张基线截图（渲染层场景走 Chromium 车道；浏览器原生视图、终端真实状态、窗口背景走 Electron 车道，原生视图按 3.6/五节的方式补证）
2. **交互状态**：hover、selected、pressed、disabled、focus-visible、error、warning 关键控件各至少 1 处
3. **reducedMotion**：Playwright `reducedMotion: "reduce"` 上下文下无装饰动画
4. **对比度抽查**：正文/次要文字/实心按钮文字达 WCAG AA（4.5:1），重点验证 `bg-accent text-accent-ink` 两种主题
5. **缩放**：100% / 125% / 150% 缩放下无溢出、无截断
6. **forced-colors**：Windows 高对比模式下焦点与关键控件仍可见（Chromium `forcedColors: "active"` 模拟）
7. **旧 CSS 清除**：被迁移组件的旧类名 grep 零引用，styles.css 中对应规则已删除

## 七、不做的事

- 不改组件结构/交互逻辑（除开头声明的 TS/Electron 改动与 3.6 链路）、不引入 UI 库或字体包。
- 不做 Liquid Glass 的激进拟物（彩色玻璃、镜面高光）——HIG 自己也要求"克制使用"。
- **不在本阶段做 macOS 原生 vibrancy**——它是独立验证的增强项（见 3.3），本方案只交付"半透明材质感"。
- **不做"跟随系统"主题选项**——现状为首次启动读取系统偏好、之后手动切换，本次保持；如需"跟随系统"第三选项，作为独立增强单独评估（涉及主题状态模型变更，不属于样式重构）。

# Pi Forge workspace guide

## Scope and architecture
- This is a pnpm workspace; the only shipped package today is `apps/desktop` (`@pi-desktop/renderer`), an Electron/React reference implementation of Pi Forge. The `packages/*` layout in the README is roadmap, not implemented architecture.
- Keep process boundaries intact: `apps/desktop/src` is the isolated renderer; `electron/main.ts` owns privileged IPC/services; `electron/preload.cts` exposes the allowlisted `window.piDesktop` API; `agent-runtime-client.ts` → `agent-runtime-protocol.ts` → `agent-runtime-worker.ts` → `agent-service.ts` is the child-process RPC path for agent execution.
- `apps/desktop/src/contracts.ts` is shared across renderer and Electron builds. When changing a cross-boundary feature, update the contract, preload exposure, main-process validation/handler, runtime protocol/client/worker, service, and callers together. Never expose plaintext credentials or direct Node/filesystem access to the renderer.
- Main-process-only capabilities such as credentials, MCP, and browser access reach the runtime through host RPC. Security behavior is structural: workspace guards, approval policy, sandbox fallback, project trust, credential redaction, and safe-storage handling must not be bypassed for convenience.

## Commands
- Requirements match CI: Node `24.10.0`, pnpm `10.17.0`; install with `pnpm install --frozen-lockfile` when reproducing CI (`pnpm install` is fine while intentionally updating the lockfile).
- Development: `pnpm dev` (first compiles Electron, then starts Vite on strict `127.0.0.1:4173` and Electron).
- Required verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Coverage/CI test lane: `pnpm test:coverage` (80% statement/branch/function/line thresholds in `apps/desktop/vitest.config.ts`).
- Focused test: `pnpm --dir apps/desktop exec vitest run src/path/to/file.test.ts`; passing a path through the root `pnpm test` script does not reliably limit Vitest to that file.
- Build/package: `pnpm build`; `pnpm package:dir` creates an unpacked app, while `pnpm package` creates current-platform artifacts under `apps/desktop/release` and is substantially heavier.
- There is no format script. Lint is Oxlint with warnings denied; do not invent a formatter command.
- Design-specific checks are separate from CI: `pnpm verify:tokens`, `verify:renderer`, `verify:electron`, `verify:a11y`, and `verify:golden`. Run the relevant lane for broad UI/token changes; `pnpm verify:setup` installs workspace-local Chromium. Screenshots go to ignored `docs/design/shots`; `verify:golden` only compares, so update tracked baselines manually after review.

## Implementation and test conventions
- TypeScript is strict and ESM/NodeNext Electron imports use emitted `.js` suffixes. Renderer imports follow the existing extensionless Vite convention.
- Keep runtime RPC changes exhaustive: update `AgentRuntimeMethod` and the worker switch together. `agent-event-adapter.ts` intentionally uses compile-time exhaustiveness so Pi SDK event-union changes fail typecheck.
- UI source strings are Simplified Chinese. Wrap direct TSX text with `t(...)` and add its English value to `enUS` in `src/i18n.tsx`; `zhCN` is generated from those keys, and `src/i18n.test.ts` scans direct translation calls for missing English entries.
- Unit tests are colocated (`*.test.ts`/`*.test.tsx`). Electron service tests generally exercise deterministic services directly; the suite uses a local OpenAI-compatible fake model and should not require a real API key.
- Renderer component files are excluded from coverage because tests run in Node rather than a browser DOM. Keep deterministic UI logic in testable helpers when practical; use the design verification lanes for real preload/IPC, browser, accessibility, PTY, and golden behavior.
- Generated outputs (`apps/desktop/dist`, `dist-electron`, `coverage`, and `release`) are build artifacts; change sources/configuration rather than editing them.
- The complete command sandbox is macOS/Linux-only. Other platforms must retain the pre-execution approval fallback rather than silently relaxing permissions. Under an already-sandboxed agent harness, the real nested-sandbox write test may fail with exit code 71; verify it on an unsandboxed supported host rather than weakening the assertion.

## CI and release
- CI uses frozen install and runs lint/typecheck, coverage, and build on Node 24.10.0/pnpm 10.17.0.
- Release tags must be SemVer prefixed with `v`; native Linux, Windows, Intel macOS, and Apple Silicon macOS runners build unsigned installers.

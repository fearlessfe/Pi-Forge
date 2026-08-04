# Pi Forge workspace guide

## Scope and architecture
- This is a pnpm workspace; the only shipped package today is `apps/desktop` (`@pi-desktop/renderer`), an Electron/React reference implementation of Pi Forge.
- Keep process boundaries intact: `apps/desktop/src` is the isolated renderer; `electron/main.ts` owns privileged IPC/services; `electron/preload.cts` exposes the allowlisted `window.piDesktop` API; `electron/agent-runtime-worker.ts` runs the agent harness in a separate child process.
- `apps/desktop/src/contracts.ts` is shared across renderer and Electron builds. When changing an IPC contract, update the contract, preload exposure, main-process validation/handler, and callers together. Never expose plaintext credentials or direct Node/filesystem access to the renderer.
- Security behavior is structural: workspace guards, approval policy, sandbox fallback, project trust, and safe-storage credential handling must not be bypassed for convenience.

## Commands
- Requirements match CI: Node `24.10.0`, pnpm `10.17.0`; install with `pnpm install --frozen-lockfile` when reproducing CI (`pnpm install` is fine while intentionally updating the lockfile).
- Development: `pnpm dev` (first compiles Electron, then starts Vite on strict `127.0.0.1:4173` and Electron).
- Required verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Coverage/CI test lane: `pnpm test:coverage` (80% statement/branch/function/line thresholds in `apps/desktop/vitest.config.ts`).
- Focused test: `pnpm --dir apps/desktop exec vitest run src/path/to/file.test.ts`; passing a path through the root `pnpm test` script does not reliably limit Vitest to that file.
- Build/package: `pnpm build`; `pnpm package:dir` creates an unpacked app, while `pnpm package` creates current-platform artifacts under `apps/desktop/release` and is substantially heavier.
- There is no format script. Lint is Oxlint with warnings denied; do not invent a formatter command.
- Design-specific checks are separate from CI: `pnpm verify:tokens`, `verify:renderer`, `verify:electron`, `verify:a11y`, and `verify:golden`. Run the relevant lane for changes under `docs/design` or broad UI/token changes; `pnpm verify:setup` installs its Chromium dependency.

## Implementation and test conventions
- TypeScript is strict and ESM/NodeNext Electron imports use emitted `.js` suffixes. Renderer imports follow the existing extensionless Vite convention.
- Unit tests are colocated (`*.test.ts`/`*.test.tsx`). Electron service tests generally exercise deterministic services directly; the suite uses a local OpenAI-compatible fake model and should not require a real API key.
- Renderer component files are excluded from coverage because tests run in Node rather than a browser DOM. Keep deterministic UI logic in testable helpers when practical; use the design verification lanes for browser/accessibility/golden behavior.
- Generated outputs (`apps/desktop/dist`, `dist-electron`, `coverage`, and `release`) are build artifacts; change sources/configuration rather than editing them.
- The complete command sandbox is macOS/Linux-only. Other platforms must retain the pre-execution approval fallback rather than silently relaxing permissions.

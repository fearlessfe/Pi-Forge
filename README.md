# Pi Forge

<p align="center">
  <img src="./apps/desktop/build/icon.svg" width="112" alt="Pi Forge icon">
</p>

<p align="center">
  <a href="https://github.com/fearlessfe/Pi-Forge/actions/workflows/ci.yml"><img src="https://github.com/fearlessfe/Pi-Forge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://codecov.io/gh/fearlessfe/Pi-Forge"><img src="https://codecov.io/gh/fearlessfe/Pi-Forge/graph/badge.svg" alt="Coverage"></a>
  <a href="https://github.com/fearlessfe/Pi-Forge/releases"><img src="https://img.shields.io/github/v/release/fearlessfe/Pi-Forge?display_name=tag&sort=semver" alt="Latest release"></a>
</p>

**English** | [简体中文](./README.zh-CN.md)

> Build agents like software.

Pi Forge is an open-source agent foundation built on [Pi Coding Agent](https://github.com/badlogic/pi-mono). It provides the essential building blocks for model access, sessions, context, tools, permissions, sandboxes, MCP, and observable events, so developers can compose, debug, and deliver custom agents for different teams and workflows just like conventional software.

`apps/desktop` is the first Pi Forge reference implementation: an Electron desktop application for local development workflows. It is both a usable coding agent and a proving ground for the runtime boundaries and developer experience that Pi Forge aims to establish.

> Pi Forge is evolving quickly. The current release provides a usable local, single-agent loop. A standalone runtime, multi-agent scheduling, remote execution environments, and an enterprise control plane remain on the roadmap. This README distinguishes shipped capabilities from design direction.

## Why Pi Forge

A forge produces many different tools; it does not prescribe a single final shape.

Pi Forge is not trying to build one universal agent. It provides stable, composable primitives that developers can combine with their own models, data, tools, security policies, and deployment environments to forge agents that fit real work.

## Philosophy

### 1. An agent is software, not a chat window

A production agent needs more than a model and a prompt. It needs explicit state, tool contracts, permission boundaries, error handling, observable events, tests, and versioning.

Pi Forge focuses on the full agent lifecycle, not just producing one response.

### 2. A session is not a model context

A session is a recoverable record of work. Context is the information selected for one model call.

History should not become unrecoverable because of compaction or context trimming. Our long-term direction is for the session to preserve durable facts while the harness independently decides how to query, compress, and organize context for each turn.

### 3. Brains and hands should be decoupled

- **Brain**: the model, harness, context strategy, and tool selection.
- **Hands**: local sandboxes, MCP servers, browsers, remote hosts, and internal enterprise systems.

A brain should not depend on one execution environment, and a hand should not be permanently bound to one agent. Stable tool and execution interfaces should allow both sides to evolve and be replaced independently.

### 4. Stabilize interfaces, not harnesses

Model capabilities change. Context techniques and agent loops that are necessary today may become obsolete quickly. Pi Forge should define clear contracts around sessions, events, tools, permissions, and execution environments while allowing harnesses to evolve continuously.

### 5. Security comes from structure, not prompts

Prompts are not security boundaries. Sensitive credentials, user data, and untrusted code must be separated through process isolation, system sandboxes, least privilege, approval policies, and credential proxies.

Default behavior should be explainable, rejectable, and reversible. Dangerous capabilities require explicit authorization.

### 6. Every step should be observable and controllable

Users and developers need to know:

- why an agent started or stopped;
- which tools it called;
- which resources it read or changed;
- how many tokens and how much money it consumed;
- where it failed and whether it can recover.

Pi Forge treats event protocols and execution traces as runtime capabilities, not UI decoration.

### 7. Local first, openly extensible

Project files, sessions, and tool execution remain in environments controlled by the user by default. Models, MCP servers, skills, extensions, and future execution backends should connect through open interfaces that avoid locking developers into a single provider or cloud.

## Current capabilities

| Area | Current status |
| --- | --- |
| Models | Reads the Pi SDK provider catalog and supports built-in providers plus OpenAI-, Anthropic-, and Google-compatible endpoints |
| Credentials | Supports API keys, OAuth, and provider credential chains; persisted credentials are encrypted with Electron `safeStorage` |
| Sessions | Persists local multi-turn sessions with resume, fork, rename, tag, archive, and export support |
| Context | Supports Pi session context construction, compaction, context usage display, and model usage records |
| Agent events | Captures the Pi `AgentSessionEvent` union, durably journals complete desktop events, and supports scoped offset queries, checkpoints, migration, and state replay |
| Tools | Supports reading, searching, shell commands, editing, writing, user questions, and read-only subagents |
| Task control | Supports aborting, steering, follow-up queues, and waiting for user answers |
| Runtime | Runs the agent harness in an independent child process with protocol RPC, automatic restart, and safe continuation of interrupted tasks |
| Change review | Captures file mutations, generates diffs, and safely reverts files that have not changed again |
| Permissions | Provides permission modes, workspace boundaries, sensitive-operation approval, and project-resource trust |
| Sandbox | Uses Anthropic Sandbox Runtime on macOS/Linux to restrict command filesystem and network access |
| MCP | Supports user-scoped and trusted project-scoped stdio and Streamable HTTP MCP servers |
| Extensions | Loads Pi extensions, skills, prompts, themes, and packages with source and enablement management |
| Desktop experience | Provides conversations, tool traces, diffs, history, settings, and an integrated terminal |

The test suite drives real Pi sessions with a local OpenAI-compatible fake model, so it does not require a real API key. It covers model connectivity, streaming, thinking, tool calls, user questions, subagents, multi-turn context, abort behavior, credential isolation, and event sequences.

## Current boundaries

To avoid presenting the roadmap as shipped functionality, the current release has these explicit limitations:

- the agent harness runs in an independent local Runtime child process, but is not yet an independently deployable service;
- one application instance currently runs up to three isolated primary conversation tasks at a time;
- the built-in subagent is read-only and in-process; each run has a persistent child session plus an independent token, request, and estimated-cost ledger, but cannot yet resume as a background task;
- Runtime crashes preserve a recovery record and offer safe continuation; in-flight tool calls are not replayed automatically, avoiding duplicate side effects;
- the sandbox is a local command boundary and cannot yet provision remote execution environments;
- there is no cloud sync, team control plane, organization policy, or distributed scheduler yet;
- the current reference application targets desktop development workflows and is not a full IDE.

## Architecture

Current reference implementation:

```text
┌─────────────────────────────────────────────────────────┐
│ Pi Forge Desktop · React                               │
│ Conversation · Trace · Diff · Settings · Terminal      │
└──────────────────────────┬──────────────────────────────┘
                           │ Typed IPC
┌──────────────────────────▼──────────────────────────────┐
│ Electron Main                                           │
│ Window · Credentials · Browser · MCP Host               │
├─────────────────────────────────────────────────────────┤
│ Independent Agent Runtime                               │
│ Pi Session · Policy · Context · Tools · Recovery Journal │
├────────────────┬────────────────┬───────────────────────┤
│ Local Sandbox  │ MCP Servers    │ OS Keychain / PTY     │
└────────────────┴────────────────┴───────────────────────┘
```

Target boundaries:

```text
                       ┌──────────────────────┐
                       │  Studio / API / SDK  │
                       └──────────┬───────────┘
                                  │
┌──────────────────┐    ┌─────────▼─────────┐    ┌──────────────────┐
│ Durable Session  │◀──▶│ Agent Runtime     │───▶│ Hand Adapters    │
│ Events · Context │    │ Brain · Harness   │    │ Sandbox · MCP    │
└──────────────────┘    └─────────┬─────────┘    │ Browser · VPC    │
                                  │              └──────────────────┘
                       ┌──────────▼───────────┐
                       │ Policy · Secrets    │
                       │ Audit · Observability│
                       └──────────────────────┘
```

This direction does not require rewriting the desktop application all at once. Pi Forge will first extract stable interfaces from a working local loop, then progressively separate the runtime, sessions, and hands into independently deployable and replaceable components.

## Quick start

### Requirements

- Node.js 24.10+
- pnpm 10+
- macOS or Linux for the complete command-sandbox experience; other platforms safely fall back to pre-execution approval

### Start the development environment

```bash
pnpm install
pnpm dev
```

The development command first compiles the Electron main process, then starts the Vite renderer and Pi Forge Desktop. The renderer binds to `http://127.0.0.1:4173`; startup exits safely when the port is occupied so Electron cannot connect to an unrelated local service.

### Configure a model

1. Open the account menu in the lower-left corner and navigate to **Settings → Models**.
2. Select a provider and model, or configure a compatible endpoint.
3. Enter an API key or use OAuth/system credentials supported by the provider.
4. Select **Verify connection**.
5. Return to the conversation, authorize a workspace through the directory menu, and start a task.

The renderer can read only whether credentials are configured and their type. It cannot read plaintext API keys, access tokens, or refresh tokens.

### Configure agent tracing

Open **Settings → Trace** to inspect and export agent traces. Pi Forge records metadata-only traces to a protected, date-partitioned local JSONL file by default. Each trace correlates the agent run, turns, model generations, tool calls, compaction, retries, token usage, cost, errors, and delegated subagent metadata.

Add one or more OTLP HTTP exporter endpoints to send the same spans to Langfuse, Tempo, Jaeger, Datadog, or another OTLP-compatible backend. Enter the provider's OTLP base endpoint; Pi Forge appends `/v1/traces` when needed. Optional request headers are encrypted with the operating system secure storage and are never exposed back to the renderer.

Content capture has three modes: no content, lengths and hashes only (the default), or full prompt/output/tool content. Known credential fields and inline tokens are redacted in every mode. Export failures are queued independently and never interrupt an agent run.

## Development and verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm package
pnpm verify:setup
pnpm verify:tokens
pnpm verify:renderer
pnpm verify:electron
pnpm verify:a11y
pnpm verify:golden
```

`pnpm build` compiles the application, while `pnpm package` creates an installer for the current operating system in `apps/desktop/release`. Use `pnpm package:dir` when you only need an unpacked application for a quick local check.

`pnpm verify:setup` installs the workspace-local Playwright Chromium used by the renderer and accessibility lanes. The golden command only compares screenshots produced by the renderer, accessibility, and Electron lanes with the tracked baselines; it never updates those baselines automatically. Pushes and pull requests run token checks plus renderer and critical preload/IPC smoke coverage on Ubuntu. The complete renderer, accessibility, Electron, and golden suite runs nightly and on demand on macOS, with screenshots and logs uploaded when it fails.

### Releases

Pushing a SemVer tag runs the release workflow. It verifies lint, types, and unit tests, builds the application on native Windows, macOS, and Linux runners, creates a GitHub Release, and uploads the installers:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow produces a Windows x64 NSIS installer, separate macOS DMG and ZIP packages for Intel (x64) and Apple Silicon (arm64), and Ubuntu x64 AppImage and Debian packages. Before upload, each native runner launches the unpacked packaged application and verifies preload, IPC, the Agent Runtime handshake, and node-pty. The publish job rejects unexpected update metadata, verifies the exact cross-platform artifact set, and includes a `SHA256SUMS` file. Tags such as `v0.2.0-beta.1` create a prerelease. The workflow can also be run manually for an existing tag from **Actions → Release → Run workflow**.

Release packages are unsigned by default. Before distributing them broadly, configure platform signing and macOS notarization credentials as GitHub Actions secrets; otherwise Windows SmartScreen and macOS Gatekeeper may warn users.

The desktop application lives in `apps/desktop`:

```text
pi-forge/
├── apps/
│   └── desktop/
│       ├── electron/       # Electron main process and application services
│       ├── src/            # React renderer, components, and shared contracts
│       └── scripts/        # Development and runtime support scripts
├── packages/
│   ├── runtime-contracts/  # Public stable-v1 Runtime/Session/Event/Hand contract
│   └── runtime-sdk/        # Public transport-neutral Runtime client/host SDK
├── templates/
│   └── basic-agent/        # Compilable custom Agent starter
├── docs/                   # Design assets and verification scripts
├── package.json
└── pnpm-workspace.yaml
```

`@pi-forge/runtime-contracts` and `@pi-forge/runtime-sdk` are public stable-v1 platform packages. Contracts provides versioned envelopes, capability negotiation, fail-closed validators, and shared Runtime/Session/Event/Hand types; the SDK provides a transport-neutral validating client, Agent host, manifest factory, structured errors, heartbeat, timeouts, and event subscriptions. `templates/basic-agent` is compiled and tested in the workspace. Electron host RPC for credentials, MCP, browser access, and desktop services is deliberately excluded.

The remaining platform packages are still planned:

```text
packages/
├── runtime-contracts/      # Implemented public stable-v1 contracts
├── runtime-sdk/            # Implemented public Agent SDK
├── runtime/                # Agent lifecycle and harness
├── session/                # Durable events and context queries
├── hands/                  # Sandbox, MCP, and remote execution adapters
└── policy/                 # Permissions, approvals, and organization policy
```

## Security model

- the Electron renderer is isolated and cannot directly access Node.js, the filesystem, shell, or credentials;
- preload exposes only allowlisted, validated, typed IPC methods;
- API keys and OAuth tokens are encrypted with operating-system secure storage;
- out-of-workspace access, dangerous commands, privilege escalation, and destructive Git operations require explicit approval;
- balanced-mode shell commands use an OS-level sandbox on supported platforms to restrict filesystem and network access;
- if the sandbox is unavailable, Pi Forge falls back to pre-execution approval instead of silently relaxing permissions;
- project-level extensions, skills, and MCP configuration load only after the project is trusted;
- logs and MCP errors redact known credential values;
- file reverts verify the post-agent content hash to avoid overwriting later user edits.

The long-term goal is to separate the agent runtime, execution environments, and credential broker so untrusted code is structurally unable to access raw credentials.

## Roadmap

### Phase 1: Reliable local agent loop

- [x] Real models and streaming Pi sessions
- [x] Local session persistence and history management
- [x] Tool traces, permission approval, and task abort
- [x] Command sandboxing, file diffs, and safe reverts
- [x] MCP, skills, extensions, and read-only subagents
- [x] Model usage, cost estimation, and context usage

### Phase 2: Extract the Pi Forge Runtime

- [x] Move agent execution out of Electron into an independent worker
- [x] Define stable runtime, session, event, and hand contracts
- [x] Persist complete runtime events as a queryable, replayable event stream
- [x] Detect Runtime crashes, restart automatically, and safely continue interrupted tasks
- [ ] Add idempotent replay of unfinished tool calls and fully transparent recovery
- [x] Provide an SDK and example templates for custom agents

### Phase 3: Multi-agent and remote execution

- [ ] Concurrent task scheduling and resumable background subagents
- [ ] Provisionable, replaceable local and remote sandboxes
- [ ] Safe hand sharing and handoff between agents
- [ ] Credential brokering, fine-grained authorization, and complete audit trails
- [ ] Runtime evaluation, tracing, cost, and reliability metrics

### Phase 4: Enterprise extensions

- [ ] Organization-, project-, and environment-level policies
- [ ] Private deployment and enterprise identity integration
- [ ] Team collaboration and an optional cloud control plane
- [ ] Internal catalogs for agents, tools, and templates

Enterprise capabilities will build on the same open runtime and protocols without intentionally weakening the usefulness of the open-source edition.

## Contributing

Pi Forge welcomes contributions around:

- agent runtime and session architecture;
- model provider and MCP compatibility;
- sandboxing, security policy, and credential isolation;
- context engineering, memory, and compaction;
- desktop UX, accessibility, and cross-platform support;
- tests, documentation, example agents, and reproducible bug reports.

Before submitting a change, run at least:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

For significant architectural changes, please first describe the problem, boundaries, and compatibility strategy in an issue or design document.

## Open-source license

Pi Forge is open source under the [MIT License](LICENSE).

## Acknowledgements

Pi Forge is built on Pi Coding Agent and its open ecosystem, together with open-source projects including Electron, React, the MCP SDK, and Anthropic Sandbox Runtime.

Pi Forge is an independent community project. Unless explicitly stated otherwise, it is not an official product of, or endorsed by, the projects and companies mentioned above.

# Pi Forge basic Agent template

This directory is a minimal, compilable Runtime protocol v1 Agent. Copy it into a new repository, replace the package name and manifest, then implement Runtime handlers in `src/agent.ts`.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The template deliberately implements only `updateConfiguration` and `send`. Add handlers as your host application needs them. Privileged capabilities such as credentials, MCP, browser automation, and filesystem access must be injected by a trusted host; they are not exposed by the public SDK.

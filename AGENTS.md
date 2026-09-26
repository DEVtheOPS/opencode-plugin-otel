# AGENTS.md

Instructions for AI agents working in this repository.

## Build & typecheck

Always run after making changes:

```bash
bun run typecheck
```

There is no build step during local development. TypeScript source files are loaded natively by Bun; the published package is bundled by `prepack`.

## Testing

```bash
bun test
```

## Target runtime

`main` targets **OpenCode V2** (`>=2`) and exports a `Plugin.define`-style default export
(`id: "devtheops.otel"`, `setup`). The OpenCode V1 plugin lives on the `v1` branch and is
released from the `1.x` line; do not add V1 compatibility shims to `main`.

## Project layout

```text
src/
├── index.ts              — V2 plugin default export (id + setup)
├── plugin.ts             — setup(): config, model.request hook, event subscription, dispatch
├── state.ts              — per-process shared OTel SDK + tracing state (globalThis)
├── types.ts              — Shared types (OpenCodeEvent, HandlerContext, TracingState, etc.)
├── config.ts             — Env/option config loading and log level resolution
├── otel.ts               — OTel SDK setup and instruments
├── probe.ts              — OTLP endpoint TCP probe
├── headers.ts            — Dynamic OTLP headers / refreshing exporters
├── trace-context.ts      — W3C trace-context inject/extract
├── util.ts               — errorSummary, setBoundedMap, context resolution, attrs
└── handlers/
    ├── session.ts        — session.created, session.inbox.enqueued, session.execution.*, retry/idle/usage
    ├── step.ts           — session.step.*, session.text.ended (LLM spans + token/cost/cache metrics)
    ├── tool.ts           — session.tool.* (tool spans, subagent correlation, duration, commit detection)
    ├── permission.ts     — permission.asked/replied
    └── chat-headers.ts   — context preview and model.request / WebSocket trace propagation
```

## Key conventions

- **Bun over Node** — use `bun`, `bun test`, `bun run`. Never use `node`, `npx`, `jest`, or `vitest`.
- **No comments** unless explicitly requested.
- **No `sdk-node`** — the OTel Node SDK meta-package is intentionally excluded; use individual packages.
- **`@opencode/plugin` is type-only** — import types from it (`import type { Plugin } from "@opencode/plugin"`); the plugin never imports it at runtime, so it stays a dev/optional peer dependency.
- **`HandlerContext`** — all event handlers receive a `HandlerContext` (defined in `src/types.ts`). Do not import OTel globals directly inside handlers; thread them through the context.
- **`setBoundedMap` / `markSeen`** — always use these for correlation maps (`toolMeta`, `stepMeta`, `pendingPrompts`, `pendingPermissions`, `seenEvents`) to prevent unbounded growth.
- **Single source of truth for tokens/cost** — token and cost counters are incremented once per `session.step.ended`/`failed`; session totals come from `session.usage.updated` (cumulative) with a per-step fallback.
- **Event de-duplication** — V2 may deliver the same event to multiple plugin instances; serialize shared dispatch before deduping by `event.id` via `markSeen` so later events cannot overtake an asynchronous session lookup.
- **Session identity** — retain the agent, subagent parent, and creation time across executions, and hydrate missed `session.created` events with `ctx.session.get`.
- **Subagent correlation** — only parent a child run under a dispatch tool span when a child session ID in tool progress/result metadata or one unambiguous live candidate identifies it; otherwise use the parent run.
- **Model context capture** — opt-in only, text parts only, bounded; never serialize full media or structured tool payloads into span attributes.
- **Multi-location configuration** — process-wide exporters require identical telemetry configuration; reject a conflicting setup and derive project attributes from the observed session, not the loading location.
- **Shutdown** — providers are flushed (never shut down) on plugin cleanup and once per process on `beforeExit`. Shutting down the global OTel providers poisons them for the rest of the process.
- **All env vars are `OPENCODE_` prefixed** — `OPENCODE_ENABLE_TELEMETRY`, `OPENCODE_OTLP_ENDPOINT`, `OPENCODE_OTLP_METRICS_INTERVAL`, `OPENCODE_OTLP_LOGS_INTERVAL`, `OPENCODE_METRIC_PREFIX`, `OPENCODE_CAPTURE_PROMPT_IN_LOGS`, `OPENCODE_OTLP_HEADERS`, `OPENCODE_RESOURCE_ATTRIBUTES`, `OPENCODE_SPAN_ATTRIBUTES`. Never use bare `OTEL_*` names for plugin config. Headers are passed directly to exporters; `loadConfig` copies `OPENCODE_RESOURCE_ATTRIBUTES` → `OTEL_RESOURCE_ATTRIBUTES` before the SDK initializes.
- **`OPENCODE_ENABLE_TELEMETRY`** — all OTel instrumentation is gated on this env var (or the `enabled` plugin option). The plugin always loads regardless.
- **`OPENCODE_METRIC_PREFIX`** — defaults to `opencode.`; set to `claude_code.` for Claude Code dashboard compatibility.
- **Plugin options** — read from `ctx.options` during `setup`. Precedence is option → `OPENCODE_*` env → default. Keep option keys 1:1 with `PluginConfig` field names.

## Commit message format

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`, `build`.

Use `!` or a `BREAKING CHANGE:` footer for breaking changes (this repo uses `release-please`, so a
breaking commit bumps the major version automatically).

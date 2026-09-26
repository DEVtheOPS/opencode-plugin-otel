# opencode-plugin-otel

[![npm version](https://img.shields.io/npm/v/@devtheops/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@devtheops/opencode-plugin-otel)
[![npm downloads](https://img.shields.io/npm/dm/@devtheops/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@devtheops/opencode-plugin-otel)
[![GitHub stars](https://img.shields.io/github/stars/DEVtheOPS/opencode-plugin-otel.svg)](https://github.com/DEVtheOPS/opencode-plugin-otel/stargazers)
[![Build status](https://img.shields.io/github/actions/workflow/status/DEVtheOPS/opencode-plugin-otel/release-please.yml?branch=main)](https://github.com/DEVtheOPS/opencode-plugin-otel/actions/workflows/release-please.yml)
[![Discord notifications](https://img.shields.io/badge/discord-notifications-5865F2?logo=discord&logoColor=white)](https://discord.gg/zavuskz8xB)
[![License](https://img.shields.io/npm/l/@devtheops/opencode-plugin-otel.svg)](https://github.com/DEVtheOPS/opencode-plugin-otel/blob/main/LICENSE)

An [opencode](https://opencode.ai) plugin that exports telemetry via OpenTelemetry (OTLP over gRPC or HTTP/protobuf), mirroring the same signals as [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage).

> **OpenCode V2 only.** Version `2.x` of this plugin targets **OpenCode `>=2`** and exports the V2
> `Plugin.define`-style default export (`id: "devtheops.otel"`). The OpenCode V1 plugin is maintained
> on the [`v1` branch](https://github.com/DEVtheOPS/opencode-plugin-otel/tree/v1) and the `1.x` release
> line. See [OpenCode version support](#opencode-version-support).

- [OpenCode version support](#opencode-version-support)
- [What it instruments](#what-it-instruments)
  - [Metrics](#metrics)
  - [Log events](#log-events)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Plugin options (opencode.json)](#plugin-options-opencodejson)
  - [Quick start](#quick-start)
  - [Headers and resource attributes](#headers-and-resource-attributes)
  - [Dynamic headers](#dynamic-headers)
  - [Model-visible context capture](#model-visible-context-capture)
  - [LLM trace propagation](#llm-trace-propagation)
  - [Disabling specific metrics](#disabling-specific-metrics)
  - [Disabling OTLP logs (`OPENCODE_DISABLE_LOGS`)](#disabling-otlp-logs)
  - [Disabling traces (`OPENCODE_DISABLE_TRACES`)](#disabling-traces)
  - [SigNoz example](#signoz-example)
  - [Datadog example](#datadog-example)
  - [Honeycomb example](#honeycomb-example)
  - [Claude Code dashboard compatibility](#claude-code-dashboard-compatibility)
- [Local development](#local-development)
- [GitHub Discord notifications](#github-discord-notifications)

## OpenCode version support

| Plugin line | OpenCode | Config key | Entrypoint |
|-------------|----------|------------|------------|
| `2.x` (`main`) | V2 (`>=2`) | `plugins` | default export `{ id, setup }` |
| `1.x` (`v1` branch) | V1 | `plugin` | named `OtelPlugin` export |

OpenCode V2 replaced the coarse V1 message events (`message.updated`, `message.part.updated`)
and removed `command.executed` and `session.diff` from the plugin event stream. It provides
`permission.asked` / `permission.replied` in place of V1's `permission.updated` / `permission.replied`,
plus a granular session taxonomy
(`session.execution.*`, `session.step.*`, `session.tool.*`, `session.usage.updated`,
`session.retry.scheduled`). This plugin consumes the V2 stream directly, which produces more
accurate LLM and tool span timings than the V1 implementation.

**V1 signal parity:** `lines_of_code.count` / `lines_of_code.total` relied on the V1
`session.diff` event and are not emitted. The V2 client has a session-diff endpoint,
but the V2 plugin context does not expose it; the VCS diff API is repository-scoped
and is not an equivalent per-session total. `command.executed` instrumentation is
replaced by successful shell-tool completion. Message/part spans are replaced by
per-step LLM spans; completed text segments still populate `output.value` and
`llm.output_messages`.

When V2 provides an unambiguous child session ID through subagent tool progress or result metadata,
subagent run spans nest under the dispatch tool span. Ambiguous or missed correlations fall back to
the parent run span; a background child may outlive its already-ended dispatch tool span.

## What it instruments

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `opencode.session.count` | Counter | Incremented on `session.created`, or lazily when a pre-existing session is first observed |
| `opencode.token.usage` | Counter | Per token type: `input`, `output`, `reasoning`, `cacheRead`, `cacheCreation` (per `session.step.ended`) |
| `opencode.cost.usage` | Counter | USD cost per completed LLM step |
| `opencode.commit.count` | Counter | `git commit` commands observed in successful, executed shell-tool calls; Git's resulting repository state is not verified |
| `opencode.tool.duration` | Histogram | Tool execution time in milliseconds |
| `opencode.cache.count` | Counter | Cache activity per step: `type=cacheRead` or `type=cacheCreation` |
| `opencode.session.duration` | Histogram | Observed duration from session creation (or first observation) to execution end / idle in milliseconds |
| `opencode.message.count` | Counter | Assistant messages with a completed or failed LLM step |
| `opencode.session.token.total` | Histogram | Total tokens consumed per session, recorded when an execution ends |
| `opencode.session.cost.total` | Histogram | Total cost per session in USD, recorded when an execution ends |
| `opencode.model.usage` | Counter | Messages per model and provider |
| `opencode.retry.count` | Counter | API retries observed via durable `session.retry.scheduled` events |
| `opencode.subtask.count` | Counter | Sub-agent sessions observed via `session.created` with a `parentID` |

### Log events

| Event | Description |
|-------|-------------|
| `session.created` | Session started |
| `session.idle` | Session went idle (includes total tokens, cost, messages) |
| `session.error` | Execution failed |
| `user_prompt` | User prompt durably admitted via `session.inbox.enqueued` (includes `prompt_length`, `delivery`; also `prompt` when `OPENCODE_CAPTURE_PROMPT_IN_LOGS` is set) |
| `api_request` | Completed LLM step (tokens, cost) |
| `api_error` | Failed LLM step (error summary) |
| `tool_result` | Tool completed or errored (duration, success, output size) |
| `tool_decision` | Permission prompt answered (accept/reject) |
| `commit` | Git commit detected |
| `subtask_invoked` | Sub-agent session created (agent and parent session ID) |

## Installation

Add the plugin to your opencode config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devtheops/opencode-plugin-otel"]
}
```

For local development, install dependencies with `bun install` in the checkout and
create `.opencode/plugins/otel/index.ts` in the project where OpenCode runs:

```ts
export { default } from "/path/to/opencode-plugin-otel/src/index.ts"
```

OpenCode V2 discovers this directory automatically. On OpenCode `2.0.1`, a
`plugins` package entry pointing directly to an absolute `.ts` file is rejected;
the package loader expects a directory.

## Configuration

The plugin reads its settings from `OPENCODE_*` environment variables and/or from inline [plugin options](#plugin-options-opencodejson) in `opencode.json`. When both are present, an option wins over the matching environment variable, which wins over the built-in default.

When OpenCode loads multiple locations in one process, all enabled instances must
use identical telemetry configuration. A conflicting endpoint, authentication,
resource attribute, metric prefix, or signal option fails setup rather than
exporting one location's data using another location's settings. Event attributes
use the observed session's project ID when available. Shared event processing is
serialized so an asynchronous session lookup cannot reorder step start/end events.

The environment variables (set them in your shell profile — `~/.zshrc`, `~/.bashrc`, etc.):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_ENABLE_TELEMETRY` | *(unset)* | Set to any non-empty value to enable the plugin |
| `OPENCODE_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint. Always include a URL scheme. For `grpc`, use the collector URL (for example `http://localhost:4317` or `grpc://collector:4317`). For `http/protobuf` and `http/json`, use the base URL and the plugin will append `/v1/traces`, `/v1/metrics`, and `/v1/logs`. |
| `OPENCODE_OTLP_PROTOCOL` | `grpc` | OTLP transport protocol: `grpc`, `http/protobuf`, or `http/json` |
| `OPENCODE_OTLP_METRICS_INTERVAL` | `60000` | Metrics export interval in milliseconds |
| `OPENCODE_OTLP_LOGS_INTERVAL` | `5000` | Logs export interval in milliseconds |
| `OPENCODE_METRIC_PREFIX` | `opencode.` | Prefix for all metric names (e.g. set to `claude_code.` for Claude Code dashboard compatibility) |
| `OPENCODE_DISABLE_METRICS` | *(unset)* | Comma-separated list of metric name suffixes to disable (e.g. `cache.count,session.duration`) |
| `OPENCODE_DISABLE_LOGS` | *(unset)* | Set to any non-empty value to suppress all OTLP log events while leaving metrics and traces unchanged |
| `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | *(unset)* | Set to any non-empty value to include the full prompt text in the `prompt` attribute of `user_prompt` log events. **Log events only** — trace spans carry an observed prompt in `input.value` regardless of this flag (disable span-level capture separately via `OPENCODE_DISABLE_TRACES`). **Off by default — prompts may contain secrets or PII; enable only for trusted collectors.** |
| `OPENCODE_CAPTURE_MODEL_CONTEXT` | *(unset)* | Set to any non-empty value to attach a bounded text-only preview of the primary model-visible context to LLM spans. Off by default; can include system instructions, earlier messages, and tool text. |
| `OPENCODE_DISABLE_TRACES` | *(unset)* | Comma-separated list of trace types to disable (`session`, `llm`, `tool`). Use `all`, `*`, `true`, or `1` to disable every trace type |
| `OPENCODE_OTLP_HEADERS` | *(unset)* | Comma-separated `key=value` headers added to all OTLP exports. **Keep out of version control — may contain sensitive auth tokens.** |
| `OPENCODE_OTLP_HEADERS_HELPER` | *(unset)* | Executable script/binary that returns dynamic OTLP headers as JSON after an auth failure. Helper headers override `OPENCODE_OTLP_HEADERS`. |
| `OPENCODE_RESOURCE_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs merged into the OTel resource. Example: `service.version=1.2.3,deployment.environment=production` |
| `OPENCODE_SPAN_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs attached to every emitted span, log event, and metric data point. Example: `team=platform,deployment.environment=production` |
| `OPENCODE_OTLP_METRICS_TEMPORALITY` | *(unset)* | Metrics aggregation temporality: `delta`, `cumulative`, or `lowmemory`. Required for Datadog (`delta`). Passed to the exporter and copied to `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. |
| `OPENCODE_TRACEPARENT` | *(unset)* | W3C [`traceparent`](https://www.w3.org/TR/trace-context/#traceparent-header) string. When set, all spans are parented under this remote context so opencode traces nest inside a caller's trace (e.g. a CI job). Invalid values are logged and ignored. Note: with the default `ParentBased` sampler, a value with the sampled flag off (`...-00`) suppresses all trace export. |
| `OPENCODE_TRACESTATE` | *(unset)* | W3C [`tracestate`](https://www.w3.org/TR/trace-context/#tracestate-header) string, parsed alongside `OPENCODE_TRACEPARENT` and attached to the remote parent context. Ignored unless a valid `OPENCODE_TRACEPARENT` is also set. |
| `OPENCODE_TRACE_PROPAGATION_PROVIDERS` | *(unset)* | Comma-separated opencode provider IDs that receive W3C `traceparent` and `tracestate` headers on LLM requests. Use `*` to explicitly enable every provider. |

Prompt logging remains disabled by default. Enable it only when the configured telemetry destination is trusted to receive potentially sensitive prompt contents.

### Plugin options (opencode.json)

Every setting can also be passed inline through opencode's plugin **object form**, so nothing has to be exported in a shell. Options take precedence over the matching `OPENCODE_*` environment variable, which in turn wins over the built-in default.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@devtheops/opencode-plugin-otel",
      "options": {
        "enabled": true,
        "endpoint": "http://localhost:4317",
        "protocol": "grpc",
        "metricPrefix": "claude_code.",
        "resourceAttributes": "service.version=1.2.3,deployment.environment=production",
        "disabledTraces": ["tool"]
      }
    }
  ]
}
```

Option keys mirror the resolved config and map to the environment variables:

| Option | Environment variable |
|--------|----------------------|
| `enabled` | `OPENCODE_ENABLE_TELEMETRY` |
| `logsEnabled` | `OPENCODE_DISABLE_LOGS` (inverted) |
| `capturePromptInLogs` | `OPENCODE_CAPTURE_PROMPT_IN_LOGS` |
| `captureModelContext` | `OPENCODE_CAPTURE_MODEL_CONTEXT` |
| `logLevel` | *(none — option only)*: `debug`, `info`, `warn`, `error` |
| `endpoint` | `OPENCODE_OTLP_ENDPOINT` |
| `protocol` | `OPENCODE_OTLP_PROTOCOL` |
| `metricsInterval` | `OPENCODE_OTLP_METRICS_INTERVAL` |
| `logsInterval` | `OPENCODE_OTLP_LOGS_INTERVAL` |
| `metricPrefix` | `OPENCODE_METRIC_PREFIX` |
| `otlpHeaders` | `OPENCODE_OTLP_HEADERS` |
| `otlpHeadersHelper` | `OPENCODE_OTLP_HEADERS_HELPER` |
| `resourceAttributes` | `OPENCODE_RESOURCE_ATTRIBUTES` |
| `spanAttributes` | `OPENCODE_SPAN_ATTRIBUTES` |
| `traceparent` | `OPENCODE_TRACEPARENT` |
| `tracestate` | `OPENCODE_TRACESTATE` |
| `metricsTemporality` | `OPENCODE_OTLP_METRICS_TEMPORALITY` |
| `disabledMetrics` | `OPENCODE_DISABLE_METRICS` (array, not a comma string) |
| `disabledTraces` | `OPENCODE_DISABLE_TRACES` (array, not a comma string) |
| `tracePropagationProviders` | `OPENCODE_TRACE_PROPAGATION_PROVIDERS` (array, not a comma string) |

> **Security note:** `opencode.json` is frequently committed to version control. Keep secrets such as `otlpHeaders` in an environment variable or an opencode `{env:VAR}` substitution (e.g. `"otlpHeaders": "{env:OTEL_HEADERS}"`) rather than inline.

### Quick start

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=http://localhost:4317
export OPENCODE_OTLP_PROTOCOL=grpc
opencode
```

Always set `OPENCODE_OTLP_ENDPOINT` to a full URL with a scheme. Scheme-less values like `localhost:4317` are rejected.

For `OPENCODE_OTLP_PROTOCOL=http/protobuf` or `OPENCODE_OTLP_PROTOCOL=http/json`, set `OPENCODE_OTLP_ENDPOINT` to the collector base URL rather than a per-signal path. The plugin expands it to `/v1/traces`, `/v1/metrics`, and `/v1/logs` automatically.

### Headers and resource attributes

```bash
# Auth token for a managed collector (e.g. Honeycomb, Grafana Cloud)
export OPENCODE_OTLP_HEADERS="x-honeycomb-team=your-api-key,x-honeycomb-dataset=opencode"

# Tag every metric and log with deployment context
export OPENCODE_RESOURCE_ATTRIBUTES="service.version=1.2.3,deployment.environment=production"

# Tag every span, log event, and metric point with filterable attributes
export OPENCODE_SPAN_ATTRIBUTES="team=platform,deployment.environment=production"
```

> **Security note:** `OPENCODE_OTLP_HEADERS` typically contains auth tokens. Set it in your shell profile (`~/.zshrc`, `~/.bashrc`) or a secrets manager — never commit it to version control or print it in CI logs.

`OPENCODE_RESOURCE_ATTRIBUTES` and `OPENCODE_SPAN_ATTRIBUTES` are independent:

- Use `OPENCODE_RESOURCE_ATTRIBUTES` for producer metadata on the OTel Resource.
- Use `OPENCODE_SPAN_ATTRIBUTES` for attributes that need to appear on each span, log event, and metric data point for filtering or grouping in backends.

### Dynamic headers

Use `OPENCODE_OTLP_HEADERS_HELPER` when your collector requires short-lived authentication tokens. When this is set, the plugin prewarms the helper once during startup so the first export can use fresh credentials. If a later OTLP export fails with an authentication error (`401`/`403` for HTTP or `UNAUTHENTICATED`/`PERMISSION_DENIED` for gRPC), the plugin refreshes headers again, rebuilds the exporter, and retries the failed export once.

```bash
export OPENCODE_OTLP_HEADERS_HELPER=/path/to/opencode-otel-headers.sh
```

Use an absolute helper path. If you need the path to follow the current project, `OPENCODE_OTLP_HEADERS_HELPER` also supports `${PROJECT_ROOT}`, `${WORKTREE}`, and `${DIRECTORY}` placeholders.

```bash
export OPENCODE_OTLP_HEADERS_HELPER='${PROJECT_ROOT}/scripts/opencode-otel-headers.sh'
```

The helper must be executable and print a JSON object to stdout:

```bash
#!/bin/sh
printf '{"Authorization":"Bearer %s"}' "$(get-token.sh)"
```

For a Cloud Run collector using IAM authentication, `get-token.sh` might be `gcloud auth print-identity-token`.

If `OPENCODE_OTLP_HEADERS` is also set, helper-provided headers override static headers with the same name. Header values are never logged.

### Model-visible context capture

```bash
export OPENCODE_CAPTURE_MODEL_CONTEXT=1
```

When enabled, `session.hook("context")` captures up to two system parts and the last twelve
messages, retaining only text parts and truncating each to 1,000 characters. The matching primary
LLM span receives this preview in `llm.input_messages` and its latest user text in `input.value`.
Media bytes and structured tool payloads are excluded. The hook observes context at its position
in plugin order; subsequent plugins can still change the request. This is independent of
`OPENCODE_CAPTURE_PROMPT_IN_LOGS` and can include secrets or PII from previous messages,
system instructions, or tool text. Use it only with a trusted collector.

### LLM trace propagation

Use `OPENCODE_TRACE_PROPAGATION_PROVIDERS` to connect this plugin's LLM spans to spans emitted by an LLM gateway such as LiteLLM or vLLM. For matching provider IDs, the plugin injects the current `opencode.llm` span as the W3C `traceparent` header and includes `tracestate` when present.

Propagation is limited to primary agent-loop requests whose provider, model, and agent match the active LLM step; title, compaction, and transient generation requests are not parented to that step.

```bash
export OPENCODE_TRACE_PROPAGATION_PROVIDERS="company-litellm,vllm"
```

The values are opencode provider IDs, including custom names configured under the `provider` key in `opencode.json`. Propagation is disabled when the setting is unset. Use `*` only when every configured provider should receive trace context.

Only W3C trace context is propagated. The plugin does not inject arbitrary headers or W3C baggage. Configure static provider-specific headers through the provider's native `options.headers` setting in `opencode.json`.

For WebSocket-backed providers, the plugin also injects into V2's experimental
`experimental.ws.handshake` hook. Changing trace headers per step can reopen a reused socket,
so enable propagation only for providers where connected traces outweigh connection reuse.
The hook is experimental and should be verified against your provider's WebSocket route.

### Disabling specific metrics

Use `OPENCODE_DISABLE_METRICS` to suppress individual metrics. The value is a comma-separated list of metric name suffixes (without the prefix).

Disabling a metric only stops the counter/histogram from being incremented — the corresponding log events are still emitted.

```bash
# Disable a single metric
export OPENCODE_DISABLE_METRICS="retry.count"

# Disable multiple metrics
export OPENCODE_DISABLE_METRICS="cache.count,session.duration,session.token.total,session.cost.total,model.usage,retry.count,message.count"
```

#### opencode-only metrics

The following metrics are specific to opencode and have no equivalent in Claude Code's built-in monitoring. If you are using a Claude Code dashboard and want to avoid cluttering it with opencode-only metrics, you can disable them:

```bash
export OPENCODE_DISABLE_METRICS="cache.count,session.duration,session.token.total,session.cost.total,model.usage,retry.count,message.count"
```

| Metric suffix | Why it's opencode-only |
|---------------|------------------------|
| `cache.count` | Tracks cache read/write activity as occurrence counts — not a Claude Code signal |
| `session.duration` | Session wall-clock duration — not emitted by Claude Code |
| `session.token.total` | Per-session token histogram — not emitted by Claude Code |
| `session.cost.total` | Per-session cost histogram — not emitted by Claude Code |
| `model.usage` | Per-model message counter — not emitted by Claude Code |
| `retry.count` | API retry counter — not emitted by Claude Code |
| `message.count` | Completed message counter — not emitted by Claude Code |

### Disabling OTLP logs

Use `OPENCODE_DISABLE_LOGS` to suppress every OTLP log event emitted by the plugin.

```bash
export OPENCODE_DISABLE_LOGS=1
```

This only disables OTLP logs. Metrics and traces continue to be exported unless they are disabled separately.

### Disabling traces

Use `OPENCODE_DISABLE_TRACES` to suppress one or more trace types.

```bash
# Disable one trace type
export OPENCODE_DISABLE_TRACES="tool"

# Disable multiple trace types
export OPENCODE_DISABLE_TRACES="llm,tool"

# Disable every trace type explicitly
export OPENCODE_DISABLE_TRACES="all"
```

Accepted explicit "disable all traces" values are `all`, `*`, `true`, and `1`.

### SigNoz example

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT="https://ingest.us.signoz.cloud:443"
export OPENCODE_OTLP_HEADERS="signoz-ingestion-key=<SIGNOZ_INGESTION_KEY>"
```

> Use `https://ingest.in.signoz.cloud:443` for India, `https://ingest.eu2.signoz.cloud:443` for EU2, etc.
> See [SigNoz setup docs](https://signoz.io/docs/cloud/) for all regions.

### Datadog example

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=https://otlp.datadoghq.com
export OPENCODE_OTLP_PROTOCOL=http/protobuf
export OPENCODE_OTLP_HEADERS="dd-api-key=YOUR_DATADOG_API_KEY"

# Required — Datadog's OTLP intake only accepts delta temporality
export OPENCODE_OTLP_METRICS_TEMPORALITY=delta
```

> **Note:** The endpoint is `otlp.datadoghq.com` (not `api.datadoghq.com`).
> Use `otlp.datadoghq.eu` for EU, `otlp.us3.datadoghq.com` for US3, etc.
> See [Datadog OTLP docs](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/) for all regions.

### Honeycomb example

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=https://api.honeycomb.io
export OPENCODE_OTLP_PROTOCOL=http/protobuf
```

### Grafana Cloud example

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp
export OPENCODE_OTLP_PROTOCOL=http/protobuf
export OPENCODE_OTLP_HEADERS="Authorization=Basic <base64-instance-id:api-key>"
```

### Claude Code dashboard compatibility

```bash
export OPENCODE_METRIC_PREFIX=claude_code.
```

## Local development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## GitHub Discord notifications

This repo includes a reusable workflow at `.github/workflows/discord-notify.yml` that posts a Discord embed for supported GitHub events. The included `.github/workflows/discord-events.yml` file wires it up for:

- `issues.opened`
- `pull_request.opened`
- `release.published`

Set an org or repo secret named `DISCORD_WEBHOOK` and the workflow will post to that webhook automatically.

To reuse it from another repository in the `DEVtheOPS` org:

```yaml
name: Discord Events

on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
  release:
    types: [published]

jobs:
  notify-discord:
    uses: DEVtheOPS/opencode-plugin-otel/.github/workflows/discord-notify.yml@main
    with:
      username: DEVtheOPS Bot
      title_prefix: "[DEVtheOPS]"
      include_body: true
    secrets:
      discord_webhook: ${{ secrets.DISCORD_WEBHOOK }}
```

Available workflow inputs:

- `username`: webhook display name
- `avatar_url`: webhook avatar image URL
- `title_prefix`: optional title prefix for the embed
- `include_body`: include the issue, PR, or release body in the card
- `color`: fallback embed color for unsupported events

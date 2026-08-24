# opencode-plugin-otel

[![npm version](https://img.shields.io/npm/v/@devtheops/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@devtheops/opencode-plugin-otel)
[![npm downloads](https://img.shields.io/npm/dm/@devtheops/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@devtheops/opencode-plugin-otel)
[![GitHub stars](https://img.shields.io/github/stars/DEVtheOPS/opencode-plugin-otel.svg)](https://github.com/DEVtheOPS/opencode-plugin-otel/stargazers)
[![Build status](https://img.shields.io/github/actions/workflow/status/DEVtheOPS/opencode-plugin-otel/release-please.yml?branch=main)](https://github.com/DEVtheOPS/opencode-plugin-otel/actions/workflows/release-please.yml)
[![Discord notifications](https://img.shields.io/badge/discord-notifications-5865F2?logo=discord&logoColor=white)](https://discord.gg/zavuskz8xB)
[![License](https://img.shields.io/npm/l/@devtheops/opencode-plugin-otel.svg)](https://github.com/DEVtheOPS/opencode-plugin-otel/blob/main/LICENSE)

An [opencode](https://opencode.ai) plugin that exports telemetry via OpenTelemetry (OTLP over gRPC or HTTP/protobuf), mirroring the same signals as [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage).

- [What it instruments](#what-it-instruments)
  - [Metrics](#metrics)
  - [Log events](#log-events)
  - [Traces](#traces)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Plugin options (opencode.json)](#plugin-options-opencodejson)
  - [Quick start](#quick-start)
  - [Headers and resource attributes](#headers-and-resource-attributes)
  - [Dynamic headers](#dynamic-headers)
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

## What it instruments

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `opencode.session.count` | Counter | Incremented on each `session.created` event |
| `opencode.token.usage` | Counter | Per token type: `input`, `output`, `reasoning`, `cacheRead`, `cacheCreation` |
| `opencode.cost.usage` | Counter | USD cost per completed assistant message |
| `opencode.lines_of_code.count` | Counter | **Gross positive churn, not a net total.** Emits the positive delta of `additions`/`deletions` since the previous `session.diff` for the same session; negative deltas (when opencode's cumulative `additions` or `deletions` shrinks vs. the last event) are dropped. Summing the counter therefore reports gross lines added/removed across forward transitions — it does *not* reconcile back to the session's current state after any revert (full or partial). Intra-message rewrites that opencode collapses in its per-message cumulative are not visible here at all. Use `opencode.lines_of_code.total` for the authoritative live cumulative. |
| `opencode.lines_of_code.total` | Gauge | **Authoritative live cumulative lines added/removed for the session.** Refreshed on every `session.diff` with opencode's current cumulative value. Drops back to `0` if opencode reports a revert to baseline, and tracks partial reverts faithfully. Query this (not the counter) to answer "what does this session currently amount to". |
| `opencode.commit.count` | Counter | Git commits detected via bash tool |
| `opencode.tool.duration` | Histogram | Tool execution time in milliseconds |
| `opencode.cache.count` | Counter | Cache activity per message: `type=cacheRead` or `type=cacheCreation` |
| `opencode.session.duration` | Histogram | Session duration from created to idle in milliseconds |
| `opencode.message.count` | Counter | Completed assistant messages per session |
| `opencode.session.token.total` | Histogram | Total tokens consumed per session, recorded on idle |
| `opencode.session.cost.total` | Histogram | Total cost per session in USD, recorded on idle |
| `opencode.model.usage` | Counter | Messages per model and provider |
| `opencode.retry.count` | Counter | API retries observed via `session.status` events |

### Log events

| Event | Description |
|-------|-------------|
| `session.created` | Session started |
| `session.idle` | Session went idle (includes total tokens, cost, messages) |
| `session.error` | Session error |
| `user_prompt` | User sent a message (includes `prompt_length`, `model`, `agent`; also `prompt` when `OPENCODE_CAPTURE_PROMPT_IN_LOGS` is set) |
| `api_request` | Completed assistant message (tokens, cost, duration) |
| `api_error` | Failed assistant message (error summary, duration) |
| `tool_result` | Tool completed or errored (duration, success, output size) |
| `tool_decision` | Permission prompt answered (accept/reject) |
| `commit` | Git commit detected |

### Traces

| Span | Description |
|------|-------------|
| `opencode.session` | One user turn, or a subagent session. Carries `session.id`, the prompt in `input.value`, and `session.title` once opencode has named the session |
| `opencode.llm` | One model turn, with model, token counts and finish reason |
| `opencode.tool.<name>` | One tool call, with its arguments in `input.value` and the result in `output.value` |

opencode names a session from its first prompt, shortly after the session
starts. The plugin picks that name up from `session.updated` and stamps it on
the spans that are still open, so a backend can show "Fix the flaky test"
instead of `ses_fcc85048effeCXe1RvEetcywD4`. Sessions opencode has not named
carry no `session.title` at all.

## Installation

Add the plugin to your opencode config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@devtheops/opencode-plugin-otel"]
}
```

Or point directly at a local checkout for development:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/opencode-plugin-otel/src/index.ts"]
}
```

## Configuration

The plugin reads its settings from `OPENCODE_*` environment variables and/or from inline [plugin options](#plugin-options-opencodejson) in `opencode.json`. When both are present, an option wins over the matching environment variable, which wins over the built-in default.

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
| `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | *(unset)* | Set to any non-empty value to include the full prompt text in the `prompt` attribute of `user_prompt` log events. **Log events only** — trace spans always carry the prompt in `input.value` regardless of this flag (disable span-level capture separately via `OPENCODE_DISABLE_TRACES`). **Off by default — prompts may contain secrets or PII; enable only for trusted collectors.** |
| `OPENCODE_DISABLE_TRACES` | *(unset)* | Comma-separated list of trace types to disable (`session`, `llm`, `tool`). Use `all`, `*`, `true`, or `1` to disable every trace type |
| `OPENCODE_OTLP_HEADERS` | *(unset)* | Comma-separated `key=value` headers added to all OTLP exports. **Keep out of version control — may contain sensitive auth tokens.** |
| `OPENCODE_OTLP_HEADERS_HELPER` | *(unset)* | Executable script/binary that returns dynamic OTLP headers as JSON after an auth failure. Helper headers override `OPENCODE_OTLP_HEADERS`. |
| `OPENCODE_RESOURCE_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs merged into the OTel resource. Example: `service.version=1.2.3,deployment.environment=production` |
| `OPENCODE_SPAN_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs attached to every emitted span, log event, and metric data point. Example: `team=platform,deployment.environment=production` |
| `OPENCODE_OTLP_METRICS_TEMPORALITY` | *(unset)* | Metrics aggregation temporality: `delta`, `cumulative`, or `lowmemory`. Required for Datadog (`delta`). Copied to `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. |
| `OPENCODE_TRACEPARENT` | *(unset)* | W3C [`traceparent`](https://www.w3.org/TR/trace-context/#traceparent-header) string. When set, all spans are parented under this remote context so opencode traces nest inside a caller's trace (e.g. a CI job). Invalid values are logged and ignored. Note: with the default `ParentBased` sampler, a value with the sampled flag off (`...-00`) suppresses all trace export. |
| `OPENCODE_TRACESTATE` | *(unset)* | W3C [`tracestate`](https://www.w3.org/TR/trace-context/#tracestate-header) string, parsed alongside `OPENCODE_TRACEPARENT` and attached to the remote parent context. Ignored unless a valid `OPENCODE_TRACEPARENT` is also set. |
| `OPENCODE_TRACE_PROPAGATION_PROVIDERS` | *(unset)* | Comma-separated opencode provider IDs that receive W3C `traceparent` and `tracestate` headers on LLM requests. Use `*` to explicitly enable every provider. |

Prompt logging remains disabled by default. Enable it only when the configured telemetry destination is trusted to receive potentially sensitive prompt contents.

### Plugin options (opencode.json)

Every setting can also be passed inline through opencode's plugin **tuple form**, so nothing has to be exported in a shell. Options take precedence over the matching `OPENCODE_*` environment variable, which in turn wins over the built-in default.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@devtheops/opencode-plugin-otel", {
      "enabled": true,
      "endpoint": "http://localhost:4317",
      "protocol": "grpc",
      "metricPrefix": "claude_code.",
      "resourceAttributes": "service.version=1.2.3,deployment.environment=production",
      "disabledTraces": ["tool"]
    }]
  ]
}
```

Option keys mirror the resolved config and map to the environment variables:

| Option | Environment variable |
|--------|----------------------|
| `enabled` | `OPENCODE_ENABLE_TELEMETRY` |
| `logsEnabled` | `OPENCODE_DISABLE_LOGS` (inverted) |
| `capturePromptInLogs` | `OPENCODE_CAPTURE_PROMPT_IN_LOGS` |
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

### LLM trace propagation

Use `OPENCODE_TRACE_PROPAGATION_PROVIDERS` to connect this plugin's LLM spans to spans emitted by an LLM gateway such as LiteLLM or vLLM. For matching provider IDs, the plugin injects the current `opencode.llm` span as the W3C `traceparent` header and includes `tracestate` when present.

```bash
export OPENCODE_TRACE_PROPAGATION_PROVIDERS="company-litellm,vllm"
```

The values are opencode provider IDs, including custom names configured under the `provider` key in `opencode.json`. Propagation is disabled when the setting is unset. Use `*` only when every configured provider should receive trace context.

Only W3C trace context is propagated. The plugin does not inject arbitrary headers or W3C baggage. Configure static provider-specific headers through the provider's native `options.headers` setting in `opencode.json`.

### Disabling specific metrics

Use `OPENCODE_DISABLE_METRICS` to suppress individual metrics. The value is a comma-separated list of metric name suffixes (without the prefix).

Disabling a metric only stops the counter/histogram from being incremented — the corresponding log events are still emitted.

```bash
# Disable a single metric
export OPENCODE_DISABLE_METRICS="retry.count"

# Disable multiple metrics
export OPENCODE_DISABLE_METRICS="cache.count,session.duration,session.token.total,session.cost.total,model.usage,retry.count,message.count"

# Disable the new per-session cumulative gauge while keeping the delta counter
export OPENCODE_DISABLE_METRICS="lines_of_code.total"
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

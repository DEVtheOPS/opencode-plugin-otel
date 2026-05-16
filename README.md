# opencode-plugin-otel

[![npm version](https://img.shields.io/npm/v/@devtheops/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@devtheops/opencode-plugin-otel)
[![npm downloads](https://img.shields.io/npm/dm/@devtheops/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@devtheops/opencode-plugin-otel)
[![GitHub stars](https://img.shields.io/github/stars/DEVtheOPS/opencode-plugin-otel.svg)](https://github.com/DEVtheOPS/opencode-plugin-otel/stargazers)
[![Build status](https://img.shields.io/github/actions/workflow/status/DEVtheOPS/opencode-plugin-otel/release-please.yml?branch=main)](https://github.com/DEVtheOPS/opencode-plugin-otel/actions/workflows/release-please.yml)
[![License](https://img.shields.io/npm/l/@devtheops/opencode-plugin-otel.svg)](https://github.com/DEVtheOPS/opencode-plugin-otel/blob/main/LICENSE)

An [opencode](https://opencode.ai) plugin that exports telemetry via OpenTelemetry (OTLP over gRPC or HTTP/protobuf), mirroring the same signals as [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage).

- [What it instruments](#what-it-instruments)
  - [Metrics](#metrics)
  - [Log events](#log-events)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Quick start](#quick-start)
  - [Headers and resource attributes](#headers-and-resource-attributes)
  - [Dynamic headers](#dynamic-headers)
  - [User identity tracking](#user-identity-tracking)
  - [Disabling specific metrics](#disabling-specific-metrics)
  - [Datadog example](#datadog-example)
  - [Honeycomb example](#honeycomb-example)
  - [Claude Code dashboard compatibility](#claude-code-dashboard-compatibility)
- [Local development](#local-development)

## What it instruments

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `opencode.session.count` | Counter | Incremented on each `session.created` event |
| `opencode.token.usage` | Counter | Per token type: `input`, `output`, `reasoning`, `cacheRead`, `cacheCreation` |
| `opencode.cost.usage` | Counter | USD cost per completed assistant message |
| `opencode.lines_of_code.count` | Counter | Lines added/removed per `session.diff` event |
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
| `user_prompt` | User sent a message (includes `prompt_length`, `model`, `agent`) |
| `api_request` | Completed assistant message (tokens, cost, duration) |
| `api_error` | Failed assistant message (error summary, duration) |
| `tool_result` | Tool completed or errored (duration, success, output size) |
| `tool_decision` | Permission prompt answered (accept/reject) |
| `commit` | Git commit detected |

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

All configuration is via environment variables. Set them in your shell profile (`~/.zshrc`, `~/.bashrc`, etc.).

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_ENABLE_TELEMETRY` | _(unset)_ | Set to any non-empty value to enable the plugin |
| `OPENCODE_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint. For `grpc`, use the collector host/port. For `http/protobuf`, use the base URL and the plugin will append `/v1/traces`, `/v1/metrics`, and `/v1/logs`. |
| `OPENCODE_OTLP_PROTOCOL` | `grpc` | OTLP transport protocol: `grpc` or `http/protobuf` |
| `OPENCODE_OTLP_METRICS_INTERVAL` | `60000` | Metrics export interval in milliseconds |
| `OPENCODE_OTLP_LOGS_INTERVAL` | `5000` | Logs export interval in milliseconds |
| `OPENCODE_METRIC_PREFIX` | `opencode.` | Prefix for all metric names (e.g. set to `claude_code.` for Claude Code dashboard compatibility) |
| `OPENCODE_DISABLE_METRICS` | _(unset)_ | Comma-separated list of metric name suffixes to disable (e.g. `cache.count,session.duration`) |
| `OPENCODE_OTLP_HEADERS` | _(unset)_ | Comma-separated `key=value` headers added to all OTLP exports. **Keep out of version control — may contain sensitive auth tokens.** |
| `OPENCODE_OTLP_HEADERS_HELPER` | _(unset)_ | Executable script/binary that returns dynamic OTLP headers as JSON after an auth failure. Helper headers override `OPENCODE_OTLP_HEADERS`. |
| `OPENCODE_RESOURCE_ATTRIBUTES` | _(unset)_ | Comma-separated `key=value` pairs merged into the OTel resource. Example: `service.version=1.2.3,deployment.environment=production` |
| `OPENCODE_OTLP_METRICS_TEMPORALITY` | _(unset)_ | Metrics aggregation temporality: `delta`, `cumulative`, or `lowmemory`. Required for Datadog (`delta`). Copied to `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. |
| `OPENCODE_DISABLE_USER_TRACKING` | _(unset)_ | Set to any non-empty value to omit `enduser.id` from all signals and the resource. See [User identity tracking](#user-identity-tracking). |

### Quick start

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=http://localhost:4317
export OPENCODE_OTLP_PROTOCOL=grpc
opencode
```

For `OPENCODE_OTLP_PROTOCOL=http/protobuf`, set `OPENCODE_OTLP_ENDPOINT` to the collector base URL rather than a per-signal path. The plugin expands it to `/v1/traces`, `/v1/metrics`, and `/v1/logs` automatically.

### Headers and resource attributes

```bash
# Auth token for a managed collector (e.g. Honeycomb, Grafana Cloud)
export OPENCODE_OTLP_HEADERS="x-honeycomb-team=your-api-key,x-honeycomb-dataset=opencode"

# Tag every metric and log with deployment context
export OPENCODE_RESOURCE_ATTRIBUTES="service.version=1.2.3,deployment.environment=production"
```

> **Security note:** `OPENCODE_OTLP_HEADERS` typically contains auth tokens. Set it in your shell profile (`~/.zshrc`, `~/.bashrc`) or a secrets manager — never commit it to version control or print it in CI logs.

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

### User identity tracking

The plugin tags every metric datapoint, log record, and trace span with an `enduser.id` attribute identifying the developer running the session. The value is auto-detected from `os.userInfo().username`; if opencode's config sets a custom `username`, that value supersedes the OS one for metrics and logs once the config hook fires.

The reason this is a signal-level attribute (not just a resource attribute set via `OPENCODE_RESOURCE_ATTRIBUTES`) is that some OTLP backends — Datadog's direct OTLP intake in particular — only promote a hardcoded set of well-known resource attributes to tags. Custom resource attributes like `enduser.id` are silently dropped. Datapoint-level attributes are always preserved.

| Signal | Where `enduser.id` lives |
|--------|--------------------------|
| Metrics | Datapoint attribute (refined by `cfg.username` after config hook) |
| Logs | Log record attribute (refined by `cfg.username` after config hook) |
| Traces | Resource attribute (frozen at startup) **and** span attribute (refined by `cfg.username` for spans started after the config hook fires) |

Override precedence:

- `OPENCODE_RESOURCE_ATTRIBUTES=enduser.id=…` overrides the resource-level value (used by trace spans and, depending on the backend, attached to metric/log records). It does not affect span attributes set per-span from the auto-detected username.
- The trace resource is built once at startup and does not refresh when `cfg.username` arrives later; new span attributes do reflect that refinement. In practice the OS and configured usernames are identical for almost every user.

If `os.userInfo()` throws (e.g. containerised runs with no passwd entry), `enduser.id` is omitted from every signal rather than tagged with a placeholder.

To opt out entirely:

```bash
export OPENCODE_DISABLE_USER_TRACKING=1
```

When set, `enduser.id` is omitted from `commonAttrs` and from the auto-detected resource. If `OPENCODE_RESOURCE_ATTRIBUTES=enduser.id=…` is set in addition, the explicit value still lands on the resource (the env merge runs unconditionally).

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

# OpenCode integration tests

```sh
bun run test:integration
```

These tests run the pinned OpenCode SDK (`2.0.20`) with the actual plugin in a fresh Bun subprocess for each scenario. They require Git, but no model credentials, Docker, or external telemetry service. The regular `bun test` command and CI include them too.

Two temporary HTTP servers bind to loopback on automatically assigned ports:

- An OpenAI-compatible Chat Completions endpoint returns scripted SSE responses and captures incoming model requests. It requests the built-in `read` tool, then finishes after receiving its real result. Only model responses are mocked; tool execution and OpenCode events are not.
- An OTLP/JSON receiver accepts `/v1/traces`, `/v1/metrics`, and `/v1/logs`. Assertions inspect the actual exported JSON rather than mocked exporter calls.

Each subprocess gets its own temporary Git project, database, home, and XDG directories. It inherits only environment variables needed to launch processes, not provider credentials or telemetry configuration. Model catalog fetching and project config discovery are disabled, and the fixture provider is selected explicitly. Keep the SDK and plugin development dependency versions aligned to avoid duplicate OpenCode runtime modules.

The runner waits for session completion, drains plugin processing during host cleanup, and explicitly flushes telemetry before exiting. Receivers stay alive until the runner exits. A 30-second process deadline prevents hangs. Runner errors include stdout, stderr, model requests, and received payloads; temporary files and servers are cleaned up afterwards.

## Coverage

- Successful text generation exports session and LLM spans with correct parenting, token attributes, session metrics, and logs.
- A real local `read` returns fixture contents to the model and emits a successful tool-result log.
- Disabling tool tracing suppresses tool spans without changing actual execution.
- Local tool spans and duration metrics have three explicit `test.failing` regression cases for [PR #134](https://github.com/DEVtheOPS/opencode-plugin-otel/pull/134). These assertions run against real exported telemetry and currently fail as expected on `main`. Scenario setup and successful execution checks are ordinary tests, so infrastructure failures cannot satisfy an expected-failure assertion. Once the fix lands, change both `test.failing` registrations to `test`; an unexpected pass deliberately fails the suite until then.

Metric assertions use the latest matching cumulative data point, not the sum of repeated exports. Durations are compared between signals rather than against fixed wall-clock values.

## Extending the suite

Add scripted scenarios for tool errors, malformed arguments, permission rejection, shell commits, subagents, and trace propagation. Preserve real OpenCode event production instead of synthesizing `session.tool.*` payloads. Keep live-provider checks separate from deterministic PR checks. This receiver covers HTTP/JSON; gRPC and HTTP/protobuf need separate transport coverage, for example with a temporary OpenTelemetry Collector.

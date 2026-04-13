# Contributing

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- An opencode installation for manual testing

## Getting started

```bash
git clone https://github.com/devtheops/opencode-plugin-otel
cd opencode-plugin-otel
bun install
```

## Development workflow

Point your local opencode config at the repo so changes are picked up immediately without a build step. In `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/opencode-plugin-otel/src/index.ts"]
}
```

opencode loads TypeScript natively via Bun, so there is no build step required during development.

## Commands

| Command | Description |
|---------|-------------|
| `bun run lint` | Run ESLint, including JSDoc formatting checks |
| `bun run check:jsdoc-coverage` | Enforce minimum JSDoc coverage for exported API declarations |
| `bun run typecheck` | Type-check all sources without emitting |
| `bun test` | Run the test suite |

## Project structure

```text
src/
├── index.ts              — Plugin entrypoint, wires everything together
├── types.ts              — Shared types (Level, HandlerContext, Instruments, etc.)
├── config.ts             — Environment config loading and log level resolution
├── otel.ts               — OTel SDK setup, resource construction, instrument creation
├── probe.ts              — TCP connectivity probe for the OTLP endpoint
├── util.ts               — Utility functions (errorSummary, setBoundedMap)
└── handlers/
    ├── session.ts        — session.created / session.idle / session.error
    ├── message.ts        — message.updated / message.part.updated
    ├── permission.ts     — permission.updated / permission.replied
    └── activity.ts       — session.diff / command.executed
```

## Testing locally with a collector

The easiest way to verify telemetry is being emitted is to run a local OpenTelemetry collector:

```bash
docker run --rm -p 4317:4317 \
  otel/opentelemetry-collector:latest
```

Then set `OPENCODE_ENABLE_TELEMETRY=1` and start opencode. The collector will print received spans and metrics to stdout.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). All commits must be structured as:

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | A new feature (triggers a minor version bump) |
| `fix` | A bug fix (triggers a patch version bump) |
| `perf` | A performance improvement |
| `refactor` | Code change that is neither a fix nor a feature |
| `test` | Adding or updating tests |
| `docs` | Documentation only changes |
| `ci` | CI/CD configuration changes |
| `chore` | Maintenance tasks (dependency updates, etc.) |
| `build` | Changes to the build system |

### Breaking changes

Append `!` after the type or add a `BREAKING CHANGE:` footer:

```text
feat!: drop support for OTLP HTTP

BREAKING CHANGE: only OTLP/gRPC is supported going forward
```

### Examples

```text
feat(handlers): add support for file.edited event
fix(probe): handle malformed endpoint URL without throwing
docs: update Datadog configuration example
chore(deps): bump @opentelemetry/api to 1.10.0
```

## Submitting changes

1. Fork the repo and create a branch from `main`: `git checkout -b feat/my-feature`
2. Make your changes and ensure `bun run lint`, `bun run check:jsdoc-coverage`, `bun run typecheck`, and `bun test` pass
3. Commit using Conventional Commits format
4. Open a pull request with a clear, human-readable title and link any related issues in the description

## Releasing

Releases are handled via GitHub Actions. See [the release workflow](.github/workflows/release.yml). To cut a release, push a version tag:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The version bump should follow [SemVer](https://semver.org) based on the commits since the last release:

- `fix` commits → patch (`1.0.x`)
- `feat` commits → minor (`1.x.0`)
- `BREAKING CHANGE` commits → major (`x.0.0`)

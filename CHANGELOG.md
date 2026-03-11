# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.1] — 2026-03-11

### Fixed

- Release workflow now uses npm trusted publishing (OIDC) with Node 22.14.0 and creates a GitHub release with changelog notes and npm package link.

---

## [0.1.0] — 2026-03-11

### Added

- **Release workflow** — `.github/workflows/release.yml` publishes to npm automatically when a `v*` tag is pushed, gated by typecheck and tests.
- **`OPENCODE_OTLP_HEADERS`** — new env var for comma-separated `key=value` OTLP auth headers (e.g. `x-honeycomb-team=abc,x-tenant=org`). Copied to `OTEL_EXPORTER_OTLP_HEADERS` before the SDK initialises.
- **`OPENCODE_RESOURCE_ATTRIBUTES`** — new env var for comma-separated `key=value` OTel resource attributes (e.g. `service.version=1.2.3,deployment.environment=production`). Copied to `OTEL_RESOURCE_ATTRIBUTES` before the SDK initialises.
- JSDoc on all exported functions, types, and constants.
- Regression tests covering `OTEL_*` passthrough behaviour — pre-existing values are preserved when `OPENCODE_*` vars are unset; `OPENCODE_*` vars overwrite when set.
- README table of contents, usage examples for headers and resource attributes, and a security note advising that `OPENCODE_OTLP_HEADERS` may contain sensitive tokens and should not be committed to version control.

### Changed

- `package.json` `main`/`module` now point directly at `src/index.ts`; root `index.ts` re-export removed.
- `files` field added to `package.json` — published package contains only `src/`, reducing install size.
- All user-facing env vars are now consistently `OPENCODE_`-prefixed. `loadConfig` copies `OPENCODE_OTLP_HEADERS` → `OTEL_EXPORTER_OTLP_HEADERS` and `OPENCODE_RESOURCE_ATTRIBUTES` → `OTEL_RESOURCE_ATTRIBUTES` so the OTel SDK picks them up natively.
- `parseEnvInt` now rejects partial numeric strings such as `"1.5"` or `"5000ms"`, returning the fallback instead of silently truncating.

### Removed

- `parseHeaders` removed from `src/otel.ts` — the OTel SDK reads `OTEL_EXPORTER_OTLP_HEADERS` natively once `loadConfig` copies the value across.
- Manual `release:patch` / `release:minor` / `release:major` npm scripts removed in favour of the tag-based CI workflow.

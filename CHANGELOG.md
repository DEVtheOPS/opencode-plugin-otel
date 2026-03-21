# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.4.1...v0.5.0) (2026-03-21)


### Features

* **handlers:** add agent usage metrics and sub-agent tracking ([2d12f88](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/2d12f8846425075c4d8aac1573ac6e488bf868c3))

## [0.4.1](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.4.0...v0.4.1) (2026-03-16)


### Bug Fixes

* Normalize token and cost units for Claude compatibility ([a8b35dc](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/a8b35dc65e84c646b40abccc534afb6110ba2f26))
* **otel:** normalize session token and cost units ([12bfafe](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/12bfafe6b5c31c9a8ec8db09b1cd3c83a8b39ad4))
* **otel:** normalize token and cost units for claude compatibility ([aa3deca](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/aa3deca8cd3323a5d1f9fc749b43d0992f1ba50a))

## [0.4.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.3.0...v0.4.0) (2026-03-15)


### Features

* **config:** add OPENCODE_DISABLE_METRICS to suppress individual metrics ([8ec7c48](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/8ec7c486d102921829a26d1f377df6aa20d988ad))

### Bug Fixes

* **ci:** remove NODE_AUTH_TOKEN to allow OIDC trusted publishing ([fa4cbc7](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/fa4cbc72d5e32ac471f3291b154f5b7c1c5aa097))
* **config:** address code review findings on disable-metrics feature ([1929327](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/1929327d29eb130280625b41d2a3d36be1cdc52f))

## [0.3.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.2.1...v0.3.0) (2026-03-14)

### Features

* **observability:** add debug logging and enhanced metrics ([a1b0a8c](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/a1b0a8cf5263080cf9623355e5161fb88f20e2f1))

### Bug Fixes

* **otel:** use UCUM-compliant unit strings for all metric instruments ([46681d8](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/46681d816dbe34049ef9abccc35cc5b023d5fbdd))

## [0.2.0] — 2026-03-11

### Changed

* **BREAKING** — Package renamed to `@devtheops/opencode-plugin-otel`. Update your opencode config from `"opencode-plugin-otel"` to `"@devtheops/opencode-plugin-otel"`.

---

## [0.1.1] — 2026-03-11

### Fixed

* Release workflow now uses npm trusted publishing (OIDC) with Node 22.14.0 and creates a GitHub release with changelog notes and npm package link.

---

## [0.1.0] — 2026-03-11

### Added

* **Release workflow** — `.github/workflows/release.yml` publishes to npm automatically when a `v*` tag is pushed, gated by typecheck and tests.
* **`OPENCODE_OTLP_HEADERS`** — new env var for comma-separated `key=value` OTLP auth headers (e.g. `x-honeycomb-team=abc,x-tenant=org`). Copied to `OTEL_EXPORTER_OTLP_HEADERS` before the SDK initialises.
* **`OPENCODE_RESOURCE_ATTRIBUTES`** — new env var for comma-separated `key=value` OTel resource attributes (e.g. `service.version=1.2.3,deployment.environment=production`). Copied to `OTEL_RESOURCE_ATTRIBUTES` before the SDK initialises.
* JSDoc on all exported functions, types, and constants.
* Regression tests covering `OTEL_*` passthrough behaviour — pre-existing values are preserved when `OPENCODE_*` vars are unset; `OPENCODE_*` vars overwrite when set.
* README table of contents, usage examples for headers and resource attributes, and a security note advising that `OPENCODE_OTLP_HEADERS` may contain sensitive tokens and should not be committed to version control.

### Changed

* `package.json` `main`/`module` now point directly at `src/index.ts`; root `index.ts` re-export removed.
* `files` field added to `package.json` — published package contains only `src/`, reducing install size.
* All user-facing env vars are now consistently `OPENCODE_`-prefixed. `loadConfig` copies `OPENCODE_OTLP_HEADERS` → `OTEL_EXPORTER_OTLP_HEADERS` and `OPENCODE_RESOURCE_ATTRIBUTES` → `OTEL_RESOURCE_ATTRIBUTES` so the OTel SDK picks them up natively.
* `parseEnvInt` now rejects partial numeric strings such as `"1.5"` or `"5000ms"`, returning the fallback instead of silently truncating.

### Removed

* `parseHeaders` removed from `src/otel.ts` — the OTel SDK reads `OTEL_EXPORTER_OTLP_HEADERS` natively once `loadConfig` copies the value across.
* Manual `release:patch` / `release:minor` / `release:major` npm scripts removed in favour of the tag-based CI workflow.

# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.1](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v1.3.0...v1.3.1) (2026-07-16)


### Bug Fixes

* **ci:** use compatible Node version for npm publish ([b01abdf](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/b01abdf5b6c4e1862ccd5ca6edc8cf552329f897))

## [1.3.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v1.2.2...v1.3.0) (2026-07-06)

### Features

* **config:** support plugin tuple options ([f8be232](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/f8be2328642beb50b093a52477e8621aa07f76ba))

## [1.2.2](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v1.2.1...v1.2.2) (2026-07-02)

### Bug Fixes

* flush telemetry for short-lived runs ([df37dd0](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/df37dd053b8386b95f1fba7a2042f4a83fce0539))

## [1.2.1](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v1.2.0...v1.2.1) (2026-06-25)

### Bug Fixes

* **tracing:** key runs by user message id ([0e43ecc](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/0e43ecc54d79916db50bd119d76efe8d61fad433))
* **tracing:** scope root spans to runs ([8e8e5ca](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/8e8e5ca78dac39da32016c1fe3eb8fac59625634))

## [1.2.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v1.1.0...v1.2.0) (2026-06-20)

### Features

* **config:** support OPENCODE_SPAN_ATTRIBUTES ([93866c5](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/93866c5b09788f3a3f1b9162be0ed028196c4e83))
* **handlers:** add agent metadata to logs and spans ([c2759e9](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/c2759e97401f1460ab8143cb04f2d0fb2fb05e29))

### Bug Fixes

* **config:** preserve canonical project.id ([0d02eac](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/0d02eac390e307fd71cc270c63711f026815667b))

## [1.1.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v1.0.0...v1.1.0) (2026-06-04)

### Features

* **trace:** support remote W3C parent context ([1da0a85](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/1da0a857e9303a8f7020f20627d01fecb95cfad0))
* **trace:** support remote W3C parent context ([83e3d42](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/83e3d4211400eb49520c7b58bcaeff262763e799))

### Bug Fixes

* added protobuf exporters from [@opentelemetry](https://github.com/opentelemetry) ([19e600f](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/19e600f31c3e70cf21d6ec5c145aad67edbd022f))
* **probe:** reject scheme-less endpoint URLs ([df7a62b](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/df7a62b3cd801f753d4a03342fc178fb4aac2874))

## [1.0.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.9.0...v1.0.0) (2026-05-18)

### ⚠ BREAKING CHANGES

* **handlers:** opencode.lines_of_code.count semantics have changed. Dashboards that sum() the counter previously saw inflated numbers; they will now see the correct net session totals. Existing queries do not need to change, but the numeric results will be smaller (and correct).

### Features

* **otel:** prewarm dynamic OTLP headers helper ([6f62b8b](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/6f62b8bc03382c2d451d0538d72dffb44757b16c))

### Bug Fixes

* **handlers:** address code-review feedback on lines_of_code semantics ([a25022c](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/a25022c17cb912dedfe0dcd3b092db7bbee97e85))
* **handlers:** address maintainer feedback on lines_of_code semantics ([7f0802a](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/7f0802a914ae7bcfe39d0b31310a4809b7427b44))
* **handlers:** emit lines_of_code.count as session delta, add .total gauge ([9eaefc7](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/9eaefc7eaab3c5bdfdc2b66ae5056fc89025b249))

## [0.9.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.8.0...v0.9.0) (2026-05-01)

### Features

* **otel:** refresh dynamic headers on auth failure ([b65dd2e](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/b65dd2e157a6e87b77f2641df63407256f300f82))

### Bug Fixes

* bundle plugin to JS for server mode compatibility ([37a86e8](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/37a86e8188c09162129bcc22e3a4254ab5aacb33)), closes [#35](https://github.com/DEVtheOPS/opencode-plugin-otel/issues/35)
* emit TypeScript declarations alongside bundled JS ([ce22030](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/ce22030d975777d43a21d4e15de2c29091c15d7d))
* **otel:** harden dynamic header helper ([2810d31](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/2810d31acf148735c1faef8130e571766ebeaab5))
* use prepack instead of prepublishOnly ([bd7a4f9](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/bd7a4f9b57a6016113e14713e60c666f5bab95d3))

## [0.8.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.7.0...v0.8.0) (2026-04-21)

### Features

* **traces:** align spans with OpenInference semantics ([ce6ca28](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/ce6ca28100ab65eb6e28ce8842c5d0f641e6bd59))

## [0.7.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.6.0...v0.7.0) (2026-04-13)

### Features

* **otel:** add OTLP HTTP exporter support ([d679862](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/d679862a88df831685e142fb0cb40db16225d5c8))

### Bug Fixes

* Add oc-plugin key to package.json ([9975938](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/997593887d055715a1429bd9b0d3d30c23516111))
* Added oc-plugin key to package.json ([db66f87](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/db66f87d6a08fd0ee0b6d11e362ca6e4c60c3e5a))

## [Unreleased]

### Features

* **otel:** add OTLP HTTP/protobuf exporter support via `OPENCODE_OTLP_PROTOCOL`

## [0.6.0](https://github.com/DEVtheOPS/opencode-plugin-otel/compare/v0.5.0...v0.6.0) (2026-03-26)

### Features

* **config:** add OPENCODE_DISABLE_TRACES for per-type trace suppression ([89cb9b9](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/89cb9b9b9b1f79559f3930a2017ca16f513785b3))
* **tracing:** add OpenTelemetry traces with gen_ai.* and tool spans ([0a00b43](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/0a00b43c714c45146ac93b9077c478127727e6ce))
* **tracing:** add OpenTelemetry traces with gen_ai.* and tool spans ([6c848a7](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/6c848a7bca237ab60e7035244d4889dae44560ca)), closes [#19](https://github.com/DEVtheOPS/opencode-plugin-otel/issues/19)

### Bug Fixes

* **traces:** apply metricPrefix to opencode span names and fix out-of-order parentage ([65f1e70](https://github.com/DEVtheOPS/opencode-plugin-otel/commit/65f1e70ec592a571dd5fd410769920cc5c6e1142))

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

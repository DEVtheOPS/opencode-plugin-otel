import { describe, test, expect, afterEach } from "bun:test"
import { buildResource } from "../src/otel.ts"

describe("buildResource", () => {
  const originalEnv = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    } else {
      process.env["OTEL_RESOURCE_ATTRIBUTES"] = originalEnv
    }
  })

  test("includes service.name, app.version, os.type, host.arch", () => {
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    const resource = buildResource("1.2.3")
    const attrs = resource.attributes
    expect(attrs["service.name"]).toBe("opencode")
    expect(attrs["app.version"]).toBe("1.2.3")
    expect(attrs["os.type"]).toBe(process.platform)
    expect(attrs["host.arch"]).toBe(process.arch)
  })

  test("merges OTEL_RESOURCE_ATTRIBUTES from env", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    const resource = buildResource("0.0.1")
    const attrs = resource.attributes
    expect(attrs["team"]).toBe("platform")
    expect(attrs["env"]).toBe("prod")
  })

  test("trims whitespace in resource attributes", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = " team = platform "
    const resource = buildResource("0.0.1")
    expect(resource.attributes["team"]).toBe("platform")
  })

  test("env resource attributes override defaults", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=my-override"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["service.name"]).toBe("my-override")
  })

  test("includes enduser.id when endUserId is provided", () => {
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    const resource = buildResource("0.0.1", "alice")
    expect(resource.attributes["enduser.id"]).toBe("alice")
  })

  test("omits enduser.id when endUserId is undefined", () => {
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    const resource = buildResource("0.0.1")
    expect(resource.attributes["enduser.id"]).toBeUndefined()
  })

  test("OTEL_RESOURCE_ATTRIBUTES enduser.id overrides endUserId argument", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "enduser.id=override"
    const resource = buildResource("0.0.1", "alice")
    expect(resource.attributes["enduser.id"]).toBe("override")
  })
})

import type { Json, Payload } from "./fixtures.ts"

export function objects(value: Json | undefined): Payload[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Payload => typeof item === "object" && item !== null && !Array.isArray(item))
}

export function attributes(record: Payload): Record<string, Json> {
  return Object.fromEntries(objects(record["attributes"]).map(attribute => {
    const value = attribute["value"] as Payload
    return [String(attribute["key"]), value["stringValue"] ?? value["boolValue"] ?? value["intValue"] ?? value["doubleValue"] ?? null]
  }))
}

export function signalRecords(payloads: Payload[], signal: "Spans" | "Metrics" | "Logs"): Payload[] {
  const records = signal === "Spans" ? "spans" : signal === "Metrics" ? "metrics" : "logRecords"
  return payloads.flatMap(payload => objects(payload[`resource${signal}`])
    .flatMap(resource => objects(resource[`scope${signal}`]).flatMap(scope => objects(scope[records]))))
}

export function metricPoints(metrics: Payload[], name: string, kind: "sum" | "histogram"): Payload[] {
  return metrics.filter(metric => metric["name"] === name)
    .flatMap(metric => objects((metric[kind] as Payload | undefined)?.["dataPoints"]))
}

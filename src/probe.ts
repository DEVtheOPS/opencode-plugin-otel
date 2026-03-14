import * as net from "net"

/** Result of a TCP connectivity probe against the OTLP endpoint. */
export type ProbeResult = { ok: boolean; ms: number; error?: string }

/**
 * Opens a TCP connection to the host and port parsed from `endpoint` to verify
 * reachability before the OTel SDK initialises. Resolves within 5 seconds.
 */
export function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  try {
    const url = new URL(endpoint)
    const defaultPort = url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : 4317
    return { host: url.hostname, port: url.port ? parseInt(url.port, 10) : defaultPort }
  } catch {
    return null
  }
}

export function probeEndpoint(endpoint: string): Promise<ProbeResult> {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) {
    return Promise.resolve({ ok: false, ms: 0, error: `invalid endpoint URL: ${endpoint}` })
  }
  const { host, port } = parsed
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy()
      resolve({ ok: true, ms: Date.now() - start })
    })
    socket.setTimeout(5000)
    socket.on("timeout", () => {
      socket.destroy()
      resolve({ ok: false, ms: Date.now() - start, error: "timed out after 5s" })
    })
    socket.on("error", (err) => {
      resolve({ ok: false, ms: Date.now() - start, error: err.message })
    })
  })
}

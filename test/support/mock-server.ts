import * as http from "http";
import type { AddressInfo } from "net";

export interface MockResponse {
  status: number;
  body?: unknown; // JSON-serialized unless already a string
  headers?: Record<string, string>;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/**
 * A tiny local HTTP server that replies from a queue of canned responses, in
 * request order (the last response repeats once the queue is exhausted).
 * Mirrors the real-local-server pattern already used in http-live.test.ts,
 * rather than adding a mocking library as a new dependency.
 */
export function startMockServer(responses: MockResponse[]): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let i = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method || "", url: req.url || "", headers: req.headers, body });

      const route = responses[Math.min(i, responses.length - 1)];
      i++;
      const payload =
        typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {});
      res.writeHead(route.status, { "content-type": "application/json", ...route.headers });
      res.end(payload);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import { initLog } from "../src/util/log";
import { startMockServer } from "./support/mock-server";
import { createHttpClient, pickCode, resetHttpPlanLog } from "../src/util/http-client";

/**
 * Integration tests for the axios wrapper: real local HTTP servers (success,
 * HTTP-level errors, connection-refused) exercise the request/response
 * interceptors end-to-end, the same pattern http-live.test.ts uses for
 * ../src/util/http. `pickCode` is also tested directly since it's exported
 * and its cause-vs-direct-code branches are awkward to trigger through a real
 * network error.
 *
 * Every test that starts a mock server closes it in a `finally` — leaving a
 * server open (e.g. because an assertion above it throws) keeps the event
 * loop alive and hangs the entire `node --test` run for every file, not just
 * this one.
 */

interface CapturedChannel {
  lines: string[];
}

function withCapturedLog(): { channel: CapturedChannel } {
  const ctx = createMockContext();
  let channel: CapturedChannel = { lines: [] };
  (vscode.window as unknown as { createOutputChannel: (name: string) => unknown }).createOutputChannel = () => {
    const c = {
      lines: [] as string[],
      appendLine(s: string) {
        this.lines.push(s);
      },
      show() {},
    };
    channel = c;
    return c;
  };
  initLog(ctx);
  return { channel };
}

beforeEach(() => {
  (vscode as unknown as { __resetVscodeMock: () => void }).__resetVscodeMock();
  resetHttpPlanLog();
});

// ---- happy path --------------------------------------------------------------

test("createHttpClient: successful request logs the outgoing request and the response", async () => {
  const server = await startMockServer([{ status: 200, body: { ok: true } }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Test", baseUrl: server.url, timeoutMs: 5000, headers: {} });

    const res = await client.get("/x");

    assert.equal(res.status, 200);
    assert.ok(channel.lines.some((l) => /Test → GET .*\/x/.test(l)));
    assert.ok(channel.lines.some((l) => /Test ← 200 .*\/x \(\d+ms\)/.test(l)));
  } finally {
    await server.close();
  }
});

test("createHttpClient: an empty request URL falls back to the base URL", async () => {
  const server = await startMockServer([{ status: 200, body: {} }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Base", baseUrl: server.url, timeoutMs: 5000, headers: {} });

    const res = await client.get("");

    assert.equal(res.status, 200);
    assert.ok(channel.lines.some((l) => l.includes(`Base → GET ${server.url}`)));
  } finally {
    await server.close();
  }
});

test("createHttpClient: an absolute request URL is logged as-is, ignoring the base URL", async () => {
  const server = await startMockServer([{ status: 200, body: {} }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Abs", baseUrl: "https://unused.example.invalid", timeoutMs: 5000, headers: {} });

    const res = await client.get(`${server.url}/abs`);

    assert.equal(res.status, 200);
    assert.ok(channel.lines.some((l) => l.includes(`Abs → GET ${server.url}/abs`)));
  } finally {
    await server.close();
  }
});

test("createHttpClient: a trailing slash on the base URL doesn't produce a double slash", async () => {
  const server = await startMockServer([{ status: 200, body: {} }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Slash", baseUrl: `${server.url}/`, timeoutMs: 5000, headers: {} });

    const res = await client.get("/y");

    assert.equal(res.status, 200);
    assert.ok(channel.lines.some((l) => l.includes(`Slash → GET ${server.url}/y`)));
  } finally {
    await server.close();
  }
});

// ---- HTTP-level errors (err.response present) ---------------------------------

test("createHttpClient: an HTTP error response logs status, headers, and a JSON body snippet", async () => {
  const server = await startMockServer([
    { status: 500, body: { error: "boom" }, headers: { server: "nginx", via: "1.1 proxy" } },
  ]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Err", baseUrl: server.url, timeoutMs: 5000, headers: {} });

    await assert.rejects(() => client.get("/x"));

    assert.ok(channel.lines.some((l) => /Err ✕ .*HTTP 500/.test(l)));
    assert.ok(channel.lines.some((l) => /server=nginx via=1\.1 proxy content-type=application\/json/.test(l)));
    assert.ok(channel.lines.some((l) => /response body: \{"error":"boom"\}/.test(l)));
  } finally {
    await server.close();
  }
});

test("createHttpClient: missing server/via headers and an empty body fall back to (none) and skip the body line", async () => {
  const server = await startMockServer([{ status: 404, body: "" }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "None", baseUrl: server.url, timeoutMs: 5000, headers: {} });

    await assert.rejects(() => client.get("/missing"));

    assert.ok(channel.lines.some((l) => /server=\(none\) via=\(none\)/.test(l)));
    assert.ok(!channel.lines.some((l) => /response body:/.test(l)));
  } finally {
    await server.close();
  }
});

test("createHttpClient: a long text response body is truncated with an ellipsis", async () => {
  const longText = "x".repeat(400);
  const server = await startMockServer([{ status: 400, body: longText }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Long", baseUrl: server.url, timeoutMs: 5000, headers: {} });

    await assert.rejects(() => client.get("/big"));

    const bodyLine = channel.lines.find((l) => /response body:/.test(l));
    assert.ok(bodyLine);
    assert.ok(bodyLine!.endsWith("…"));
    assert.equal(bodyLine!.match(/x+/)?.[0].length, 300);
  } finally {
    await server.close();
  }
});

test("createHttpClient: an HTTP error with no matching network code omits the hint line", async () => {
  const server = await startMockServer([{ status: 404, body: {} }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "NoHint", baseUrl: server.url, timeoutMs: 5000, headers: {} });

    await assert.rejects(() => client.get("/x"));

    assert.ok(!channel.lines.some((l) => /hint:/.test(l)));
  } finally {
    await server.close();
  }
});

// ---- network-level errors (no err.response) ------------------------------------

test("createHttpClient: connection-refused logs the code and a hint, with no response section", async () => {
  const { channel } = withCapturedLog();
  const client = createHttpClient({ label: "Refused", baseUrl: "http://127.0.0.1:1", timeoutMs: 3000, headers: {} });

  await assert.rejects(() => client.get("/"));

  assert.ok(channel.lines.some((l) => /Refused ✕ .*code=ECONNREFUSED/.test(l)));
  assert.ok(channel.lines.some((l) => /hint: Connection refused/.test(l)));
  assert.ok(!channel.lines.some((l) => /response headers:/.test(l)));
});

test("createHttpClient: a cancelled request logs a cancellation notice, not an error", async () => {
  const server = await startMockServer([{ status: 200, body: {} }]);
  try {
    const { channel } = withCapturedLog();
    const client = createHttpClient({ label: "Cancel", baseUrl: server.url, timeoutMs: 5000, headers: {} });
    const controller = new AbortController();

    const promise = client.get("/", { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => promise);

    assert.ok(channel.lines.some((l) => l.endsWith("Cancel ✕ request cancelled")));
  } finally {
    await server.close();
  }
});

// ---- network plan logging (logPlanOnce / resetHttpPlanLog) ---------------------

test("createHttpClient: logs the network plan once per label+baseUrl, and again after a reset", () => {
  const { channel } = withCapturedLog();

  createHttpClient({ label: "Dup", baseUrl: "https://example.invalid", timeoutMs: 1000, headers: {} });
  createHttpClient({ label: "Dup", baseUrl: "https://example.invalid", timeoutMs: 1000, headers: {} });
  assert.equal(channel.lines.filter((l) => /Dup network:/.test(l)).length, 1);

  resetHttpPlanLog();
  createHttpClient({ label: "Dup", baseUrl: "https://example.invalid", timeoutMs: 1000, headers: {} });
  assert.equal(channel.lines.filter((l) => /Dup network:/.test(l)).length, 2);
});

test("createHttpClient: logs CA-loading problems and the insecure-TLS warning", () => {
  const { channel } = withCapturedLog();

  createHttpClient({
    label: "Insecure",
    baseUrl: "https://example.invalid",
    timeoutMs: 1000,
    headers: {},
    http: { extraCaCerts: ["/definitely/not/a/real/ca.pem"], allowInsecureTls: true },
  });

  assert.ok(channel.lines.some((l) => /Insecure CA: couldn't read CA file/.test(l)));
  assert.ok(channel.lines.some((l) => /Insecure: TLS verification is disabled/.test(l)));
});

// ---- pickCode -------------------------------------------------------------------

test("pickCode: uses the direct axios code when there's no cause", () => {
  assert.equal(pickCode({ code: "ECONNREFUSED" } as never), "ECONNREFUSED");
});

test("pickCode: falls back to the TLS/socket cause code when there's no direct code", () => {
  assert.equal(pickCode({ cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } } as never), "SELF_SIGNED_CERT_IN_CHAIN");
});

test("pickCode: a specific cause code wins over a generic ERR_BAD_REQUEST/ERR_BAD_RESPONSE", () => {
  assert.equal(pickCode({ code: "ERR_BAD_REQUEST", cause: { code: "EPROTO" } } as never), "EPROTO");
  assert.equal(pickCode({ code: "ERR_BAD_RESPONSE", cause: { code: "EPROTO" } } as never), "EPROTO");
});

test("pickCode: an unrelated direct code wins over an incidental cause", () => {
  assert.equal(pickCode({ code: "ECONNRESET", cause: { code: "EPROTO" } } as never), "ECONNRESET");
});

test("pickCode: neither a code nor a cause -> undefined", () => {
  assert.equal(pickCode({} as never), undefined);
});

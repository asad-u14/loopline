import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import axios from "axios";
import { buildHttpConfig } from "../src/util/http";

/**
 * Live network tests against a real CONNECT proxy and a self-signed HTTPS origin.
 * This reproduces the corporate setup that broke on Windows: an internal host
 * behind a proxy, serving a certificate signed by a private CA.
 */

let dir: string;
let caPath: string;
let proxy: http.Server;
let origin: https.Server;
let baseUrl: string;
let proxyUrl: string;
let connectCount = 0;

before(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-tls-")));
  caPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${caPath}" -days 2 -nodes ` +
      `-subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"`,
    { stdio: "ignore" }
  );

  // Minimal HTTP CONNECT proxy.
  proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    connectCount++;
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.end());
  });

  origin = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(caPath) },
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  );

  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  baseUrl = `https://localhost:${(origin.address() as net.AddressInfo).port}`;
});

after(() => {
  proxy?.close();
  origin?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function get(opts: Parameters<typeof buildHttpConfig>[1], env: Parameters<typeof buildHttpConfig>[2]) {
  const { config } = buildHttpConfig(baseUrl, opts, env);
  return axios.create({ baseURL: baseUrl, timeout: 8000, ...config }).get("/");
}

test("untrusted self-signed origin fails (the symptom users report)", async () => {
  await assert.rejects(
    () => get({}, {}),
    (err: { code?: string; cause?: { code?: string } }) => {
      const code = err.code ?? err.cause?.code;
      assert.match(String(code), /SELF_SIGNED|UNABLE_TO_VERIFY/);
      return true;
    }
  );
});

test("extraCaCerts makes the private CA trusted", async () => {
  const res = await get({ extraCaCerts: [caPath] }, {});
  assert.equal(res.status, 200);
});

test("NODE_EXTRA_CA_CERTS is honored", async () => {
  const res = await get({}, { NODE_EXTRA_CA_CERTS: caPath });
  assert.equal(res.status, 200);
});

test("allowInsecureTls bypasses verification (escape hatch)", async () => {
  const res = await get({ allowInsecureTls: true }, {});
  assert.equal(res.status, 200);
});

/**
 * Regression test for a real bug: https-proxy-agent v7 resets `this.options` in
 * its constructor, so TLS options only reached the proxy hop and the destination
 * handshake failed. proxy + private CA is THE common corporate setup.
 */
test("proxy + private CA works together (regression)", async () => {
  const before = connectCount;
  const res = await get({ proxy: proxyUrl, extraCaCerts: [caPath] }, {});
  assert.equal(res.status, 200);
  assert.ok(connectCount > before, "request should have tunnelled through the proxy");
});

test("HTTPS_PROXY env + private CA works together", async () => {
  const before = connectCount;
  const res = await get({ extraCaCerts: [caPath] }, { HTTPS_PROXY: proxyUrl });
  assert.equal(res.status, 200);
  assert.ok(connectCount > before, "request should have tunnelled through the proxy");
});

test("NO_PROXY bypasses the proxy entirely", async () => {
  const before = connectCount;
  const res = await get({ extraCaCerts: [caPath] }, { HTTPS_PROXY: proxyUrl, NO_PROXY: "localhost" });
  assert.equal(res.status, 200);
  assert.equal(connectCount, before, "request should NOT have gone through the proxy");
});

test("proxy without the CA still fails (proxy doesn't mask TLS problems)", async () => {
  await assert.rejects(() => get({ proxy: proxyUrl }, {}));
});

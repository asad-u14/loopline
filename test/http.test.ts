import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  matchesNoProxy,
  resolveProxy,
  loadCaCerts,
  redactProxy,
  explainNetworkCode,
  buildHttpConfig,
} from "../src/util/http";

// ---- NO_PROXY ---------------------------------------------------------------

test("matchesNoProxy: exact host", () => {
  assert.equal(matchesNoProxy("jira.corp.com", "jira.corp.com"), true);
});

test("matchesNoProxy: suffix and leading-dot forms", () => {
  assert.equal(matchesNoProxy("jira.corp.com", ".corp.com"), true);
  assert.equal(matchesNoProxy("jira.corp.com", "corp.com"), true);
});

test("matchesNoProxy: wildcard", () => {
  assert.equal(matchesNoProxy("anything.com", "*"), true);
});

test("matchesNoProxy: non-match and empty", () => {
  assert.equal(matchesNoProxy("jira.other.com", ".corp.com"), false);
  assert.equal(matchesNoProxy("jira.corp.com", undefined), false);
  assert.equal(matchesNoProxy("jira.corp.com", ""), false);
});

test("matchesNoProxy: entry with port, and case-insensitivity", () => {
  assert.equal(matchesNoProxy("JIRA.corp.com", "corp.com:8080"), true);
});

test("matchesNoProxy: does not match a lookalike suffix", () => {
  // "evilcorp.com" must not match a "corp.com" rule
  assert.equal(matchesNoProxy("evilcorp.com", "corp.com"), false);
});

// ---- proxy resolution -------------------------------------------------------

test("resolveProxy: explicit config wins over env", () => {
  const proxy = resolveProxy(
    "https://jira.corp.com",
    { proxy: "http://explicit:8080" },
    { HTTPS_PROXY: "http://from-env:3128" }
  );
  assert.equal(proxy, "http://explicit:8080");
});

test("resolveProxy: uses HTTPS_PROXY for https targets", () => {
  assert.equal(
    resolveProxy("https://jira.corp.com", {}, { HTTPS_PROXY: "http://p:3128" }),
    "http://p:3128"
  );
});

test("resolveProxy: falls back to HTTP_PROXY for https when no HTTPS_PROXY", () => {
  assert.equal(
    resolveProxy("https://jira.corp.com", {}, { HTTP_PROXY: "http://p:3128" }),
    "http://p:3128"
  );
});

test("resolveProxy: lowercase env vars are honored", () => {
  assert.equal(
    resolveProxy("https://jira.corp.com", {}, { https_proxy: "http://p:3128" }),
    "http://p:3128"
  );
});

test("resolveProxy: NO_PROXY exempts the host, even with explicit config", () => {
  assert.equal(
    resolveProxy(
      "https://jira.corp.com",
      { proxy: "http://explicit:8080" },
      { NO_PROXY: ".corp.com" }
    ),
    undefined
  );
});

test("resolveProxy: none configured -> undefined (direct)", () => {
  assert.equal(resolveProxy("https://jira.corp.com", {}, {}), undefined);
});

test("resolveProxy: invalid URL -> undefined", () => {
  assert.equal(resolveProxy("not a url", {}, { HTTPS_PROXY: "http://p:3128" }), undefined);
});

// ---- CA certs ---------------------------------------------------------------

test("loadCaCerts: reads existing files and reports missing ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopline-ca-"));
  const good = path.join(dir, "root.pem");
  fs.writeFileSync(good, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
  const missing = path.join(dir, "nope.pem");

  const res = loadCaCerts([good, missing], {});
  assert.equal(res.certs.length, 1);
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /nope\.pem/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadCaCerts: empty/undefined input is safe", () => {
  assert.equal(loadCaCerts(undefined, {}).certs.length, 0);
  assert.equal(loadCaCerts([], {}).problems.length, 0);
});

test("loadCaCerts: honors NODE_EXTRA_CA_CERTS from env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopline-ca-env-"));
  const rootCa = path.join(dir, "corp-root.pem");
  fs.writeFileSync(rootCa, "-----BEGIN CERTIFICATE-----\nxyz\n-----END CERTIFICATE-----\n");

  const res = loadCaCerts([], { NODE_EXTRA_CA_CERTS: rootCa });
  assert.equal(res.certs.length, 1);
  assert.equal(res.problems.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadCaCerts: NODE_EXTRA_CA_CERTS isn't double-counted when also listed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopline-ca-dup-"));
  const rootCa = path.join(dir, "corp-root.pem");
  fs.writeFileSync(rootCa, "cert");

  const res = loadCaCerts([rootCa], { NODE_EXTRA_CA_CERTS: rootCa });
  assert.equal(res.certs.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadCaCerts: unreadable NODE_EXTRA_CA_CERTS is reported, not thrown", () => {
  const res = loadCaCerts([], { NODE_EXTRA_CA_CERTS: "/definitely/not/here.pem" });
  assert.equal(res.certs.length, 0);
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /NODE_EXTRA_CA_CERTS/);
});

// ---- redaction --------------------------------------------------------------

test("redactProxy: strips credentials", () => {
  const out = redactProxy("http://user:secret@proxy.corp.com:8080");
  assert.doesNotMatch(out, /secret/);
  assert.match(out, /proxy\.corp\.com:8080/);
});

test("redactProxy: leaves credential-free URLs readable", () => {
  assert.match(redactProxy("http://proxy.corp.com:8080"), /proxy\.corp\.com:8080/);
});

// ---- error explanation ------------------------------------------------------

test("explainNetworkCode: TLS trust errors mention the CA setting", () => {
  const msg = explainNetworkCode("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  assert.ok(msg);
  assert.match(msg!, /extraCaCerts|NODE_EXTRA_CA_CERTS/);
});

test("explainNetworkCode: self-signed chain is explained", () => {
  assert.ok(explainNetworkCode("SELF_SIGNED_CERT_IN_CHAIN"));
});

test("explainNetworkCode: DNS failure mentions VPN", () => {
  assert.match(explainNetworkCode("ENOTFOUND")!, /VPN|resolve/i);
});

test("explainNetworkCode: timeout mentions proxy", () => {
  assert.match(explainNetworkCode("ETIMEDOUT")!, /proxy/i);
});

test("explainNetworkCode: unknown code -> undefined", () => {
  assert.equal(explainNetworkCode("SOMETHING_ELSE"), undefined);
  assert.equal(explainNetworkCode(undefined), undefined);
});

// ---- config assembly --------------------------------------------------------

test("buildHttpConfig: no proxy/CA -> no agent (default axios behavior preserved)", () => {
  const { config, plan } = buildHttpConfig("https://jira.corp.com", {}, {});
  assert.equal(config.httpsAgent, undefined);
  assert.equal(config.proxy, undefined);
  assert.equal(plan.proxy, undefined);
  assert.equal(plan.caCount, 0);
});

test("buildHttpConfig: proxy -> agent set and axios' own proxy disabled", () => {
  const { config, plan } = buildHttpConfig(
    "https://jira.corp.com",
    {},
    { HTTPS_PROXY: "http://p:3128" }
  );
  assert.ok(config.httpsAgent);
  assert.equal(config.proxy, false);
  assert.equal(plan.proxy, "http://p:3128");
});

test("buildHttpConfig: insecure flag is reflected in the plan", () => {
  const { config, plan } = buildHttpConfig("https://jira.corp.com", { allowInsecureTls: true }, {});
  assert.ok(config.httpsAgent);
  assert.equal(plan.insecure, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCaCerts, redactProxy, describePlan, explainNetworkCode } from "../src/util/http";

// Gaps left by test/http.test.ts: loadCaCerts' blank-entry skip, describePlan
// (not imported there at all), redactProxy's unparsable-URL fallback, and the
// explainNetworkCode cases beyond TLS trust/DNS/timeout.

test("loadCaCerts: blank/whitespace-only entries in the paths array are skipped, not treated as missing files", () => {
  const res = loadCaCerts(["", "   "], {});
  assert.equal(res.certs.length, 0);
  assert.equal(res.problems.length, 0);
});

test("describePlan: no proxy, no CAs, TLS verification on", () => {
  const summary = describePlan({ proxy: undefined, caCount: 0, caProblems: [], insecure: false });
  assert.equal(summary, "proxy=none extraCAs=0");
});

test("describePlan: proxy present is redacted, CA count included", () => {
  const summary = describePlan({
    proxy: "http://user:secret@proxy.corp.com:8080",
    caCount: 2,
    caProblems: [],
    insecure: false,
  });
  assert.doesNotMatch(summary, /secret/);
  assert.match(summary, /proxy=http:\/\/(\*\*\*@)?proxy\.corp\.com:8080/);
  assert.match(summary, /extraCAs=2/);
});

test("describePlan: insecure flag appends a warning", () => {
  const summary = describePlan({ proxy: undefined, caCount: 0, caProblems: [], insecure: true });
  assert.match(summary, /TLS verification DISABLED/);
});

test("redactProxy: an unparsable URL is returned unchanged rather than throwing", () => {
  assert.equal(redactProxy("not a url"), "not a url");
});

test("explainNetworkCode: connection refused mentions firewall/VPN", () => {
  assert.match(explainNetworkCode("ECONNREFUSED")!, /refused/i);
});

test("explainNetworkCode: connection reset mentions a proxy or TLS-inspecting firewall", () => {
  assert.match(explainNetworkCode("ECONNRESET")!, /reset/i);
});

test("explainNetworkCode: EPROTO mentions an intercepting proxy", () => {
  assert.match(explainNetworkCode("EPROTO")!, /TLS protocol error/i);
});

test("explainNetworkCode: an expired certificate is explained", () => {
  assert.match(explainNetworkCode("CERT_HAS_EXPIRED")!, /expired/i);
});

test("explainNetworkCode: a hostname/cert mismatch is explained", () => {
  assert.match(explainNetworkCode("ERR_TLS_CERT_ALTNAME_INVALID")!, /hostname/i);
});

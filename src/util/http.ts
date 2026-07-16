import * as fs from "fs";
import * as https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { AxiosRequestConfig } from "axios";

/**
 * Shared networking concerns for every outbound call (Jira / GitLab / Anthropic).
 *
 * Two things bite self-hosted / corporate setups on Windows in particular:
 *  1. Node does NOT use the OS proxy, so the browser works while the extension
 *     silently can't reach an internal host. We honor HTTPS_PROXY/HTTP_PROXY
 *     (and a `loopline.http.proxy` override), including NO_PROXY.
 *  2. Corporate TLS interception / private CAs aren't in Node's trust store, so
 *     HTTPS fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE even though Windows
 *     trusts the cert. We allow extra CA files (and NODE_EXTRA_CA_CERTS).
 */

export interface HttpOptions {
  /** Explicit proxy URL; overrides environment. */
  proxy?: string;
  /** Extra CA certificate file paths (PEM). */
  extraCaCerts?: string[];
  /** Last resort for broken corporate TLS. Off by default and warned about. */
  allowInsecureTls?: boolean;
}

/** Environment shape we read, injectable so behavior is deterministic and testable. */
export interface ProxyEnv {
  HTTPS_PROXY?: string;
  https_proxy?: string;
  HTTP_PROXY?: string;
  http_proxy?: string;
  NO_PROXY?: string;
  no_proxy?: string;
  NODE_EXTRA_CA_CERTS?: string;
}

/**
 * Does `host` match a NO_PROXY list? Supports "*", exact hosts, and
 * leading-dot/suffix matching (".corp.com" or "corp.com" match "jira.corp.com").
 */
export function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) {
    return false;
  }
  const h = host.toLowerCase();
  return noProxy
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") {
        return true;
      }
      const bare = entry.replace(/^\./, "").replace(/:\d+$/, "");
      return h === bare || h.endsWith(`.${bare}`);
    });
}

/**
 * Decide which proxy (if any) to use for `targetUrl`.
 * Explicit config wins; then HTTPS_PROXY/HTTP_PROXY by target scheme; NO_PROXY exempts.
 */
export function resolveProxy(
  targetUrl: string,
  opts: HttpOptions,
  env: ProxyEnv = process.env as ProxyEnv
): string | undefined {
  let host: string;
  let isHttps: boolean;
  try {
    const u = new URL(targetUrl);
    host = u.hostname;
    isHttps = u.protocol === "https:";
  } catch {
    return undefined;
  }

  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (matchesNoProxy(host, noProxy)) {
    return undefined;
  }

  if (opts.proxy && opts.proxy.trim()) {
    return opts.proxy.trim();
  }

  const fromEnv = isHttps
    ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
    : env.HTTP_PROXY ?? env.http_proxy;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

/**
 * Read extra CA PEM files. Missing/unreadable files are reported, not thrown.
 * `env` is injected so this is deterministic (Node's own NODE_EXTRA_CA_CERTS is
 * honored for free, but tests can control it).
 */
export function loadCaCerts(
  paths: string[] | undefined,
  env: ProxyEnv = process.env as ProxyEnv
): {
  certs: Buffer[];
  problems: string[];
} {
  const certs: Buffer[] = [];
  const problems: string[] = [];
  for (const p of paths ?? []) {
    const trimmed = (p || "").trim();
    if (!trimmed) {
      continue;
    }
    try {
      certs.push(fs.readFileSync(trimmed));
    } catch (err) {
      problems.push(`couldn't read CA file "${trimmed}": ${(err as Error).message}`);
    }
  }
  // Node's own convention, honored for free.
  const nodeExtra = env.NODE_EXTRA_CA_CERTS;
  if (nodeExtra && !(paths ?? []).includes(nodeExtra)) {
    try {
      certs.push(fs.readFileSync(nodeExtra));
    } catch (err) {
      problems.push(`couldn't read NODE_EXTRA_CA_CERTS "${nodeExtra}": ${(err as Error).message}`);
    }
  }
  return { certs, problems };
}

/** Describes what networking we ended up using — for logs and diagnostics. */
export interface HttpPlan {
  proxy?: string;
  caCount: number;
  caProblems: string[];
  insecure: boolean;
}

/**
 * Build the axios config additions (agent/proxy) for a base URL, plus a plan
 * describing what was applied. Returns `{}` extras when nothing special is needed,
 * so default behavior is unchanged for people with no proxy/CA setup.
 */
export function buildHttpConfig(
  baseUrl: string,
  opts: HttpOptions,
  env: ProxyEnv = process.env as ProxyEnv
): { config: AxiosRequestConfig; plan: HttpPlan } {
  const proxyUrl = resolveProxy(baseUrl, opts, env);
  const { certs, problems } = loadCaCerts(opts.extraCaCerts, env);
  const insecure = !!opts.allowInsecureTls;

  const plan: HttpPlan = {
    proxy: proxyUrl,
    caCount: certs.length,
    caProblems: problems,
    insecure,
  };

  const agentOpts: https.AgentOptions = {};
  if (certs.length) {
    agentOpts.ca = certs;
  }
  if (insecure) {
    agentOpts.rejectUnauthorized = false;
  }

  const config: AxiosRequestConfig = {};
  if (proxyUrl) {
    // Let the agent handle CONNECT tunneling; axios' own `proxy` must be off.
    const agent = new HttpsProxyAgent(proxyUrl, agentOpts);
    // https-proxy-agent v7 resets `this.options = { path: undefined }` in its
    // constructor, so the TLS options we passed only reach the *proxy* hop
    // (connectOpts) and are lost for the destination handshake. Node's
    // http.Agent merges `this.options` into each request's connect options, so
    // re-applying them here is what makes a corporate CA work *through* a proxy
    // — the single most common corporate setup. Verified against a live
    // CONNECT proxy + self-signed origin.
    Object.assign(agent.options, agentOpts);
    config.httpsAgent = agent;
    config.proxy = false;
  } else if (certs.length || insecure) {
    config.httpsAgent = new https.Agent(agentOpts);
  }
  return { config, plan };
}

/** Human summary of the plan, for the Output channel. */
export function describePlan(plan: HttpPlan): string {
  const bits: string[] = [];
  bits.push(plan.proxy ? `proxy=${redactProxy(plan.proxy)}` : "proxy=none");
  bits.push(`extraCAs=${plan.caCount}`);
  if (plan.insecure) {
    bits.push("TLS verification DISABLED");
  }
  return bits.join(" ");
}

/** Never log proxy credentials. */
export function redactProxy(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return proxyUrl;
  }
}

/**
 * Map a low-level Node/TLS error code to actionable guidance. This is what turns
 * "couldn't connect" into "your corporate CA isn't trusted by Node".
 */
export function explainNetworkCode(code: string | undefined): string | undefined {
  switch (code) {
    case "ENOTFOUND":
      return "DNS lookup failed — the host couldn't be resolved. If this is an internal Jira/GitLab, check your VPN connection.";
    case "ECONNREFUSED":
      return "Connection refused — nothing accepted the connection on that host/port. Check the URL, VPN, or firewall.";
    case "ETIMEDOUT":
    case "ECONNABORTED":
      return "The connection timed out. A corporate proxy may be required (set `loopline.http.proxy` or HTTPS_PROXY), or the host is unreachable without VPN.";
    case "ECONNRESET":
      return "The connection was reset — often a proxy or TLS-inspecting firewall dropping the request.";
    case "EPROTO":
      return "TLS protocol error — often caused by an HTTPS-intercepting proxy.";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "TLS certificate not trusted by Node. Your network likely intercepts HTTPS, or the server uses a private/corporate CA. Point `loopline.http.extraCaCerts` at the corporate root CA (.pem/.crt), or set NODE_EXTRA_CA_CERTS. Note: Node does NOT use the Windows certificate store.";
    case "CERT_HAS_EXPIRED":
      return "The server's TLS certificate has expired (or this machine's clock is wrong).";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "The TLS certificate doesn't match the hostname — check the configured URL.";
    default:
      return undefined;
  }
}

import * as vscode from "vscode";
import * as dns from "dns";
import * as os from "os";
import {
  readConfig,
  getJiraToken,
  getGitLabToken,
  getAnthropicKey,
  httpOptionsFromConfig,
} from "../util/config";
import {
  resolveProxy,
  loadCaCerts,
  redactProxy,
  explainNetworkCode,
} from "../util/http";
import { buildJiraService, buildGitLabService, buildAnthropicService } from "../util/workspace";
import { log, showLog } from "../util/log";
import { pickCode } from "../util/http-client";
import { AxiosError } from "axios";

/**
 * One-click connectivity report. Writes everything to the Loopline output channel:
 * environment, effective proxy, CA setup, DNS resolution, and a live call to each
 * configured service with the raw failure code — so "it won't connect" becomes a
 * specific, fixable cause.
 */
export async function diagnoseConnectionCommand(ctx: vscode.ExtensionContext): Promise<void> {
  showLog();
  const cfg = readConfig();
  const http = httpOptionsFromConfig();

  line("");
  line("═══════════════════════════════════════════");
  line("  Loopline connection diagnostics");
  line("═══════════════════════════════════════════");

  // --- environment ---
  section("Environment");
  line(`  OS:          ${os.platform()} ${os.release()} (${os.arch()})`);
  line(`  Node:        ${process.version}`);
  line(`  VS Code:     ${vscode.version}`);

  // --- proxy environment ---
  section("Proxy environment");
  const env = process.env;
  reportEnv("HTTPS_PROXY", env.HTTPS_PROXY ?? env.https_proxy);
  reportEnv("HTTP_PROXY", env.HTTP_PROXY ?? env.http_proxy);
  reportEnv("NO_PROXY", env.NO_PROXY ?? env.no_proxy, false);
  reportEnv("NODE_EXTRA_CA_CERTS", env.NODE_EXTRA_CA_CERTS, false);
  line(
    `  loopline.http.proxy:            ${cfg.httpProxy ? redactProxy(cfg.httpProxy) : "(not set)"}`
  );
  line(
    `  loopline.http.extraCaCerts:     ${cfg.httpExtraCaCerts.length ? cfg.httpExtraCaCerts.join(", ") : "(none)"}`
  );
  line(`  loopline.http.allowInsecureTls: ${cfg.httpAllowInsecureTls}`);
  if (os.platform() === "win32") {
    line("  Note: Node does NOT use the Windows certificate store or system proxy.");
    line("        Corporate CAs must be given via loopline.http.extraCaCerts / NODE_EXTRA_CA_CERTS,");
    line("        and a proxy via loopline.http.proxy / HTTPS_PROXY.");
  }

  // --- CA certs ---
  section("Extra CA certificates");
  const { certs, problems } = loadCaCerts(cfg.httpExtraCaCerts);
  line(`  Loaded: ${certs.length}`);
  problems.forEach((p) => line(`  PROBLEM: ${p}`));

  // --- per-service checks ---
  const jiraToken = await getJiraToken(ctx);
  const gitlabToken = await getGitLabToken(ctx);
  const aiKey = await getAnthropicKey(ctx);

  await checkTarget("Jira", cfg.jiraBaseUrl, !!jiraToken, http);
  await checkTarget("GitLab", cfg.gitlabHost, !!gitlabToken, http);
  if (cfg.aiEnabled) {
    await checkTarget("Anthropic", cfg.aiBaseUrl, !!aiKey, http);
  }

  // --- live API calls ---
  section("Live API checks");
  await liveCheck("Jira", async () => {
    if (!cfg.jiraBaseUrl || !jiraToken) {
      return "skipped (not configured)";
    }
    const svc = await buildJiraService(ctx);
    if (!svc) {
      return "skipped (not configured)";
    }
    return `OK — authenticated as ${await svc.verify()}`;
  });

  await liveCheck("GitLab", async () => {
    if (!gitlabToken) {
      return "skipped (no token)";
    }
    const svc = await buildGitLabService(ctx);
    if (!svc) {
      return "skipped (not configured)";
    }
    return `OK — ${await svc.verify()}`;
  });

  if (cfg.aiEnabled) {
    await liveCheck("Anthropic", async () => {
      const svc = await buildAnthropicService(ctx);
      if (!svc) {
        return "skipped (not configured)";
      }
      await svc.verify();
      return "OK";
    });
  }

  section("Done");
  line("  If a check failed, the code=… value above identifies the cause.");
  line("  Copy this report when asking for help (tokens are never logged).");
  line("");

  vscode.window.showInformationMessage("Loopline: diagnostics written to the Loopline output channel.");
}

// ---- helpers ---------------------------------------------------------------

function line(s: string): void {
  log(s);
}

function section(title: string): void {
  line("");
  line(`── ${title} ${"─".repeat(Math.max(0, 40 - title.length))}`);
}

function reportEnv(name: string, value: string | undefined, redact = true): void {
  if (!value) {
    line(`  ${name.padEnd(30)} (not set)`);
    return;
  }
  line(`  ${name.padEnd(30)} ${redact ? redactProxy(value) : value}`);
}

/** DNS + effective-proxy report for one target host. */
async function checkTarget(
  label: string,
  baseUrl: string,
  hasCredential: boolean,
  http: ReturnType<typeof httpOptionsFromConfig>
): Promise<void> {
  section(`${label} target`);
  if (!baseUrl) {
    line("  URL: (not configured)");
    return;
  }
  line(`  URL:         ${baseUrl}`);
  line(`  Credential:  ${hasCredential ? "present" : "MISSING"}`);

  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    line("  PROBLEM: the configured URL isn't a valid URL.");
    return;
  }

  const proxy = resolveProxy(baseUrl, http);
  line(`  Proxy used:  ${proxy ? redactProxy(proxy) : "none (direct connection)"}`);

  // DNS
  try {
    const res = await dns.promises.lookup(host);
    line(`  DNS:         ${host} → ${res.address}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    line(`  DNS:         FAILED (${code}) — ${(err as Error).message}`);
    const hint = explainNetworkCode(code);
    if (hint) {
      line(`               hint: ${hint}`);
    }
    if (!proxy) {
      line("               If this host is internal, check your VPN, or set a proxy.");
    }
  }
}

/** Run a live call and report OK / the precise failure. */
async function liveCheck(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    const result = await fn();
    line(`  ${label.padEnd(10)} ${result}`);
  } catch (err) {
    const ax = err as AxiosError;
    const code = pickCode(ax);
    const status = ax.response?.status;
    const parts = [
      status ? `HTTP ${status}` : undefined,
      code ? `code=${code}` : undefined,
      (err as Error).message,
    ]
      .filter(Boolean)
      .join(" | ");
    line(`  ${label.padEnd(10)} FAILED — ${parts}`);
    const hint = explainNetworkCode(code);
    if (hint) {
      line(`             hint: ${hint}`);
    }
  }
}

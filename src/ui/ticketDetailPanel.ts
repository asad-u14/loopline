import * as vscode from "vscode";
import { readConfig } from "../util/config";
import { buildAiService, currentRepoQuiet } from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { mdToHtml, escapeHtml } from "../util/markdown";
import { topLevelEntries } from "../util/repo-layout";
import { logError } from "../util/log";

export interface TicketDetail {
  key: string;
  summary: string;
  issueType: string;
  status?: string;
  description: string;
  jiraBaseUrl: string;
}

// A single reused panel — opening another ticket updates it instead of stacking tabs.
let panel: vscode.WebviewPanel | undefined;
let current: TicketDetail | undefined;

export function showTicketDetail(ctx: vscode.ExtensionContext, detail: TicketDetail): void {
  current = detail;
  const cfg = readConfig();

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "looplineTicket",
      `${detail.key}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      panel = undefined;
      current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => handleMessage(ctx, msg));
  }

  panel.title = detail.key;
  panel.webview.html = renderHtml(detail, { aiEnabled: cfg.aiEnabled });
  panel.reveal(vscode.ViewColumn.Beside, false);
}

async function handleMessage(ctx: vscode.ExtensionContext, msg: any): Promise<void> {
  if (!current) {
    return;
  }
  switch (msg?.type) {
    case "openJira":
      if (current.jiraBaseUrl) {
        vscode.env.openExternal(
          vscode.Uri.parse(`${current.jiraBaseUrl}/browse/${current.key}`)
        );
      }
      return;
    case "createBranch":
      await vscode.commands.executeCommand("loopline.tickets.createBranch", current.key);
      return;
    case "generate":
      await generatePlan(ctx);
      return;
  }
}

async function generatePlan(ctx: vscode.ExtensionContext): Promise<void> {
  if (!current) {
    return;
  }
  const anthropic = await buildAiService(ctx);
  if (!anthropic) {
    panel?.webview.postMessage({
      type: "planError",
      message: "AI isn't enabled. Enable it in settings (loopline.ai.enabled) and set an API key.",
    });
    return;
  }
  panel?.webview.postMessage({ type: "planLoading" });
  try {
    const repoRoot = await currentRepoQuiet(ctx);
    const layout = repoRoot ? topLevelEntries(repoRoot) : [];
    const plan = await withCancellableProgress(
      "Loopline: drafting an implementation plan…",
      (signal) =>
        anthropic.generateImplementationPlan(
          {
            ticketKey: current!.key,
            summary: current!.summary,
            description: current!.description,
            issueType: current!.issueType,
            repoLayout: layout,
          },
          signal
        )
    );
    panel?.webview.postMessage({ type: "plan", html: mdToHtml(plan) });
  } catch (err) {
    if (isCancelled(err)) {
      panel?.webview.postMessage({ type: "planError", message: "Cancelled." });
      return;
    }
    logError("plan generation failed", err);
    panel?.webview.postMessage({ type: "planError", message: (err as Error).message });
  }
}

function renderHtml(detail: TicketDetail, opts: { aiEnabled: boolean }): string {
  const nonce = makeNonce();
  const descHtml = detail.description.trim()
    ? mdToHtml(detail.description)
    : `<p class="muted">No description on this ticket.</p>`;
  const chips = [
    detail.issueType ? `<span class="chip">${escapeHtml(detail.issueType)}</span>` : "",
    detail.status ? `<span class="chip chip-status">${escapeHtml(detail.status)}</span>` : "",
  ].join("");

  const aiButton = opts.aiEnabled
    ? `<button id="generate" class="btn">✨ Generate implementation suggestions</button>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px 24px;
    line-height: 1.55;
  }
  .key {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    letter-spacing: .04em;
  }
  h1.summary { font-size: 20px; margin: 4px 0 12px; font-weight: 600; }
  .chips { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    font-size: 11px; padding: 2px 9px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .chip-status { background: var(--vscode-button-secondaryBackground, var(--vscode-badge-background)); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 22px; }
  .btn {
    font-family: inherit; font-size: 13px; cursor: pointer;
    border: none; border-radius: 4px; padding: 6px 12px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 20px 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
  a { color: var(--vscode-textLink-foreground); }
  code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
  ul, ol { padding-left: 22px; }
  .muted { color: var(--vscode-descriptionForeground); }
  #plan { display: none; }
  #plan.show { display: block; }
  .spinner { color: var(--vscode-descriptionForeground); font-style: italic; }
  .plan-note { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
</style>
</head>
<body>
  <div class="key">${escapeHtml(detail.key)}</div>
  <h1 class="summary">${escapeHtml(detail.summary || "(no summary)")}</h1>
  <div class="chips">${chips}</div>
  <div class="actions">
    <button id="createBranch" class="btn">Create branch from this ticket</button>
    <button id="openJira" class="btn secondary">Open in Jira ↗</button>
    ${aiButton}
  </div>
  <hr />
  <h2>Description</h2>
  <div id="description">${descHtml}</div>

  <div id="plan">
    <hr />
    <h2>Implementation suggestions</h2>
    <div class="plan-note">AI-generated starting point — review critically.</div>
    <div id="planBody"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('createBranch', () => vscode.postMessage({ type: 'createBranch' }));
    on('openJira', () => vscode.postMessage({ type: 'openJira' }));
    on('generate', () => vscode.postMessage({ type: 'generate' }));

    const planWrap = document.getElementById('plan');
    const planBody = document.getElementById('planBody');
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'planLoading') {
        planWrap.classList.add('show');
        planBody.innerHTML = '<p class="spinner">Generating…</p>';
        const g = document.getElementById('generate'); if (g) g.setAttribute('disabled','true');
      } else if (m.type === 'plan') {
        planWrap.classList.add('show');
        planBody.innerHTML = m.html;
        const g = document.getElementById('generate'); if (g) g.removeAttribute('disabled');
      } else if (m.type === 'planError') {
        planWrap.classList.add('show');
        planBody.innerHTML = '<p class="muted">' + m.message + '</p>';
        const g = document.getElementById('generate'); if (g) g.removeAttribute('disabled');
      }
    });
  </script>
</body>
</html>`;
}

function makeNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

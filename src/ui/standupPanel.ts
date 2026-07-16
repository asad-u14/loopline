import * as vscode from "vscode";
import { mdToHtml } from "../util/markdown";

export interface StandupSummary {
  dateLabel: string;
  markdown: string;
  aiGenerated: boolean;
}

// A single reused panel — generating again updates it instead of stacking tabs.
let panel: vscode.WebviewPanel | undefined;
let current: StandupSummary | undefined;

export function showStandupSummary(detail: StandupSummary): void {
  current = detail;

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "looplineStandup",
      "Standup Summary",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      panel = undefined;
      current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "copy" && current) {
        vscode.env.clipboard.writeText(current.markdown);
        vscode.window.setStatusBarMessage("Loopline: standup summary copied.", 2000);
      }
    });
  }

  panel.title = `Standup — ${detail.dateLabel}`;
  panel.webview.html = renderHtml(detail);
  panel.reveal(vscode.ViewColumn.Beside, false);
}

function renderHtml(detail: StandupSummary): string {
  const nonce = makeNonce();
  const bodyHtml = mdToHtml(detail.markdown);
  const sourceNote = detail.aiGenerated
    ? "AI-drafted from today's commits — review before sharing."
    : "Plain list from today's commits (AI drafting is off or unavailable).";

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
  .eyebrow {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    letter-spacing: .04em;
  }
  h1.title { font-size: 20px; margin: 4px 0 12px; font-weight: 600; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 16px; }
  .btn {
    font-family: inherit; font-size: 13px; cursor: pointer;
    border: none; border-radius: 4px; padding: 6px 12px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .note { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 18px 0; }
  a { color: var(--vscode-textLink-foreground); }
  code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  ul, ol { padding-left: 22px; }
</style>
</head>
<body>
  <div class="eyebrow">LOOPLINE</div>
  <h1 class="title">Standup — ${escapeAttr(detail.dateLabel)}</h1>
  <div class="actions">
    <button id="copy" class="btn">Copy to clipboard</button>
  </div>
  <div class="note">${sourceNote}</div>
  <hr />
  <div id="body">${bodyHtml}</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  </script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

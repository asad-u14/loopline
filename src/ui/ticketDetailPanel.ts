import * as vscode from "vscode";
import * as path from "path";
import { readConfig } from "../util/config";
import { buildAiService, currentRepoQuiet } from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { mdToHtml, escapeHtml } from "../util/markdown";
import { topLevelEntries } from "../util/repo-layout";
import { logError } from "../util/log";
import { notablePriority, relativeTime, iconForType, colorForType } from "../util/tree-helpers";

export interface TicketDetail {
  key: string;
  summary: string;
  issueType: string;
  status?: string;
  statusCategory?: string;
  description: string;
  jiraBaseUrl: string;
  assignee?: string;
  reporter?: string;
  priority?: string;
  labels?: string[];
  created?: string;
  updated?: string;
  dueDate?: string;
  parent?: { key: string; summary: string };
  /** True while the full ticket is still being fetched — renders a skeleton for the parts not yet known. */
  loading?: boolean;
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
    case "openParentJira":
      if (current.jiraBaseUrl && current.parent) {
        vscode.env.openExternal(
          vscode.Uri.parse(`${current.jiraBaseUrl}/browse/${current.parent.key}`)
        );
      }
      return;
    case "copyKey":
      await vscode.env.clipboard.writeText(current.key);
      panel?.webview.postMessage({ type: "copied" });
      return;
    case "copyAiContext":
      await vscode.env.clipboard.writeText(await buildAiContextMarkdown(ctx, current));
      panel?.webview.postMessage({ type: "copiedAiContext" });
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

// ---- small inline icon set (16x16, currentColor) — keeps the panel dependency-free
// rather than shipping the codicon font into the webview. Colored via the same
// iconForType/colorForType classification the tree view already uses.

const ICON_PATHS: Record<string, string> = {
  bug: '<ellipse cx="8" cy="9.5" rx="3.5" ry="4"/><line x1="8" y1="3" x2="8" y2="5.5"/><line x1="5" y1="4" x2="6" y2="5.5"/><line x1="11" y1="4" x2="10" y2="5.5"/><line x1="4" y1="9.5" x2="1.5" y2="9.5"/><line x1="12" y1="9.5" x2="14.5" y2="9.5"/><line x1="4.5" y1="13" x2="2.5" y2="14.5"/><line x1="11.5" y1="13" x2="13.5" y2="14.5"/>',
  book: '<path d="M2.5 3h4a2 2 0 0 1 2 2v8.5a2 2 0 0 0-2-1.3h-4z"/><path d="M13.5 3h-4a2 2 0 0 0-2 2v8.5a2 2 0 0 1 2-1.3h4z"/>',
  milestone: '<path d="M8 1.5l3 3-3 3-3-3 3-3z" fill="currentColor" stroke="none"/><rect x="7.25" y="7" width="1.5" height="7.5" rx="0.5" fill="currentColor" stroke="none"/>',
  "list-tree": '<line x1="3" y1="2" x2="3" y2="14"/><line x1="3" y1="5" x2="8" y2="5"/><line x1="3" y1="11" x2="8" y2="11"/><circle cx="10.5" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="10.5" cy="11" r="1.5" fill="currentColor" stroke="none"/>',
  "issue-opened": '<circle cx="8" cy="8" r="6"/>',
};

function typeIconSvg(issueType: string): string {
  const id = iconForType(issueType);
  const path = ICON_PATHS[id] ?? ICON_PATHS["issue-opened"];
  const colorVar = `--vscode-${colorForType(issueType).replace(".", "-")}`;
  return `<svg class="type-icon" style="color:var(${colorVar})" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">${path}</svg>`;
}

function priorityIconSvg(priority: string): string {
  const isLow = /low|minor|trivial/i.test(priority);
  const path = isLow ? '<path d="M8 13L3 7h10l-5 6z"/>' : '<path d="M8 3l5 6H3l5-6z"/>';
  const colorVar = isLow ? "--vscode-descriptionForeground" : "--vscode-charts-red";
  return `<svg class="priority-icon" style="color:var(${colorVar})" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">${path}</svg>`;
}

const CLIPBOARD_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4" y="4" width="9" height="10" rx="1.5"/><path d="M11 4V2.5A1.5 1.5 0 0 0 9.5 1h-6A1.5 1.5 0 0 0 2 2.5v9A1.5 1.5 0 0 0 3.5 13H5"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5l3 3 7-7"/></svg>';

const AVATAR_COLORS = ["charts-blue", "charts-green", "charts-orange", "charts-purple", "charts-red", "charts-yellow"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarHtml(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const colorVar = `--vscode-${AVATAR_COLORS[hash % AVATAR_COLORS.length]}`;
  return `<span class="avatar" style="background:var(${colorVar})">${escapeHtml(initials(name))}</span>`;
}

/** "Due in 5d" / "Due today" / "Overdue by 2d" for a Jira due date (date-only ISO string). */
function dueDateLabel(due: string | undefined, now = Date.now()): string | undefined {
  if (!due) {
    return undefined;
  }
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) {
    return undefined;
  }
  const diffDays = Math.round((dueMs - now) / 86400000);
  if (diffDays === 0) {
    return "Due today";
  }
  if (diffDays > 0) {
    return `Due in ${diffDays}d`;
  }
  return `Overdue by ${Math.abs(diffDays)}d`;
}

function statusCategoryClass(category: string | undefined): string {
  if (category === "done") {
    return "chip-status-done";
  }
  if (category === "indeterminate") {
    return "chip-status-progress";
  }
  if (category === "new") {
    return "chip-status-new";
  }
  return "";
}

function parseSectionBullets(description: string, sectionPattern: RegExp): string[] {
  if (!description.trim()) {
    return [];
  }
  const lines = description.replace(/\r\n/g, "\n").split("\n");
  let inSection = false;
  const bullets: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inSection && bullets.length > 0) {
        break;
      }
      continue;
    }

    const isHeading = /^#{1,6}\s+/.test(line) || /^[A-Za-z][A-Za-z0-9 /_-]{2,40}:$/.test(line);
    if (sectionPattern.test(line.replace(/^#{1,6}\s+/, "").replace(/:$/, "").trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (isHeading) {
      break;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (bulletMatch?.[1]) {
      bullets.push(bulletMatch[1].trim());
      continue;
    }

    // Accept plain lines in the section as fallback criteria/constraints entries.
    bullets.push(line);
  }

  return bullets.filter(Boolean);
}

function buildOpenQuestions(detail: TicketDetail, description: string, acceptanceCriteria: string[]): string[] {
  const questions: string[] = [];
  if (!detail.summary?.trim()) {
    questions.push("What business outcome should define success for this ticket?");
  }
  if (!description.trim()) {
    questions.push("What behavior or user flow should be implemented or fixed?");
    questions.push("What edge cases should be handled?");
  }
  if (acceptanceCriteria.length === 0) {
    questions.push("What exact acceptance criteria define done?");
  }
  if (/bug|defect|incident/i.test(detail.issueType || "")) {
    const hasReproHints = /steps to reproduce|expected|actual|repro/i.test(description);
    if (!hasReproHints) {
      questions.push("Can you provide reproduction steps and expected vs actual behavior?");
    }
  }
  if (questions.length === 0) {
    questions.push("Are there any hidden constraints (performance, security, compatibility) not listed above?");
  }
  return questions;
}

async function buildAiContextMarkdown(ctx: vscode.ExtensionContext, detail: TicketDetail): Promise<string> {
  const summary = detail.summary?.trim() || "No summary provided.";
  const description = detail.description?.trim() || "No description provided.";
  const acceptanceCriteria = parseSectionBullets(description, /^(acceptance criteria|acceptance|ac)$/i);
  const constraints = parseSectionBullets(description, /^(constraints?|non-goals?|out of scope)$/i);
  const openQuestions = buildOpenQuestions(detail, detail.description || "", acceptanceCriteria);

  const repoRoot = await currentRepoQuiet(ctx);
  const layout = repoRoot ? topLevelEntries(repoRoot, 12) : [];
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activePath = activeUri?.scheme === "file" ? activeUri.fsPath : undefined;
  const activeRel = repoRoot && activePath ? path.relative(repoRoot, activePath) : undefined;

  const lines: string[] = [
    `# Jira Ticket ${detail.key}: ${summary}`,
    "",
    "## Goal",
    summary,
    "",
    "## Acceptance Criteria",
    ...(acceptanceCriteria.length > 0
      ? acceptanceCriteria.map((v) => `- ${v}`)
      : ["- Not provided in Jira ticket."]),
    "",
    "## Metadata",
    `- Key: ${detail.key}`,
    `- Type: ${detail.issueType || "Unknown"}`,
    `- Status: ${detail.status || "Unknown"}`,
    `- Priority: ${detail.priority || "Unknown"}`,
    `- Assignee: ${detail.assignee || "Unassigned"}`,
    `- Reporter: ${detail.reporter || "Unknown"}`,
    detail.parent ? `- Parent: ${detail.parent.key} - ${detail.parent.summary}` : "",
    detail.labels?.length ? `- Labels: ${detail.labels.join(", ")}` : "",
    detail.created ? `- Created: ${detail.created}` : "",
    detail.updated ? `- Updated: ${detail.updated}` : "",
    detail.dueDate ? `- Due: ${detail.dueDate}` : "",
    "",
    "## Description",
    description,
    "",
    "## Code Context",
    repoRoot ? `- Repository: ${path.basename(repoRoot)}` : "- Repository: Not inferred yet.",
    activeRel && !activeRel.startsWith("..") ? `- Active file: ${activeRel}` : "- Active file: Not inferred yet.",
    layout.length > 0 ? `- Top-level entries: ${layout.join(", ")}` : "- Top-level entries: Not inferred yet.",
    "",
    "## Constraints / Non-Goals",
    ...(constraints.length > 0 ? constraints.map((v) => `- ${v}`) : ["- Not provided in Jira ticket."]),
    "",
    "## Open Questions",
    ...openQuestions.map((q) => `- ${q}`),
    "",
    "## Guidance For AI",
    "Use only the provided ticket/context as source of truth.",
    "If a required detail is missing, ask clarifying questions before proposing implementation specifics.",
    "Keep changes minimal, testable, and aligned with existing patterns.",
    "",
    "## Expected Response Format",
    "1. Proposed implementation approach",
    "2. Files likely to change with brief reasons",
    "3. Risks or regressions to watch",
    "4. Test plan (unit/integration/manual)",
  ];
  return lines.filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n").trim() + "\n";
}

function skeletonLines(widths: number[]): string {
  return widths.map((w) => `<div class="skeleton skeleton-line" style="width:${w}%"></div>`).join("");
}

function renderHtml(detail: TicketDetail, opts: { aiEnabled: boolean }): string {
  const nonce = makeNonce();
  const loading = !!detail.loading;

  const descriptionHtml = loading
    ? skeletonLines([95, 88, 60])
    : detail.description.trim()
    ? mdToHtml(detail.description)
    : `<p class="muted">No description on this ticket.</p>`;

  const priority = notablePriority(detail.priority);
  const statusCls = statusCategoryClass(detail.statusCategory);
  const chips = [
    detail.issueType
      ? `<span class="chip">${typeIconSvg(detail.issueType)}${escapeHtml(detail.issueType)}</span>`
      : "",
    detail.status
      ? `<span class="chip chip-status ${statusCls}"><span class="status-dot"></span>${escapeHtml(detail.status)}</span>`
      : "",
    priority ? `<span class="chip chip-priority">${priorityIconSvg(priority)}${escapeHtml(priority)}</span>` : "",
    detail.assignee ? `<span class="chip chip-assignee">${avatarHtml(detail.assignee)}${escapeHtml(detail.assignee)}</span>` : "",
  ].join("");

  const parentBreadcrumb = detail.parent
    ? `<div class="breadcrumb"><a href="#" id="openParent">↳ ${escapeHtml(detail.parent.key)}: ${escapeHtml(
        detail.parent.summary
      )}</a></div>`
    : "";

  const reporterPart =
    detail.reporter && detail.reporter !== detail.assignee
      ? `${avatarHtml(detail.reporter)}Reported by ${escapeHtml(detail.reporter)}`
      : "";

  const labels = detail.labels ?? [];
  const createdAgo = relativeTime(detail.created);
  const updatedAgo = relativeTime(detail.updated);
  const due = dueDateLabel(detail.dueDate);
  const labelsPart = labels.length ? `Labels: ${labels.map(escapeHtml).join(" · ")}` : "";
  const datesPart = [
    createdAgo ? `Created ${createdAgo} ago` : "",
    updatedAgo ? `Updated ${updatedAgo} ago` : "",
    due ? `<span class="${due.startsWith("Overdue") ? "overdue" : ""}">${escapeHtml(due)}</span>` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const metaHtml = loading
    ? `<div class="meta-row"><span class="skeleton skeleton-text" style="width:130px"></span><span class="skeleton skeleton-text" style="width:170px"></span></div>
       <div class="skeleton skeleton-text" style="width:180px;margin-bottom:16px"></div>`
    : `${
        reporterPart || datesPart
          ? `<div class="meta-row"><span class="reporter">${reporterPart}</span><span>${datesPart}</span></div>`
          : ""
      }${labelsPart ? `<div class="meta-line">${labelsPart}</div>` : ""}`;

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
  .breadcrumb { font-size: 12px; margin-bottom: 6px; }
  .breadcrumb a { color: var(--vscode-descriptionForeground); text-decoration: none; }
  .breadcrumb a:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .key-row { display: flex; align-items: center; gap: 6px; }
  .key {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    letter-spacing: .04em;
  }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; padding: 0; border: none; border-radius: 4px;
    background: none; color: var(--vscode-descriptionForeground); cursor: pointer;
  }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); color: var(--vscode-foreground); }
  h1.summary { font-size: 20px; margin: 4px 0 12px; font-weight: 600; }
  .chips { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; padding: 2px 9px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .type-icon { flex: none; }
  .chip-status { background: var(--vscode-button-secondaryBackground, var(--vscode-badge-background)); }
  .chip-status-done { color: var(--vscode-charts-green); }
  .chip-status-progress { color: var(--vscode-charts-blue); }
  .chip-status-new { color: var(--vscode-descriptionForeground); }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .chip-priority, .chip-assignee { background: none; padding: 2px 0; color: var(--vscode-foreground); }
  .avatar {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 16px; height: 16px; border-radius: 50%;
    font-size: 9px; font-weight: 600; color: var(--vscode-editor-background);
  }
  .meta-line { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  .meta-row {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .reporter { display: inline-flex; align-items: center; gap: 5px; }
  .overdue { color: var(--vscode-errorForeground, #f14c4c); }
  .skeleton {
    background: linear-gradient(90deg,
      var(--vscode-input-background, rgba(128,128,128,.15)) 25%,
      var(--vscode-widget-border, rgba(128,128,128,.35)) 37%,
      var(--vscode-input-background, rgba(128,128,128,.15)) 63%);
    background-size: 400% 100%;
    animation: loopline-shimmer 1.4s ease infinite;
    border-radius: 4px;
  }
  @keyframes loopline-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  .skeleton-text { display: inline-block; height: 12px; vertical-align: middle; }
  .skeleton-line { height: 13px; margin-bottom: 10px; }
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
  ${parentBreadcrumb}
  <div class="key-row">
    <span class="key">${escapeHtml(detail.key)}</span>
    <button id="copyKey" class="icon-btn" title="Copy ticket key">${CLIPBOARD_ICON}</button>
  </div>
  <h1 class="summary">${escapeHtml(detail.summary || "(no summary)")}</h1>
  <div class="chips">${chips}</div>
  ${metaHtml}
  <div class="actions">
    <button id="createBranch" class="btn">Create branch from this ticket</button>
    <button id="openJira" class="btn secondary">Open in Jira ↗</button>
    <button id="copyAiContext" class="btn secondary" title="Copy AI-ready markdown for Claude Code / Copilot Chat">Copy AI context</button>
    ${aiButton}
  </div>
  <hr />
  <h2>Description</h2>
  <div id="description">${descriptionHtml}</div>

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
    on('copyKey', () => vscode.postMessage({ type: 'copyKey' }));
    on('copyAiContext', () => vscode.postMessage({ type: 'copyAiContext' }));
    on('openParent', (e) => { e.preventDefault(); vscode.postMessage({ type: 'openParentJira' }); });

    const planWrap = document.getElementById('plan');
    const planBody = document.getElementById('planBody');
    const copyBtn = document.getElementById('copyKey');
    const copyBtnDefault = copyBtn ? copyBtn.innerHTML : '';
    const copyAiBtn = document.getElementById('copyAiContext');
    const copyAiDefault = copyAiBtn ? copyAiBtn.textContent : '';
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
      } else if (m.type === 'copied' && copyBtn) {
        copyBtn.innerHTML = '${CHECK_ICON}';
        setTimeout(() => { copyBtn.innerHTML = copyBtnDefault; }, 1200);
      } else if (m.type === 'copiedAiContext' && copyAiBtn) {
        copyAiBtn.textContent = 'Copied';
        setTimeout(() => { copyAiBtn.textContent = copyAiDefault; }, 1200);
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

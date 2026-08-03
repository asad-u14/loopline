import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { currentRepoQuiet } from "./workspace";
import { topLevelEntries } from "./repo-layout";

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

export async function buildAiContextMarkdown(ctx: vscode.ExtensionContext, detail: TicketDetail): Promise<string> {
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

// ---- CLAUDE.md sync ----------------------------------------------------------

export const CLAUDE_MD_FILENAME = "CLAUDE.md";

const SYNC_START = "<!-- loopline:ticket-context:start -->";
const SYNC_END = "<!-- loopline:ticket-context:end -->";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AiContextSyncResult {
  filePath: string;
}

/**
 * Write (or replace) a delimited "current ticket" block in CLAUDE.md at the repo
 * root, so Claude Code picks up ticket context automatically on its next prompt
 * instead of requiring a manual copy/paste. Only the content between the markers
 * is ever touched — anything else already in CLAUDE.md is left as-is.
 */
export function syncTicketContextToClaudeMd(repoRoot: string, markdown: string): AiContextSyncResult {
  const filePath = path.join(repoRoot, CLAUDE_MD_FILENAME);
  const block = [
    SYNC_START,
    "<!-- Auto-generated by Loopline from the current ticket. Edits inside this block are overwritten on the next sync. -->",
    "",
    markdown.trim(),
    "",
    SYNC_END,
  ].join("\n");

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const markerPattern = new RegExp(`${escapeRegExp(SYNC_START)}[\\s\\S]*?${escapeRegExp(SYNC_END)}`);

  let next: string;
  if (markerPattern.test(existing)) {
    next = existing.replace(markerPattern, block);
  } else if (existing.trim()) {
    next = `${existing.trimEnd()}\n\n${block}\n`;
  } else {
    next = `${block}\n`;
  }

  fs.writeFileSync(filePath, next, "utf8");
  return { filePath };
}

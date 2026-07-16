/**
 * Pure helpers for the standup-summary command — no vscode import, so
 * trivially unit-testable.
 */

import { extractTicketKey } from "./text";

export interface CommitGroup {
  ticketKey?: string;
  subjects: string[];
}

/** Midnight, local time, for the given (or current) moment. */
export function startOfDay(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Group commit subjects by the ticket key found in them (Loopline's own
 * commits are `<type>: <TICKET-KEY> <summary>`, so this recovers the ticket
 * from the message alone). Commits with no recognizable key land in one
 * `ticketKey: undefined` group. Order of first appearance is preserved.
 */
export function groupCommitsByTicket(subjects: string[]): CommitGroup[] {
  const order: (string | undefined)[] = [];
  const map = new Map<string | undefined, string[]>();
  for (const subject of subjects) {
    const key = extractTicketKey(subject)?.key;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, []);
    }
    map.get(key)!.push(subject);
  }
  return order.map((key) => ({ ticketKey: key, subjects: map.get(key)! }));
}

/**
 * Deterministic fallback used when AI is off, unavailable, or fails. Body only —
 * the date/title is rendered separately by whatever displays this (the standup
 * webview panel), so it isn't duplicated inside the text itself.
 */
export function formatStandupFallback(groups: CommitGroup[]): string {
  if (groups.length === 0) {
    return "No commits to summarize.";
  }
  const lines: string[] = [];
  for (const g of groups) {
    const label = g.ticketKey ?? "Other";
    lines.push(`**${label}** (${g.subjects.length} commit${g.subjects.length === 1 ? "" : "s"})`);
    for (const s of g.subjects) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

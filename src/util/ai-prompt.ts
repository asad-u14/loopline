/**
 * Pure helpers for assembling the AI MR-description prompt. No vscode / network
 * imports so this is trivially unit-testable.
 */

export interface MrPromptInput {
  ticketKey: string;
  ticketSummary: string;
  ticketDescription: string;
  sourceBranch: string;
  targetBranch: string;
  changedFiles: string[];
  diff: string;
}

export const MR_SYSTEM_PROMPT = [
  "You are a senior engineer writing a merge request description for a teammate to review.",
  "Write in GitLab-flavored Markdown. Be concise, concrete, and skimmable.",
  "Base everything ONLY on the provided ticket and diff — never invent changes, files, or behavior that aren't in the diff.",
  "If the diff is truncated or unclear, say so briefly rather than guessing.",
  "Use these sections, omitting any that would be empty:",
  "## Summary — 1–2 sentences on what this MR does.",
  "## Changes — bullet list of the notable changes, grouped logically.",
  "## Why — tie the change back to the ticket's intent.",
  "## Testing — how a reviewer can verify it (or note if tests were added).",
  "Do not wrap the whole response in a code fence. Do not add a title heading.",
].join("\n");

/** Truncate a diff to a byte budget, flagging when we cut it. */
export function truncateDiff(
  diff: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const buf = Buffer.from(diff ?? "", "utf8");
  if (buf.length <= maxBytes) {
    return { text: diff ?? "", truncated: false };
  }
  // subarray may split a multibyte char at the boundary; toString tolerates it.
  const text = buf.subarray(0, maxBytes).toString("utf8");
  return { text, truncated: true };
}

export function buildMrUserPrompt(input: MrPromptInput, maxDiffBytes: number): string {
  const { text: diffText, truncated } = truncateDiff(input.diff, maxDiffBytes);

  const parts: string[] = [];
  parts.push(`Jira ticket: ${input.ticketKey}`);
  if (input.ticketSummary) {
    parts.push(`Ticket summary: ${input.ticketSummary}`);
  }
  if (input.ticketDescription?.trim()) {
    parts.push(`Ticket description:\n${input.ticketDescription.trim()}`);
  }
  parts.push(`Branch: ${input.sourceBranch} → ${input.targetBranch}`);
  if (input.changedFiles.length) {
    parts.push(`Changed files:\n${input.changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  parts.push(
    truncated
      ? `Diff (truncated to fit; describe what is visible and note the truncation):\n\n\`\`\`diff\n${diffText}\n\`\`\``
      : `Diff:\n\n\`\`\`diff\n${diffText}\n\`\`\``
  );
  parts.push("Write the merge request description now.");
  return parts.join("\n\n");
}

// ---- implementation plan ----------------------------------------------------

export interface PlanPromptInput {
  ticketKey: string;
  summary: string;
  description: string;
  issueType: string;
  repoLayout: string[]; // shallow, top-level entries for light grounding
}

export const PLAN_SYSTEM_PROMPT = [
  "You are a senior engineer helping a teammate START a ticket. Produce a concise, practical implementation plan in Markdown.",
  "You are given the ticket and only a shallow, top-level listing of the repository — you do NOT see the full codebase.",
  "Do not invent exact file paths, function names, or APIs you cannot reasonably infer; keep suggestions at the right level of confidence and say when something needs to be confirmed in the code.",
  "Structure the plan with these Markdown sections, omitting any that don't apply:",
  "## Goal — one or two sentences restating what the ticket asks for.",
  "## Suggested approach — a short ordered list of steps.",
  "## Likely areas to change — bullet list of components/areas (with tentative paths only where the layout makes them obvious).",
  "## Edge cases & risks — things to watch for.",
  "## Tests to add — what to cover.",
  "## Open questions — anything ambiguous in the ticket worth clarifying first.",
  "Keep it tight and skimmable. This is a starting map, not final code — the developer will validate it.",
].join("\n");

export function buildPlanUserPrompt(input: PlanPromptInput): string {
  const parts: string[] = [];
  parts.push(`Jira ticket: ${input.ticketKey}`);
  if (input.issueType) {
    parts.push(`Type: ${input.issueType}`);
  }
  if (input.summary) {
    parts.push(`Summary: ${input.summary}`);
  }
  parts.push(
    input.description?.trim()
      ? `Description:\n${input.description.trim()}`
      : "Description: (none provided in the ticket)"
  );
  parts.push(
    input.repoLayout.length
      ? `Repository top-level layout (partial):\n${input.repoLayout.map((e) => `- ${e}`).join("\n")}`
      : "Repository layout: (not available)"
  );
  parts.push("Write the implementation plan now.");
  return parts.join("\n\n");
}

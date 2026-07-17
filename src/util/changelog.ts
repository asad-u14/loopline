/**
 * Pure helpers for auto-drafting a CHANGELOG.md entry alongside an MR — no
 * vscode import, so trivially unit-testable. File I/O and the git commit that
 * lands the entry live in commitAndPush.ts.
 */

export const DEFAULT_CHANGELOG_CATEGORY_MAPPING: Record<string, string> = {
  bugfix: "Fixed",
  hotfix: "Fixed",
  feature: "Added",
  chore: "Changed",
};

/** Which "Keep a Changelog"-style subsection a branch prefix maps to. Unmapped prefixes default to "Changed". */
export function changelogCategoryForPrefix(prefix: string, mapping: Record<string, string>): string {
  return mapping[prefix] || "Changed";
}

/** e.g. "- **[LPB-1234](https://acme.atlassian.net/browse/LPB-1234)** — Fix login redirect". */
export function buildChangelogLine(ticketKey: string, summary: string, jiraBaseUrl: string): string {
  const clean = (summary || "").trim().replace(/\s+/g, " ");
  const ticketRef = jiraBaseUrl ? `[${ticketKey}](${jiraBaseUrl}/browse/${ticketKey})` : ticketKey;
  return `- **${ticketRef}** — ${clean}`;
}

const isHeading2 = (line: string): boolean => /^##\s/.test(line);
const isUnreleasedHeading = (line: string): boolean => /^##\s*\[?unreleased\]?/i.test(line.trim());
const isSubheading = (line: string): boolean => /^###\s/.test(line);
const subheadingName = (line: string): string => line.replace(/^###\s*/, "").trim();

/**
 * Insert one bullet line under `### {category}` inside a `## Unreleased`
 * section, creating either as needed. Never throws — a changelog it can't
 * confidently parse just gets a new Unreleased block prepended rather than
 * risking corrupting existing content.
 */
export function insertChangelogEntry(content: string, category: string, line: string): string {
  const lines = content.split("\n");
  const firstH2 = lines.findIndex(isHeading2);

  let unreleasedStart: number;
  if (firstH2 !== -1 && isUnreleasedHeading(lines[firstH2])) {
    unreleasedStart = firstH2;
  } else {
    const insertAt = firstH2 === -1 ? lines.length : firstH2;
    lines.splice(insertAt, 0, "## Unreleased", "");
    unreleasedStart = insertAt;
  }

  let unreleasedEnd = lines.length;
  for (let i = unreleasedStart + 1; i < lines.length; i++) {
    if (isHeading2(lines[i])) {
      unreleasedEnd = i;
      break;
    }
  }

  let subStart = -1;
  for (let i = unreleasedStart + 1; i < unreleasedEnd; i++) {
    if (isSubheading(lines[i]) && subheadingName(lines[i]) === category) {
      subStart = i;
      break;
    }
  }

  if (subStart === -1) {
    let insertAt = unreleasedStart + 1;
    while (insertAt < unreleasedEnd && lines[insertAt].trim() === "") {
      insertAt++;
    }
    lines.splice(insertAt, 0, `### ${category}`, line, "");
    return lines.join("\n");
  }

  let subEnd = unreleasedEnd;
  for (let i = subStart + 1; i < unreleasedEnd; i++) {
    if (isSubheading(lines[i])) {
      subEnd = i;
      break;
    }
  }
  let insertAt = subEnd;
  while (insertAt > subStart + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

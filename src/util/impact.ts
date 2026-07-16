/**
 * Pure helpers for the "Loopline Impact" footer row — no vscode import, so
 * trivially unit-testable. Storage lives in impactStore.ts.
 */

export interface ImpactStats {
  branchesCreated: number;
  commitsPushed: number;
  mrsOpened: number;
  /** ISO timestamp of the first tracked event; undefined until then. */
  since?: string;
}

export interface ImpactRates {
  minutesPerBranch: number;
  minutesPerCommit: number;
  minutesPerMr: number;
}

export const EMPTY_IMPACT_STATS: ImpactStats = {
  branchesCreated: 0,
  commitsPushed: 0,
  mrsOpened: 0,
};

/** The footer row is hidden entirely until there's something to show. */
export function hasAnyActivity(stats: ImpactStats): boolean {
  return stats.branchesCreated > 0 || stats.commitsPushed > 0 || stats.mrsOpened > 0;
}

/** Estimated minutes saved. Always a guess — the assumptions are surfaced alongside it, never hidden. */
export function estimateMinutesSaved(stats: ImpactStats, rates: ImpactRates): number {
  return (
    stats.branchesCreated * rates.minutesPerBranch +
    stats.commitsPushed * rates.minutesPerCommit +
    stats.mrsOpened * rates.minutesPerMr
  );
}

/** "45m" or "3.5h" — compact, no trailing ".0". */
export function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 60) {
    return `${Math.round(totalMinutes)}m`;
  }
  const hours = Math.round((totalMinutes / 60) * 10) / 10;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

function plural(n: number, singular: string, irregularPlural?: string): string {
  const word = n === 1 ? singular : (irregularPlural ?? `${singular}s`);
  return `${n} ${word}`;
}

/** The single-line footer row, e.g. "12 branches · 8 commits · 5 MRs · ~3.5h saved". */
export function formatImpactLine(stats: ImpactStats, rates: ImpactRates): string {
  const minutes = estimateMinutesSaved(stats, rates);
  return [
    plural(stats.branchesCreated, "branch", "branches"),
    plural(stats.commitsPushed, "commit"),
    plural(stats.mrsOpened, "MR"),
    `~${formatDuration(minutes)} saved`,
  ].join(" · ");
}

/** Human date for the tooltip, e.g. "Jun 1, 2026". Falls back to the raw ISO string if unparseable. */
export function formatSinceDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Multi-line tooltip shown on hover. */
export function formatImpactTooltip(stats: ImpactStats, rates: ImpactRates): string {
  const minutes = estimateMinutesSaved(stats, rates);
  return [
    stats.since ? `Loopline Impact — since ${formatSinceDate(stats.since)}` : "Loopline Impact",
    "",
    `Branches created: ${stats.branchesCreated}`,
    `Commits pushed: ${stats.commitsPushed}`,
    `Merge requests opened: ${stats.mrsOpened}`,
    "",
    `Estimated time saved: ~${formatDuration(minutes)}`,
    `(~${rates.minutesPerBranch}m/branch, ~${rates.minutesPerCommit}m/commit, ~${rates.minutesPerMr}m/MR)`,
    "",
    "Click for full breakdown / reset",
  ].join("\n");
}

/** Full breakdown shown in the details dialog — same facts as the tooltip, no "click for" footer. */
export function formatImpactDetail(stats: ImpactStats, rates: ImpactRates): string {
  const minutes = estimateMinutesSaved(stats, rates);
  const lines = [
    stats.since ? `Since ${formatSinceDate(stats.since)}` : undefined,
    stats.since ? "" : undefined,
    `Branches created: ${stats.branchesCreated}`,
    `Commits pushed: ${stats.commitsPushed}`,
    `Merge requests opened: ${stats.mrsOpened}`,
    "",
    `Estimated time saved: ~${formatDuration(minutes)}`,
    `(~${rates.minutesPerBranch}m/branch, ~${rates.minutesPerCommit}m/commit, ~${rates.minutesPerMr}m/MR — adjust in settings)`,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

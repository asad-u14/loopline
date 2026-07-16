import { RepoStatus } from "../services/git";

export type StagingMode = "respectStaged" | "pick" | "all";

/**
 * What the commit step should stage.
 *  - "index":   something is already staged; commit it untouched. This is the only
 *               plan that preserves partial (hunk-level) staging from `git add -p`.
 *  - "files":   stage exactly these paths.
 *  - "all":     `git add -A` (legacy behavior).
 *  - "nothing": there is nothing to commit.
 */
export type StagingPlan =
  | { kind: "index"; files: string[] }
  | { kind: "files"; files: string[] }
  | { kind: "all" }
  | { kind: "nothing" };

/**
 * respectStaged: honor intent when it's expressed.
 * If anything is staged, that IS the commit — don't touch the index, so
 * hunk-level staging survives. Otherwise fall back to tracked modifications,
 * and only include untracked files when explicitly told to.
 */
export function planRespectStaged(status: RepoStatus, includeUntracked: boolean): StagingPlan {
  if (status.staged.length > 0) {
    return { kind: "index", files: [...status.staged] };
  }
  const files = [...status.unstaged, ...(includeUntracked ? status.untracked : [])];
  const unique = [...new Set(files)];
  return unique.length ? { kind: "files", files: unique } : { kind: "nothing" };
}

/** Files offered in "pick" mode, with the already-staged ones pre-selected. */
export function pickCandidates(status: RepoStatus): {
  all: string[];
  preselected: string[];
} {
  const all = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])].sort();
  return { all, preselected: [...new Set(status.staged)] };
}

/** True when the working tree has nothing at all to offer. */
export function isCleanTree(status: RepoStatus): boolean {
  return (
    status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0
  );
}

/**
 * Does this file have BOTH staged and unstaged changes? Those are the files where
 * `git add -A` would silently sweep in work the developer deliberately left out.
 */
export function partiallyStagedFiles(status: RepoStatus): string[] {
  const unstaged = new Set(status.unstaged);
  return status.staged.filter((f) => unstaged.has(f));
}

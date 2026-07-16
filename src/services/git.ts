import simpleGit, { SimpleGit } from "simple-git";
import { branchMatchesTicket } from "../util/tree-helpers";

export interface RemoteInfo {
  host: string;         // e.g. gitlab.com
  projectPath: string;  // e.g. group/subgroup/project
}

/**
 * Working-tree classification. `staged` and `unstaged` can contain the same path
 * when a file has both staged and unstaged hunks.
 */
export interface RepoStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export class GitService {
  private git: SimpleGit;

  constructor(private repoRoot: string) {
    // `block` kills a git subprocess if it produces no output for this long,
    // giving us a real timeout on hangs (e.g. a push waiting on a credential prompt).
    this.git = simpleGit({ baseDir: repoRoot, timeout: { block: 20000 } });
  }

  async isRepo(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async currentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "";
  }

  /** True when HEAD is detached (no branch checked out). */
  async isDetachedHead(): Promise<boolean> {
    try {
      // `git symbolic-ref -q HEAD` exits non-zero on a detached HEAD.
      await this.git.raw(["symbolic-ref", "-q", "HEAD"]);
      return false;
    } catch {
      return true;
    }
  }

  /** True if a remote with this name exists (default: origin). */
  async hasRemote(name = "origin"): Promise<boolean> {
    const remotes = await this.git.getRemotes(false);
    return remotes.some((r) => r.name === name);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status();
    return status.files.length > 0;
  }

  async listChangedFiles(): Promise<string[]> {
    const status = await this.git.status();
    return status.files.map((f) => f.path);
  }

  /**
   * Classify the working tree. A file can be BOTH staged and unstaged (e.g. after
   * `git add -p` stages some hunks), which is exactly the case `git add -A`
   * destroys — so these lists deliberately overlap.
   */
  async getStatus(): Promise<RepoStatus> {
    const s = await this.git.status();
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    for (const f of s.files) {
      const idx = f.index ?? " ";
      const wt = f.working_dir ?? " ";
      if (idx === "?" || wt === "?") {
        untracked.push(f.path);
        continue;
      }
      if (idx !== " " && idx !== "") {
        staged.push(f.path);
      }
      if (wt !== " " && wt !== "") {
        unstaged.push(f.path);
      }
    }
    return { staged, unstaged, untracked };
  }

  /** Stage specific paths. */
  async stageFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.git.add(["--", ...paths]);
  }

  /** Stage modifications to tracked files only — never picks up untracked files. */
  async stageTracked(): Promise<void> {
    await this.git.add(["-u"]);
  }

  /** Unstage everything (mixed reset), leaving the working tree alone. */
  async unstageAll(): Promise<void> {
    await this.git.reset(["--"]);
  }

  /** Files currently staged for commit. */
  async listStagedFiles(): Promise<string[]> {
    const out = await this.git.diff(["--cached", "--name-only"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** Diff of exactly what will be committed (the index vs HEAD). */
  async getStagedDiff(): Promise<string> {
    try {
      return await this.git.diff(["--cached"]);
    } catch {
      return "";
    }
  }

  /** True if anything is staged. */
  async hasStagedChanges(): Promise<boolean> {
    return (await this.listStagedFiles()).length > 0;
  }

  /** Diff of the working tree + staged changes vs HEAD (i.e. what a commit would capture). */
  async getUncommittedDiff(): Promise<string> {
    try {
      return await this.git.diff(["HEAD"]);
    } catch {
      return "";
    }
  }

  /**
   * Diff introduced by the current branch relative to `target` (merge-base diff,
   * matching what an MR would show). Tries local then origin/ ref; falls back to
   * the last commit if the target can't be resolved.
   */
  async getBranchDiff(target: string): Promise<string> {
    const ref = await this.resolveRef(target);
    try {
      if (ref) {
        const base = (await this.git.raw(["merge-base", ref, "HEAD"])).trim();
        if (base) {
          return await this.git.diff([`${base}`, "HEAD"]);
        }
      }
    } catch {
      /* fall through */
    }
    try {
      return await this.git.diff(["HEAD~1", "HEAD"]);
    } catch {
      return "";
    }
  }

  private async resolveRef(target: string): Promise<string | undefined> {
    for (const candidate of [target, `origin/${target}`]) {
      try {
        const out = await this.git.raw(["rev-parse", "--verify", "--quiet", candidate]);
        if (out.trim().length > 0) {
          return candidate;
        }
      } catch {
        /* try next */
      }
    }
    return undefined;
  }

  async branchExists(name: string): Promise<boolean> {
    const branches = await this.git.branchLocal();
    return branches.all.includes(name);
  }

  /** All local branch names. */
  async listLocalBranches(): Promise<string[]> {
    const branches = await this.git.branchLocal();
    return branches.all;
  }

  /**
   * Local branches referencing the given ticket key. Uses boundary matching, so
   * "LPB-1" doesn't match a "LPB-12" branch.
   */
  async branchesForTicket(ticketKey: string): Promise<string[]> {
    const branches = await this.git.branchLocal();
    return branches.all.filter((n) => branchMatchesTicket(n, ticketKey));
  }

  /** Check out an existing branch. */
  async checkout(name: string): Promise<void> {
    try {
      await this.git.checkout(name);
    } catch (err) {
      throw new GitError(`Could not check out "${name}": ${(err as Error).message}`);
    }
  }

  /** Create and checkout a new branch. If it already exists, just checks it out. */
  async createAndCheckout(name: string): Promise<void> {
    try {
      if (await this.branchExists(name)) {
        await this.git.checkout(name);
      } else {
        await this.git.checkoutLocalBranch(name);
      }
    } catch (err) {
      throw new GitError(`Could not create/checkout "${name}": ${(err as Error).message}`);
    }
  }

  /** Create and checkout a new branch starting from a specific ref (e.g. origin/main). */
  async createAndCheckoutFrom(name: string, startPoint: string): Promise<void> {
    try {
      await this.git.checkoutBranch(name, startPoint);
    } catch (err) {
      throw new GitError(
        `Could not create "${name}" from "${startPoint}": ${(err as Error).message}`
      );
    }
  }

  /** Fetch a branch (or everything) from a remote. */
  async fetch(remote = "origin", branch?: string): Promise<void> {
    try {
      if (branch) {
        await this.git.fetch(remote, branch);
      } else {
        await this.git.fetch(remote);
      }
    } catch (err) {
      throw new GitError(`Fetch from ${remote} failed: ${(err as Error).message}`);
    }
  }

  /** True if a ref (branch, remote-tracking ref, sha) resolves. */
  async revExists(ref: string): Promise<boolean> {
    try {
      const out = await this.git.raw(["rev-parse", "--verify", "--quiet", ref]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async stageAll(): Promise<void> {
    await this.git.add(["-A"]);
  }

  async commit(message: string): Promise<void> {
    await this.git.commit(message);
  }

  /** Push current branch to origin, setting upstream tracking on first push. */
  async pushSetUpstream(branch: string): Promise<void> {
    try {
      await this.git.push(["-u", "origin", branch]);
    } catch (err) {
      throw new GitError(`Push failed: ${(err as Error).message}`);
    }
  }

  /**
   * Push a rewritten branch. Uses --force-with-lease, which refuses to clobber
   * commits pushed by someone else since our last fetch.
   */
  async pushForceWithLease(branch: string): Promise<void> {
    try {
      await this.git.push(["--force-with-lease", "-u", "origin", branch]);
    } catch (err) {
      throw new GitError(
        `Force-push failed (nothing was lost): ${(err as Error).message}. ` +
          `If someone else pushed to this branch, fetch and reconcile first.`
      );
    }
  }

  /** True once the branch has an upstream (i.e. it has been pushed). */
  async hasUpstream(branch: string): Promise<boolean> {
    return this.revExists(`origin/${branch}`);
  }

  /** Merge-base of the branch and its base, i.e. where this branch's work starts. */
  async mergeBaseWith(base: string): Promise<string | undefined> {
    const ref = (await this.revExists(`origin/${base}`))
      ? `origin/${base}`
      : (await this.revExists(base))
        ? base
        : undefined;
    if (!ref) {
      return undefined;
    }
    try {
      const out = await this.git.raw(["merge-base", ref, "HEAD"]);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Number of commits on HEAD that aren't in `fromRef`. */
  async countCommitsSince(fromRef: string): Promise<number> {
    try {
      const out = await this.git.raw(["rev-list", "--count", `${fromRef}..HEAD`]);
      return Number(out.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /** Subjects of the commits on HEAD since `fromRef`, newest first. */
  async listCommitSubjects(fromRef: string): Promise<string[]> {
    try {
      const out = await this.git.raw(["log", "--format=%s", `${fromRef}..HEAD`]);
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Move HEAD back to `ref` while leaving the index and working tree untouched.
   * Committing afterwards collapses everything since `ref` into one commit.
   */
  async softResetTo(ref: string): Promise<void> {
    try {
      await this.git.reset(["--soft", ref]);
    } catch (err) {
      throw new GitError(`Could not reset to ${ref}: ${(err as Error).message}`);
    }
  }

  /** Parse the origin remote URL (SSH or HTTPS) into host + project path. */
  async getOriginInfo(): Promise<RemoteInfo | undefined> {
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    const url = origin?.refs?.fetch || origin?.refs?.push;
    if (!url) {
      return undefined;
    }
    return parseRemoteUrl(url);
  }
}

/**
 * Resolve the git repository root that contains `dir` (via `rev-parse --show-toplevel`).
 * Returns undefined if `dir` isn't inside a git repo (or doesn't exist).
 */
export async function findRepoRootForDir(dir: string): Promise<string | undefined> {
  try {
    const top = await simpleGit({ baseDir: dir }).revparse(["--show-toplevel"]);
    const trimmed = top.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handle both forms:
 *   git@gitlab.com:group/project.git
 *   https://gitlab.com/group/subgroup/project.git
 */
export function parseRemoteUrl(url: string): RemoteInfo | undefined {
  const cleaned = url.trim();

  // SSH form: git@host:path
  const ssh = cleaned.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) {
    return { host: ssh[1], projectPath: ssh[2].replace(/\/+$/, "") };
  }

  // HTTPS/HTTP form
  const https = cleaned.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) {
    return { host: https[1], projectPath: https[2].replace(/\/+$/, "") };
  }

  return undefined;
}

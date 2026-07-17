import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { GitService, GitError, findRepoRootForDir } from "../src/services/git";

let repo: string;
let git: GitService;
const dirs: string[] = [];

function run(cmd: string, cwd = repo) {
  execSync(cmd, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.co",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.co",
    },
  });
}

function mkTmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  repo = mkTmpDir("loopline-gitmethods-");
  run("git init -q -b main");
  run('git config user.name "t"');
  run('git config user.email "t@t.co"');
  fs.writeFileSync(path.join(repo, "app.js"), "l1\nl2\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# proj\n");
  run("git add -A");
  run('git commit -q -m "init"');
  git = new GitService(repo);
});

after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// ---- isRepo -----------------------------------------------------------------

test("isRepo: true for a real repo", async () => {
  assert.equal(await git.isRepo(), true);
});

test("isRepo: false for a non-repo directory", async () => {
  const notRepo = mkTmpDir("loopline-notrepo-");
  const g = new GitService(notRepo);
  assert.equal(await g.isRepo(), false);
});

// ---- currentBranch / isDetachedHead -----------------------------------------

test("currentBranch returns the checked-out branch name", async () => {
  assert.equal(await git.currentBranch(), "main");
});

test("isDetachedHead: false on a normal branch", async () => {
  assert.equal(await git.isDetachedHead(), false);
});

test("isDetachedHead: true when HEAD is detached", async () => {
  const sha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  run(`git checkout -q ${sha}`);
  assert.equal(await git.isDetachedHead(), true);
});

// ---- hasRemote / getOriginInfo ------------------------------------------------

test("hasRemote: false when no remote configured", async () => {
  assert.equal(await git.hasRemote(), false);
});

test("hasRemote: true once origin is added", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  assert.equal(await git.hasRemote(), true);
  assert.equal(await git.hasRemote("upstream"), false);
});

test("getOriginInfo: undefined when no origin remote", async () => {
  assert.equal(await git.getOriginInfo(), undefined);
});

test("getOriginInfo: parses the origin URL", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin git@gitlab.com:group/project.git`);
  const info = await git.getOriginInfo();
  assert.deepEqual(info, { host: "gitlab.com", projectPath: "group/project" });
});

// ---- hasUncommittedChanges / listChangedFiles / hasStagedChanges -------------

test("hasUncommittedChanges: false on a clean tree", async () => {
  assert.equal(await git.hasUncommittedChanges(), false);
});

test("hasUncommittedChanges: true with an untracked file", async () => {
  fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
  assert.equal(await git.hasUncommittedChanges(), true);
});

test("listChangedFiles: lists staged, unstaged and untracked paths", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "changed\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
  const files = await git.listChangedFiles();
  assert.ok(files.includes("app.js"));
  assert.ok(files.includes("new.txt"));
});

test("hasStagedChanges: false with nothing staged", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "changed\n");
  assert.equal(await git.hasStagedChanges(), false);
});

test("hasStagedChanges: true once something is staged", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "changed\n");
  run("git add app.js");
  assert.equal(await git.hasStagedChanges(), true);
});

// ---- getUncommittedDiff -------------------------------------------------------

test("getUncommittedDiff: shows staged + unstaged vs HEAD", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "changed content\n");
  run("git add app.js");
  fs.appendFileSync(path.join(repo, "app.js"), "more\n");
  const diff = await git.getUncommittedDiff();
  assert.match(diff, /changed content/);
  assert.match(diff, /more/);
});

// ---- branchExists / listLocalBranches / branchesForTicket --------------------

test("branchExists: true/false", async () => {
  run("git checkout -q -b feature/LPB-9-thing");
  run("git checkout -q main");
  assert.equal(await git.branchExists("feature/LPB-9-thing"), true);
  assert.equal(await git.branchExists("nope"), false);
});

test("listLocalBranches: includes all local branches", async () => {
  run("git checkout -q -b other");
  run("git checkout -q main");
  const branches = await git.listLocalBranches();
  assert.ok(branches.includes("main"));
  assert.ok(branches.includes("other"));
});

test("branchesForTicket: matches with boundary, not substring", async () => {
  run("git checkout -q -b feature/LPB-1-login");
  run("git checkout -q -b feature/LPB-12-other");
  run("git checkout -q main");
  const matches = await git.branchesForTicket("LPB-1");
  assert.deepEqual(matches, ["feature/LPB-1-login"]);
});

// ---- checkout / createAndCheckout / createAndCheckoutFrom --------------------

test("checkout: switches to an existing branch", async () => {
  run("git checkout -q -b other");
  run("git checkout -q main");
  await git.checkout("other");
  assert.equal(await git.currentBranch(), "other");
});

test("checkout: throws GitError for a non-existent branch", async () => {
  await assert.rejects(() => git.checkout("does-not-exist"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Could not check out "does-not-exist"/);
    return true;
  });
});

test("createAndCheckout: creates a new branch when it doesn't exist", async () => {
  await git.createAndCheckout("feature/LPB-5-new");
  assert.equal(await git.currentBranch(), "feature/LPB-5-new");
});

test("createAndCheckout: checks out existing branch instead of recreating", async () => {
  run("git checkout -q -b feature/LPB-5-new");
  run("git checkout -q main");
  await git.createAndCheckout("feature/LPB-5-new");
  assert.equal(await git.currentBranch(), "feature/LPB-5-new");
});

test("createAndCheckout: throws GitError on failure", async () => {
  // An invalid branch name causes checkoutLocalBranch to fail.
  await assert.rejects(() => git.createAndCheckout("bad..name"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Could not create\/checkout "bad\.\.name"/);
    return true;
  });
});

test("createAndCheckoutFrom: creates a branch starting at a given ref", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "v2\n");
  run("git add -A");
  run('git commit -q -m "second"');
  const firstSha = execSync("git rev-list --max-parents=0 HEAD", { cwd: repo }).toString().trim();

  await git.createAndCheckoutFrom("feature/LPB-6-from-first", firstSha);
  assert.equal(await git.currentBranch(), "feature/LPB-6-from-first");
  const head = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  assert.equal(head, firstSha);
});

test("createAndCheckoutFrom: throws GitError for a bad start point", async () => {
  await assert.rejects(() => git.createAndCheckoutFrom("feature/x", "no-such-ref"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Could not create "feature\/x" from "no-such-ref"/);
    return true;
  });
});

// ---- fetch / revExists / hasUpstream ------------------------------------------

test("fetch: succeeds against a real remote (no branch arg)", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  run("git push -q origin main");
  await git.fetch();
  assert.equal(await git.revExists("origin/main"), true);
});

test("fetch: succeeds with a specific branch", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  run("git push -q origin main");
  await git.fetch("origin", "main");
  assert.equal(await git.revExists("origin/main"), true);
});

test("fetch: throws GitError when the remote doesn't exist", async () => {
  await assert.rejects(() => git.fetch("origin"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Fetch from origin failed/);
    return true;
  });
});

test("revExists: true for HEAD, false for garbage", async () => {
  assert.equal(await git.revExists("HEAD"), true);
  assert.equal(await git.revExists("not-a-real-ref-xyz"), false);
});

test("hasUpstream: false before push, true after", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  assert.equal(await git.hasUpstream("main"), false);
  run("git push -q -u origin main");
  assert.equal(await git.hasUpstream("main"), true);
});

// ---- stageAll / commit --------------------------------------------------------

test("stageAll + commit: stages everything including untracked and commits", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "changed\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
  await git.stageAll();
  await git.commit("chore: stage all");
  const status = await git.getStatus();
  assert.deepEqual(status, { staged: [], unstaged: [], untracked: [] });
  const log = execSync("git log --format=%s -1", { cwd: repo }).toString().trim();
  assert.equal(log, "chore: stage all");
});

// ---- push: pushSetUpstream / pushForceWithLease -------------------------------

test("pushSetUpstream: pushes and sets tracking branch", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  await git.pushSetUpstream("main");
  assert.equal(await git.hasUpstream("main"), true);
});

test("pushSetUpstream: throws GitError when there's no remote", async () => {
  await assert.rejects(() => git.pushSetUpstream("main"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Push failed/);
    return true;
  });
});

test("pushForceWithLease: succeeds pushing a rewritten branch", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  run("git push -q -u origin main");

  // Rewrite history (amend) then force-with-lease push.
  fs.writeFileSync(path.join(repo, "app.js"), "amended\n");
  run("git add -A");
  run('git commit -q --amend -m "init (amended)"');

  await git.pushForceWithLease("main");
  const remoteLog = execSync(`git --git-dir="${bare}" log --format=%s -1 main`).toString().trim();
  assert.equal(remoteLog, "init (amended)");
});

test("pushForceWithLease: throws GitError when the lease is stale (remote moved)", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  run("git push -q -u origin main");

  // Simulate someone else pushing to the remote without us fetching.
  const other = mkTmpDir("loopline-other-clone-");
  run(`git clone -q "${bare}" "${other}"`, other);
  run('git config user.name "t"', other);
  run('git config user.email "t@t.co"', other);
  fs.writeFileSync(path.join(other, "other.txt"), "x\n");
  run("git add -A", other);
  run('git commit -q -m "other change"', other);
  run("git push -q origin main", other);

  // Now our local remote-tracking ref is stale relative to the real remote.
  fs.writeFileSync(path.join(repo, "app.js"), "amended locally\n");
  run("git add -A");
  run('git commit -q --amend -m "init (amended locally)"');

  await assert.rejects(() => git.pushForceWithLease("main"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Force-push failed/);
    return true;
  });
});

// ---- getStagedDiff / getUncommittedDiff error fallback (defensive catch) -----
// The try/catch around `git diff` is defensive; a real repo won't throw here, so
// we don't attempt to fabricate a failure — see final report.

// ---- getBranchDiff / resolveRef -----------------------------------------------

test("getBranchDiff: diffs against local target branch via merge-base", async () => {
  run("git checkout -q -b feature/LPB-7-x");
  fs.writeFileSync(path.join(repo, "app.js"), "feature change\n");
  run("git add -A");
  run('git commit -q -m "feature work"');

  const diff = await git.getBranchDiff("main");
  assert.match(diff, /feature change/);
});

test("getBranchDiff: falls back to origin/<target> when local target doesn't exist", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  run("git push -q origin main");
  // Delete local main so only origin/main resolves; must be on another branch first.
  run("git checkout -q -b feature/LPB-8-y");
  run("git branch -q -D main");
  fs.writeFileSync(path.join(repo, "app.js"), "y change\n");
  run("git add -A");
  run('git commit -q -m "y work"');

  const diff = await git.getBranchDiff("main");
  assert.match(diff, /y change/);
});

test("getBranchDiff: falls back to HEAD~1..HEAD when target can't be resolved at all", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "second commit\n");
  run("git add -A");
  run('git commit -q -m "second"');

  const diff = await git.getBranchDiff("no-such-branch-anywhere");
  assert.match(diff, /second commit/);
});

test("getBranchDiff: returns empty string when nothing resolves and there's no HEAD~1", async () => {
  // Single-commit repo: HEAD~1 doesn't exist either.
  const diff = await git.getBranchDiff("no-such-branch-anywhere");
  assert.equal(diff, "");
});

// ---- mergeBaseWith / countCommitsSince / listCommitSubjects ------------------

test("mergeBaseWith: undefined when neither local nor origin base exists", async () => {
  const base = await git.mergeBaseWith("no-such-branch");
  assert.equal(base, undefined);
});

test("mergeBaseWith: prefers origin/<base> when it exists", async () => {
  const bare = mkTmpDir("loopline-bare-");
  run(`git init -q --bare "${bare}"`);
  run(`git remote add origin "${bare}"`);
  run("git push -q origin main");
  const base = await git.mergeBaseWith("main");
  assert.ok(base);
});

test("countCommitsSince: returns 0 for an unresolvable ref (raw throws)", async () => {
  const count = await git.countCommitsSince("not-a-real-ref");
  assert.equal(count, 0);
});

test("listCommitSubjects: returns [] for an unresolvable ref (raw throws)", async () => {
  const subjects = await git.listCommitSubjects("not-a-real-ref");
  assert.deepEqual(subjects, []);
});

// ---- listMyCommitsSince --------------------------------------------------------

test("listMyCommitsSince: returns own commits since a date, oldest first", async () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(repo, "app.js"), "c1\n");
  run("git add -A");
  run('git commit -q -m "commit one"');
  fs.writeFileSync(path.join(repo, "app.js"), "c2\n");
  run("git add -A");
  run('git commit -q -m "commit two"');

  const subjects = await git.listMyCommitsSince(since);
  assert.ok(subjects.includes("commit one"));
  assert.ok(subjects.includes("commit two"));
  assert.ok(subjects.indexOf("commit one") < subjects.indexOf("commit two"));
});

test("listMyCommitsSince: dedups commits reachable from multiple branches", async () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(repo, "app.js"), "shared\n");
  run("git add -A");
  run('git commit -q -m "shared commit"');
  run("git checkout -q -b feature/LPB-9-a");
  run("git checkout -q main");
  run("git checkout -q -b feature/LPB-9-b");
  run("git checkout -q main");

  const subjects = await git.listMyCommitsSince(since);
  const count = subjects.filter((s) => s === "shared commit").length;
  assert.equal(count, 1);
});

test("listMyCommitsSince: falls back to unfiltered log when user.email isn't configured", async () => {
  run("git config --unset user.email");
  // `git config user.email` falls back to the host's global/system config if
  // set (as it is on a real developer machine), which would defeat this test
  // regardless of the local unset above — isolate from both for this case.
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    const since = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(path.join(repo, "app.js"), "no-email-commit\n");
    run('git -c user.name=t -c user.email=t@t.co add -A');
    run('git -c user.name=t -c user.email=t@t.co commit -q -m "no email commit"');

    const subjects = await git.listMyCommitsSince(since);
    assert.ok(subjects.includes("no email commit"));
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  }
});

// ---- softResetTo ---------------------------------------------------------------

test("softResetTo: throws GitError for a bad ref", async () => {
  await assert.rejects(() => git.softResetTo("not-a-real-ref"), (err) => {
    assert.ok(err instanceof GitError);
    assert.match((err as Error).message, /Could not reset to not-a-real-ref/);
    return true;
  });
});

// ---- findRepoRootForDir ---------------------------------------------------------

test("findRepoRootForDir: resolves the repo root for a nested dir", async () => {
  const nested = path.join(repo, "nested", "deep");
  fs.mkdirSync(nested, { recursive: true });
  const root = await findRepoRootForDir(nested);
  assert.equal(root, fs.realpathSync(repo));
});

test("findRepoRootForDir: undefined for a directory that isn't a repo", async () => {
  const notRepo = mkTmpDir("loopline-notrepo2-");
  const root = await findRepoRootForDir(notRepo);
  assert.equal(root, undefined);
});

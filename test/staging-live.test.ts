import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { GitService } from "../src/services/git";
import { planRespectStaged, partiallyStagedFiles } from "../src/util/staging";

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

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-stage-")));
  dirs.push(repo);
  run("git init -q -b main");
  // simple-git spawns its own git process, so identity must live in the repo
  // config rather than only in this helper's env.
  run('git config user.name "t"');
  run('git config user.email "t@t.co"');
  fs.writeFileSync(path.join(repo, "app.js"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# proj\n");
  run("git add -A");
  run('git commit -q -m "init"');
  git = new GitService(repo);
});

after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test("getStatus: classifies staged, unstaged and untracked", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "changed\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# proj edited\n");
  fs.writeFileSync(path.join(repo, "debug.js"), "scratch\n");
  run("git add app.js");

  const s = await git.getStatus();
  assert.deepEqual(s.staged, ["app.js"]);
  assert.deepEqual(s.unstaged, ["README.md"]);
  assert.deepEqual(s.untracked, ["debug.js"]);
});

test("getStatus: a partially staged file is reported as BOTH staged and unstaged", async () => {
  // Stage one version, then modify again -> index and worktree both differ.
  fs.writeFileSync(path.join(repo, "app.js"), "staged version\n");
  run("git add app.js");
  fs.writeFileSync(path.join(repo, "app.js"), "staged version\nplus unstaged work\n");

  const s = await git.getStatus();
  assert.ok(s.staged.includes("app.js"));
  assert.ok(s.unstaged.includes("app.js"));
  assert.deepEqual(partiallyStagedFiles(s), ["app.js"]);
});

test("respectStaged preserves partial staging: unstaged work is NOT committed", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "THE FIX\n");
  run("git add app.js");
  fs.appendFileSync(path.join(repo, "app.js"), "WIP EXPERIMENT\n");

  const s = await git.getStatus();
  const plan = planRespectStaged(s, false);
  assert.equal(plan.kind, "index"); // index untouched => hunk staging survives

  // Simulate the command: plan.kind === "index" stages nothing, then commits.
  await git.commit("fix: LPB-1 login");

  const committed = execSync("git show HEAD:app.js", { cwd: repo }).toString();
  assert.match(committed, /THE FIX/);
  assert.doesNotMatch(committed, /WIP EXPERIMENT/, "WIP must not ship");

  // ...and the WIP is still in the working tree.
  const s2 = await git.getStatus();
  assert.ok(s2.unstaged.includes("app.js"));
});

test("untracked files are not staged by stageTracked (no accidental secrets)", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "fix\n");
  fs.writeFileSync(path.join(repo, ".env.local"), "API_TOKEN=secret\n");

  await git.stageTracked();
  const staged = await git.listStagedFiles();
  assert.deepEqual(staged, ["app.js"]);
  assert.ok(!staged.includes(".env.local"), "untracked secret must not be staged");
});

test("stageFiles stages only the given paths", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "a\n");
  fs.writeFileSync(path.join(repo, "README.md"), "b\n");
  await git.stageFiles(["app.js"]);
  assert.deepEqual(await git.listStagedFiles(), ["app.js"]);
});

test("unstageAll clears the index but keeps the working tree", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "a\n");
  run("git add -A");
  await git.unstageAll();
  assert.deepEqual(await git.listStagedFiles(), []);
  const s = await git.getStatus();
  assert.ok(s.unstaged.includes("app.js"), "change should still exist, just unstaged");
});

test("getStagedDiff reflects the index only, not unstaged work", async () => {
  fs.writeFileSync(path.join(repo, "app.js"), "STAGED LINE\n");
  run("git add app.js");
  fs.appendFileSync(path.join(repo, "app.js"), "UNSTAGED LINE\n");

  const diff = await git.getStagedDiff();
  assert.match(diff, /STAGED LINE/);
  assert.doesNotMatch(diff, /UNSTAGED LINE/, "AI/MR must describe only what is committed");
});

test("squash: soft reset + commit collapses branch commits into one", async () => {
  run("git checkout -q -b feature/LPB-1-x");
  fs.writeFileSync(path.join(repo, "app.js"), "v1\n");
  run("git add -A");
  run('git commit -q -m "wip 1"');
  fs.writeFileSync(path.join(repo, "app.js"), "v2\n");
  run("git add -A");
  run('git commit -q -m "wip 2"');

  const mergeBase = await git.mergeBaseWith("main");
  assert.ok(mergeBase);
  assert.equal(await git.countCommitsSince(mergeBase!), 2);

  // New staged work on top
  fs.writeFileSync(path.join(repo, "app.js"), "v3-final\n");
  await git.stageFiles(["app.js"]);

  await git.softResetTo(mergeBase!);
  await git.commit("feat: LPB-1 all of it");

  assert.equal(await git.countCommitsSince(mergeBase!), 1, "branch should have exactly one commit");
  const subjects = await git.listCommitSubjects(mergeBase!);
  assert.deepEqual(subjects, ["feat: LPB-1 all of it"]);
  assert.match(execSync("git show HEAD:app.js", { cwd: repo }).toString(), /v3-final/);
});

test("squash keeps unstaged work out of the squashed commit", async () => {
  run("git checkout -q -b feature/LPB-2-y");
  fs.writeFileSync(path.join(repo, "app.js"), "committed work\n");
  run("git add -A");
  run('git commit -q -m "wip"');

  fs.writeFileSync(path.join(repo, "app.js"), "committed work\nstaged work\n");
  await git.stageFiles(["app.js"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# unrelated edit\n"); // left unstaged

  const mergeBase = (await git.mergeBaseWith("main"))!;
  await git.softResetTo(mergeBase);
  await git.commit("feat: LPB-2 squashed");

  const files = execSync(`git show --name-only --format= HEAD`, { cwd: repo }).toString();
  assert.match(files, /app\.js/);
  assert.doesNotMatch(files, /README\.md/, "unstaged unrelated edit must stay out");
});

test("countCommitsSince is 0 for a fresh branch (no squash needed)", async () => {
  run("git checkout -q -b feature/LPB-3-z");
  const mergeBase = (await git.mergeBaseWith("main"))!;
  assert.equal(await git.countCommitsSince(mergeBase), 0);
});

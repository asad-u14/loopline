import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { GitService } from "../src/services/git";

let repo: string;
let git: GitService;

function run(cmd: string) {
  execSync(cmd, {
    cwd: repo,
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

before(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-branch-")));
  run("git init -q -b main");
  fs.writeFileSync(path.join(repo, "a.txt"), "hi");
  run("git add -A");
  run('git commit -q -m "init"');
  run("git branch feature/LPB-1234-do-a-thing");
  run("git branch bugfix/lpb-1234-old-attempt");
  run("git branch feature/ABC-9-other");
  git = new GitService(repo);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test("branchesForTicket: matches all branches for a key, case-insensitively", async () => {
  const found = (await git.branchesForTicket("LPB-1234")).sort();
  assert.deepEqual(found, ["bugfix/lpb-1234-old-attempt", "feature/LPB-1234-do-a-thing"]);
});

test("branchesForTicket: unrelated ticket returns none", async () => {
  assert.deepEqual(await git.branchesForTicket("ZZZ-1"), []);
});

test("branchExists: exact name", async () => {
  assert.equal(await git.branchExists("feature/ABC-9-other"), true);
  assert.equal(await git.branchExists("feature/ABC-9-nope"), false);
});

test("revExists: true for HEAD, false for nonsense", async () => {
  assert.equal(await git.revExists("HEAD"), true);
  assert.equal(await git.revExists("no-such-ref-xyz"), false);
});

test("createAndCheckoutFrom: branches from the given start point", async () => {
  // Make a second commit on main, then branch from the first commit.
  const firstSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  fs.writeFileSync(path.join(repo, "b.txt"), "two");
  run("git add -A");
  run('git commit -q -m "second"');

  await git.createAndCheckoutFrom("feature/LPB-777-from-base", firstSha);
  const headSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  assert.equal(headSha, firstSha);
  const branch = await git.currentBranch();
  assert.equal(branch, "feature/LPB-777-from-base");
});

test("branchesForTicket: LPB-1 does not match the LPB-1234 branch (regression)", async () => {
  // The old substring check returned the LPB-1234 branches for key "LPB-1".
  run("git branch feature/LPB-1-short");
  const found = (await git.branchesForTicket("LPB-1")).sort();
  assert.deepEqual(found, ["feature/LPB-1-short"]);
});

test("listLocalBranches: returns every local branch", async () => {
  const all = await git.listLocalBranches();
  assert.ok(all.includes("main"));
  assert.ok(all.includes("feature/LPB-1234-do-a-thing"));
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { findRepoRootForDir } from "../src/services/git";

let tmp: string;
let repoA: string;
let nestedDir: string;
let notARepo: string;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-test-")));
  repoA = path.join(tmp, "repoA");
  nestedDir = path.join(repoA, "src", "deep");
  notARepo = path.join(tmp, "plain");

  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(notARepo, { recursive: true });
  execSync("git init -q", { cwd: repoA });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("findRepoRootForDir: a repo root resolves to itself", async () => {
  assert.equal(await findRepoRootForDir(repoA), repoA);
});

test("findRepoRootForDir: a nested subdir resolves to the repo root", async () => {
  assert.equal(await findRepoRootForDir(nestedDir), repoA);
});

test("findRepoRootForDir: a non-repo directory resolves to undefined", async () => {
  assert.equal(await findRepoRootForDir(notARepo), undefined);
});

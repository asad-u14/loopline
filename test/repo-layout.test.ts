import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { topLevelEntries } from "../src/util/repo-layout";

let dir: string;

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-layout-")));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, ".github"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("topLevelEntries: lists files and directories, directories suffixed with /", () => {
  const entries = topLevelEntries(dir);
  assert.ok(entries.includes("src/"));
  assert.ok(entries.includes("package.json"));
  assert.ok(entries.includes("README.md"));
});

test("topLevelEntries: skips node_modules, .git, and other build/noise dirs", () => {
  const entries = topLevelEntries(dir);
  assert.ok(!entries.includes("node_modules/"));
  assert.ok(!entries.includes(".git/"));
});

test("topLevelEntries: hides dotfiles except .github", () => {
  const entries = topLevelEntries(dir);
  assert.ok(!entries.includes(".gitignore"));
  assert.ok(entries.includes(".github/"));
});

test("topLevelEntries: caps at `max` entries", () => {
  const manyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopline-layout-many-"));
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(manyDir, `file${i}.txt`), "");
  }
  const entries = topLevelEntries(manyDir, 3);
  assert.equal(entries.length, 3);
  fs.rmSync(manyDir, { recursive: true, force: true });
});

test("topLevelEntries: a nonexistent directory returns an empty list, not a throw", () => {
  assert.deepEqual(topLevelEntries(path.join(dir, "does-not-exist")), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planRespectStaged,
  pickCandidates,
  isCleanTree,
  partiallyStagedFiles,
} from "../src/util/staging";

const status = (s: string[], u: string[], n: string[]) => ({
  staged: s,
  unstaged: u,
  untracked: n,
});

test("planRespectStaged: staged files win — index is left untouched", () => {
  const plan = planRespectStaged(status(["auth.js"], ["README.md"], ["debug.js"]), false);
  assert.deepEqual(plan, { kind: "index", files: ["auth.js"] });
});

test("planRespectStaged: index plan ignores includeUntracked (intent already given)", () => {
  const plan = planRespectStaged(status(["auth.js"], [], ["debug.js"]), true);
  assert.deepEqual(plan, { kind: "index", files: ["auth.js"] });
});

test("planRespectStaged: nothing staged -> tracked modifications only", () => {
  const plan = planRespectStaged(status([], ["auth.js", "README.md"], ["debug.js"]), false);
  assert.deepEqual(plan, { kind: "files", files: ["auth.js", "README.md"] });
});

test("planRespectStaged: untracked included only when asked", () => {
  const plan = planRespectStaged(status([], ["auth.js"], ["debug.js"]), true);
  assert.deepEqual(plan, { kind: "files", files: ["auth.js", "debug.js"] });
});

test("planRespectStaged: only untracked, not included -> nothing", () => {
  assert.deepEqual(planRespectStaged(status([], [], ["debug.js"]), false), { kind: "nothing" });
});

test("planRespectStaged: only untracked, included -> those files", () => {
  assert.deepEqual(planRespectStaged(status([], [], ["debug.js"]), true), {
    kind: "files",
    files: ["debug.js"],
  });
});

test("planRespectStaged: clean tree -> nothing", () => {
  assert.deepEqual(planRespectStaged(status([], [], []), true), { kind: "nothing" });
});

test("planRespectStaged: de-duplicates overlapping paths", () => {
  // a partially-staged file appears in both lists
  const plan = planRespectStaged(status([], ["app.js", "app.js"], ["app.js"]), true);
  assert.deepEqual(plan, { kind: "files", files: ["app.js"] });
});

test("partiallyStagedFiles: finds files with staged AND unstaged hunks", () => {
  // This is exactly what `git add -A` would silently sweep up.
  assert.deepEqual(partiallyStagedFiles(status(["app.js", "b.js"], ["app.js"], [])), ["app.js"]);
});

test("partiallyStagedFiles: none when staging is clean-cut", () => {
  assert.deepEqual(partiallyStagedFiles(status(["a.js"], ["b.js"], [])), []);
});

test("pickCandidates: lists everything, preselects staged", () => {
  const { all, preselected } = pickCandidates(status(["a.js"], ["b.js"], ["c.js"]));
  assert.deepEqual(all, ["a.js", "b.js", "c.js"]);
  assert.deepEqual(preselected, ["a.js"]);
});

test("pickCandidates: a partially staged file appears once and is preselected", () => {
  const { all, preselected } = pickCandidates(status(["app.js"], ["app.js"], []));
  assert.deepEqual(all, ["app.js"]);
  assert.deepEqual(preselected, ["app.js"]);
});

test("isCleanTree: true only when nothing at all", () => {
  assert.equal(isCleanTree(status([], [], [])), true);
  assert.equal(isCleanTree(status([], [], ["x"])), false);
  assert.equal(isCleanTree(status([], ["x"], [])), false);
  assert.equal(isCleanTree(status(["x"], [], [])), false);
});

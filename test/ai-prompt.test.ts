import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateDiff, buildMrUserPrompt, buildPlanUserPrompt } from "../src/util/ai-prompt";

test("truncateDiff: under budget is untouched", () => {
  const r = truncateDiff("small diff", 1000);
  assert.equal(r.truncated, false);
  assert.equal(r.text, "small diff");
});

test("truncateDiff: over budget is cut and flagged", () => {
  const big = "x".repeat(5000);
  const r = truncateDiff(big, 1000);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= 1000);
});

test("truncateDiff: empty input", () => {
  const r = truncateDiff("", 1000);
  assert.deepEqual(r, { text: "", truncated: false });
});

test("buildMrUserPrompt: includes ticket, branch, files, diff", () => {
  const prompt = buildMrUserPrompt(
    {
      ticketKey: "LPB-1234",
      ticketSummary: "Fix login",
      ticketDescription: "Users can't log in",
      sourceBranch: "bugfix/LPB-1234-fix-login",
      targetBranch: "main",
      changedFiles: ["src/auth.ts"],
      diff: "diff --git a/src/auth.ts b/src/auth.ts",
    },
    60000
  );
  assert.match(prompt, /LPB-1234/);
  assert.match(prompt, /Fix login/);
  assert.match(prompt, /bugfix\/LPB-1234-fix-login → main/);
  assert.match(prompt, /src\/auth\.ts/);
  assert.match(prompt, /```diff/);
});

test("buildMrUserPrompt: notes truncation when diff is large", () => {
  const prompt = buildMrUserPrompt(
    {
      ticketKey: "LPB-1",
      ticketSummary: "",
      ticketDescription: "",
      sourceBranch: "feature/LPB-1-x",
      targetBranch: "main",
      changedFiles: [],
      diff: "y".repeat(200000),
    },
    1000
  );
  assert.match(prompt, /truncated/i);
});

test("buildMrUserPrompt: omits empty ticket description cleanly", () => {
  const prompt = buildMrUserPrompt(
    {
      ticketKey: "LPB-9",
      ticketSummary: "Thing",
      ticketDescription: "   ",
      sourceBranch: "feature/LPB-9-thing",
      targetBranch: "develop",
      changedFiles: [],
      diff: "d",
    },
    60000
  );
  assert.doesNotMatch(prompt, /Ticket description/);
});

test("buildPlanUserPrompt: includes ticket + repo layout", () => {
  const prompt = buildPlanUserPrompt({
    ticketKey: "LPB-1234",
    summary: "Add rate limiting",
    description: "Throttle login attempts to 5/min",
    issueType: "Story",
    repoLayout: ["src/", "package.json", "README.md"],
  });
  assert.match(prompt, /LPB-1234/);
  assert.match(prompt, /Add rate limiting/);
  assert.match(prompt, /Throttle login attempts/);
  assert.match(prompt, /src\//);
});

test("buildPlanUserPrompt: handles missing description and empty layout", () => {
  const prompt = buildPlanUserPrompt({
    ticketKey: "LPB-9",
    summary: "Thing",
    description: "",
    issueType: "Task",
    repoLayout: [],
  });
  assert.match(prompt, /none provided/i);
  assert.match(prompt, /not available/i);
});

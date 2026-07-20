import { test } from "node:test";
import assert from "node:assert/strict";
import {
  truncateDiff,
  buildMrUserPrompt,
  buildPlanUserPrompt,
  buildTicketCheckUserPrompt,
  parseTicketCheckVerdict,
  buildStandupUserPrompt,
} from "../src/util/ai-prompt";

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

// ---- diff-vs-ticket check ---------------------------------------------------

test("buildTicketCheckUserPrompt: includes ticket and diff", () => {
  const prompt = buildTicketCheckUserPrompt(
    {
      ticketKey: "LPB-42",
      ticketSummary: "Add rate limiting",
      ticketDescription: "Throttle login attempts to 5/min",
      diff: "diff --git a/src/auth.ts b/src/auth.ts",
    },
    60000
  );
  assert.match(prompt, /LPB-42/);
  assert.match(prompt, /Add rate limiting/);
  assert.match(prompt, /Throttle login attempts/);
  assert.match(prompt, /```diff/);
});

test("buildTicketCheckUserPrompt: handles missing description", () => {
  const prompt = buildTicketCheckUserPrompt(
    { ticketKey: "LPB-9", ticketSummary: "Thing", ticketDescription: "", diff: "d" },
    60000
  );
  assert.match(prompt, /none provided/i);
});

test("buildTicketCheckUserPrompt: notes truncation when diff is large", () => {
  const prompt = buildTicketCheckUserPrompt(
    { ticketKey: "LPB-1", ticketSummary: "", ticketDescription: "", diff: "y".repeat(200000) },
    1000
  );
  assert.match(prompt, /truncated/i);
});

test("parseTicketCheckVerdict: recognizes a clean pass", () => {
  const r = parseTicketCheckVerdict("VERDICT: LOOKS COMPLETE\nHandles the throttling described in the ticket.");
  assert.equal(r.looksComplete, true);
  assert.match(r.detail, /throttling/);
});

test("parseTicketCheckVerdict: recognizes gaps and keeps the bullet list as detail", () => {
  const r = parseTicketCheckVerdict(
    "VERDICT: POSSIBLE GAPS\n- Ticket asks for a 5/min limit; diff only adds a 10/min limit.\n- No test for the throttle window."
  );
  assert.equal(r.looksComplete, false);
  assert.match(r.detail, /5\/min/);
  assert.match(r.detail, /No test/);
});

test("parseTicketCheckVerdict: missing/malformed verdict line defaults to gaps, not silently passing", () => {
  const r = parseTicketCheckVerdict("Some unexpected response shape.");
  assert.equal(r.looksComplete, false);
});

// ---- standup summary ---------------------------------------------------------

test("buildStandupUserPrompt: includes the date, each repo, ticket, and its commits", () => {
  const prompt = buildStandupUserPrompt({
    dateLabel: "Wed, Jul 16",
    repos: [
      {
        repoName: "loopline",
        groups: [
          { ticketKey: "LPB-1", subjects: ["add login", "add token refresh"] },
          { ticketKey: undefined, subjects: ["tidy up"] },
        ],
      },
    ],
  });
  assert.match(prompt, /Wed, Jul 16/);
  assert.match(prompt, /Repository: loopline/);
  assert.match(prompt, /LPB-1:/);
  assert.match(prompt, /- add login/);
  assert.match(prompt, /- add token refresh/);
  assert.match(prompt, /No ticket:/);
  assert.match(prompt, /- tidy up/);
});

test("buildStandupUserPrompt: multiple repos each get their own section", () => {
  const prompt = buildStandupUserPrompt({
    dateLabel: "Wed, Jul 16",
    repos: [
      { repoName: "api", groups: [{ ticketKey: "LPB-1", subjects: ["fix bug"] }] },
      { repoName: "web", groups: [{ ticketKey: "LPB-2", subjects: ["add page"] }] },
    ],
  });
  assert.match(prompt, /Repository: api/);
  assert.match(prompt, /Repository: web/);
  assert.match(prompt, /- fix bug/);
  assert.match(prompt, /- add page/);
});

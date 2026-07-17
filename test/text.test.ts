import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTicketKey,
  slugify,
  buildBranchName,
  parseBranchName,
  buildCommitMessage,
  renderTemplate,
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_COMMIT_TEMPLATE,
} from "../src/util/text";

test("extractTicketKey: bare key", () => {
  assert.equal(extractTicketKey("LPB-1234")?.key, "LPB-1234");
});

test("extractTicketKey: from a Jira URL", () => {
  assert.equal(
    extractTicketKey("https://acme.atlassian.net/browse/LPB-1234")?.key,
    "LPB-1234"
  );
});

test("extractTicketKey: lowercase input is normalised", () => {
  assert.equal(extractTicketKey("lpb-42")?.key, "LPB-42");
});

test("extractTicketKey: none present", () => {
  assert.equal(extractTicketKey("no ticket here"), undefined);
});

test("extractTicketKey: empty/falsy input returns undefined", () => {
  assert.equal(extractTicketKey(""), undefined);
});

test("parseBranchName: empty/falsy input returns undefined", () => {
  assert.equal(parseBranchName(""), undefined);
});

test("parseBranchName: a prefix with no ticket key in the rest returns undefined", () => {
  assert.equal(parseBranchName("feature/just-a-slug-no-ticket"), undefined);
});

test("slugify: basic", () => {
  assert.equal(slugify("Some summary issue"), "some-summary-issue");
});

test("slugify: strips punctuation and apostrophes", () => {
  assert.equal(slugify("Fix login button doesn't work!"), "fix-login-button-doesnt-work");
});

test("slugify: collapses whitespace and dashes", () => {
  assert.equal(slugify("a   --  b"), "a-b");
});

test("slugify: truncates on a word boundary", () => {
  const long = slugify("word ".repeat(40), 20);
  assert.ok(long.length <= 20);
  assert.ok(!long.endsWith("-"));
});

test("buildBranchName: bugfix", () => {
  assert.equal(
    buildBranchName("bugfix", "LPB-1234", "Some summary issue"),
    "bugfix/LPB-1234-some-summary-issue"
  );
});

test("buildBranchName: feature", () => {
  assert.equal(
    buildBranchName("feature", "LPB-1234", "Security issue"),
    "feature/LPB-1234-security-issue"
  );
});

test("parseBranchName: round-trips a generated name", () => {
  const parsed = parseBranchName("feature/LPB-1234-some-summary-issue");
  assert.deepEqual(parsed, {
    prefix: "feature",
    ticket: "LPB-1234",
    slug: "some-summary-issue",
  });
});

test("parseBranchName: non-matching branch returns undefined", () => {
  assert.equal(parseBranchName("random-branch"), undefined);
});

test("parseBranchName: prefix with no slug", () => {
  assert.deepEqual(parseBranchName("hotfix/ABC-9"), {
    prefix: "hotfix",
    ticket: "ABC-9",
    slug: "",
  });
});

test("buildCommitMessage: feat", () => {
  assert.equal(
    buildCommitMessage("feat", "LPB-1234", "some summary issue"),
    "feat: LPB-1234 some summary issue"
  );
});

test("buildCommitMessage: normalises internal whitespace", () => {
  assert.equal(
    buildCommitMessage("fix", "ABC-1", "  too   many   spaces  "),
    "fix: ABC-1 too many spaces"
  );
});

// ---- templates ---------------------------------------------------------------

test("renderTemplate: substitutes known tokens", () => {
  assert.equal(
    renderTemplate("{a}/{b}-{c}", { a: "x", b: "y", c: "z" }),
    "x/y-z"
  );
});

test("renderTemplate: leaves unknown tokens untouched rather than dropping them", () => {
  assert.equal(renderTemplate("{a}/{unknown}", { a: "x" }), "x/{unknown}");
});

test("buildBranchName: default template matches the original hardcoded shape", () => {
  assert.equal(
    buildBranchName("bugfix", "LPB-1234", "Some summary issue", DEFAULT_BRANCH_TEMPLATE),
    "bugfix/LPB-1234-some-summary-issue"
  );
});

test("buildBranchName: default template drops the separator when the slug is empty", () => {
  assert.equal(buildBranchName("hotfix", "ABC-9", "   "), "hotfix/ABC-9");
});

test("buildBranchName: a custom template can reorder or reshape the pieces", () => {
  assert.equal(
    buildBranchName("feature", "LPB-1", "Add login", "{ticket}_{slug}"),
    "LPB-1_add-login"
  );
  assert.equal(
    buildBranchName("feature", "LPB-1", "Add login", "{prefix}/{ticket}"),
    "feature/LPB-1"
  );
});

test("buildCommitMessage: default template matches the original hardcoded shape", () => {
  assert.equal(
    buildCommitMessage("feat", "LPB-1234", "some summary issue", DEFAULT_COMMIT_TEMPLATE),
    "feat: LPB-1234 some summary issue"
  );
});

test("buildCommitMessage: a custom template can use a bracket style", () => {
  assert.equal(
    buildCommitMessage("feat", "LPB-1", "add login", "[{ticket}] {summary}"),
    "[LPB-1] add login"
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTicketKey,
  slugify,
  buildBranchName,
  parseBranchName,
  buildCommitMessage,
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

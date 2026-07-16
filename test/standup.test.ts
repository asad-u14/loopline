import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCommitsByTicket, formatStandupFallback, startOfDay } from "../src/util/standup";

test("groupCommitsByTicket: groups by the ticket key found in each subject", () => {
  const groups = groupCommitsByTicket([
    "feat: LPB-1 add login",
    "feat: LPB-1 add token refresh",
    "fix: LPB-2 correct redirect",
  ]);
  assert.deepEqual(
    groups.map((g) => g.ticketKey),
    ["LPB-1", "LPB-2"]
  );
  assert.equal(groups[0].subjects.length, 2);
  assert.equal(groups[1].subjects.length, 1);
});

test("groupCommitsByTicket: commits with no recognizable key land in one undefined group", () => {
  const groups = groupCommitsByTicket(["chore: tidy up", "docs: fix typo"]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ticketKey, undefined);
  assert.equal(groups[0].subjects.length, 2);
});

test("groupCommitsByTicket: preserves order of first appearance", () => {
  const groups = groupCommitsByTicket([
    "feat: LPB-2 second ticket first",
    "feat: LPB-1 first ticket second",
    "feat: LPB-2 second ticket again",
  ]);
  assert.deepEqual(
    groups.map((g) => g.ticketKey),
    ["LPB-2", "LPB-1"]
  );
});

test("groupCommitsByTicket: empty input yields no groups", () => {
  assert.deepEqual(groupCommitsByTicket([]), []);
});

test("formatStandupFallback: lists each group with a commit count and bullets", () => {
  const text = formatStandupFallback([
    { ticketKey: "LPB-1", subjects: ["add login", "add token refresh"] },
    { ticketKey: undefined, subjects: ["tidy up"] },
  ]);
  assert.match(text, /\*\*LPB-1\*\* \(2 commits\)/);
  assert.match(text, /- add login/);
  assert.match(text, /\*\*Other\*\* \(1 commit\)/);
});

test("formatStandupFallback: singular commit count isn't pluralized", () => {
  const text = formatStandupFallback([{ ticketKey: "LPB-1", subjects: ["add login"] }]);
  assert.match(text, /\(1 commit\)/);
  assert.doesNotMatch(text, /\(1 commits\)/);
});

test("formatStandupFallback: no groups reports nothing to summarize, not an empty document", () => {
  assert.equal(formatStandupFallback([]), "No commits to summarize.");
});

test("startOfDay: zeroes out the time, keeps the calendar date", () => {
  const now = new Date(2026, 6, 16, 14, 30, 0);
  const start = startOfDay(now);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 6);
  assert.equal(start.getDate(), 16);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
});

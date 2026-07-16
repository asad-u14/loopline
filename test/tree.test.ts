import { test } from "node:test";
import assert from "node:assert/strict";
import {
  iconForType,
  colorForType,
  keyFromArg,
  scopeSectionLabel,
  nextScope,
  branchMatchesTicket,
  mapTicketBranches,
  relativeTime,
  notablePriority,
  groupIssuesByStatus,
  shouldGroupByStatus,
  statusCategoryRank,
  ticketFromArg,
} from "../src/util/tree-helpers";

test("iconForType: maps common Jira types", () => {
  assert.equal(iconForType("Bug"), "bug");
  assert.equal(iconForType("Story"), "book");
  assert.equal(iconForType("Epic"), "milestone");
  assert.equal(iconForType("Sub-task"), "list-tree");
  assert.equal(iconForType("Task"), "issue-opened");
  assert.equal(iconForType(""), "issue-opened");
});

test("colorForType: maps common Jira types to distinct theme colors", () => {
  assert.equal(colorForType("Bug"), "charts.red");
  assert.equal(colorForType("Story"), "charts.green");
  assert.equal(colorForType("Epic"), "charts.purple");
  assert.equal(colorForType("Sub-task"), "charts.orange");
  assert.equal(colorForType("Task"), "charts.blue");
  assert.equal(colorForType(""), "charts.blue");
});

test("keyFromArg: extracts from node or string", () => {
  assert.equal(keyFromArg({ issue: { key: "LPB-1" } }), "LPB-1");
  assert.equal(keyFromArg("LPB-2"), "LPB-2");
  assert.equal(keyFromArg(undefined), undefined);
  assert.equal(keyFromArg({}), undefined);
});

test("scopeSectionLabel: reflects the active scope", () => {
  assert.equal(scopeSectionLabel("activeSprint"), "My Active Sprint");
  assert.equal(scopeSectionLabel("allOpen"), "All Open Tickets");
});

test("scopeSectionLabel: tells the truth when the sprint filter fell back", () => {
  // Board has no sprints -> we actually show all open, so don't claim "sprint".
  assert.equal(scopeSectionLabel("activeSprint", false), "All Open Tickets (no sprints)");
});

test("scopeSectionLabel: allOpen is unaffected by the sprint flag", () => {
  assert.equal(scopeSectionLabel("allOpen", false), "All Open Tickets");
});

test("nextScope: toggles both ways", () => {
  assert.equal(nextScope("activeSprint"), "allOpen");
  assert.equal(nextScope("allOpen"), "activeSprint");
});

test("nextScope: is its own inverse", () => {
  assert.equal(nextScope(nextScope("activeSprint")), "activeSprint");
});

// ---- branch matching (regression: substring false-positives) ----------------

test("branchMatchesTicket: matches a real branch for the key", () => {
  assert.equal(branchMatchesTicket("feature/LPB-1234-do-a-thing", "LPB-1234"), true);
  assert.equal(branchMatchesTicket("bugfix/lpb-1234-x", "LPB-1234"), true, "case-insensitive");
  assert.equal(branchMatchesTicket("LPB-1234", "LPB-1234"), true, "bare key");
});

test("branchMatchesTicket: LPB-1 must NOT match an LPB-12 branch", () => {
  // The old substring check reported a false positive here.
  assert.equal(branchMatchesTicket("feature/LPB-12-x", "LPB-1"), false);
  assert.equal(branchMatchesTicket("feature/LPB-1234-x", "LPB-1"), false);
  assert.equal(branchMatchesTicket("feature/LPB-1-x", "LPB-1"), true);
});

test("branchMatchesTicket: different project key doesn't match", () => {
  assert.equal(branchMatchesTicket("feature/ABC-1-x", "LPB-1"), false);
});

test("branchMatchesTicket: empty inputs are safe", () => {
  assert.equal(branchMatchesTicket("", "LPB-1"), false);
  assert.equal(branchMatchesTicket("feature/LPB-1", ""), false);
});

test("mapTicketBranches: maps only keys that have branches", () => {
  const map = mapTicketBranches(
    ["main", "feature/LPB-1-a", "bugfix/LPB-1-b", "feature/LPB-2-c"],
    ["LPB-1", "LPB-2", "LPB-3"]
  );
  assert.deepEqual(map["LPB-1"], ["feature/LPB-1-a", "bugfix/LPB-1-b"]);
  assert.deepEqual(map["LPB-2"], ["feature/LPB-2-c"]);
  assert.equal(map["LPB-3"], undefined);
});

// ---- relative time ---------------------------------------------------------

test("relativeTime: formats compact ages", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(relativeTime(ago(30 * 1000), now), "just now");
  assert.equal(relativeTime(ago(5 * 60 * 1000), now), "5m");
  assert.equal(relativeTime(ago(3 * 3600 * 1000), now), "3h");
  assert.equal(relativeTime(ago(2 * 86400 * 1000), now), "2d");
  assert.equal(relativeTime(ago(21 * 86400 * 1000), now), "3w");
});

test("relativeTime: missing/invalid input returns undefined, not a guess", () => {
  assert.equal(relativeTime(undefined), undefined);
  assert.equal(relativeTime("not-a-date"), undefined);
});

test("relativeTime: future timestamps don't render negatives", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  assert.equal(relativeTime(new Date(now.getTime() + 60000).toISOString(), now), "just now");
});

// ---- priority --------------------------------------------------------------

test("notablePriority: hides the noisy defaults", () => {
  assert.equal(notablePriority("Medium"), undefined);
  assert.equal(notablePriority("None"), undefined);
  assert.equal(notablePriority(undefined), undefined);
  assert.equal(notablePriority("  "), undefined);
});

test("notablePriority: surfaces meaningful values", () => {
  assert.equal(notablePriority("Highest"), "Highest");
  assert.equal(notablePriority("Low"), "Low");
});

// ---- status grouping -------------------------------------------------------

const issue = (status: string, statusCategory?: string) => ({ status, statusCategory });

test("groupIssuesByStatus: orders In Progress, then To Do, then Done", () => {
  const groups = groupIssuesByStatus([
    issue("Done", "done"),
    issue("To Do", "new"),
    issue("In Progress", "indeterminate"),
  ]);
  assert.deepEqual(groups.map((g) => g.status), ["In Progress", "To Do", "Done"]);
});

test("groupIssuesByStatus: collects issues under their status", () => {
  const groups = groupIssuesByStatus([
    issue("To Do", "new"),
    issue("To Do", "new"),
    issue("In Review", "indeterminate"),
  ]);
  assert.equal(groups[0].status, "In Review");
  assert.equal(groups[1].issues.length, 2);
});

test("groupIssuesByStatus: same category sorts alphabetically", () => {
  const groups = groupIssuesByStatus([
    issue("In Review", "indeterminate"),
    issue("In Progress", "indeterminate"),
  ]);
  assert.deepEqual(groups.map((g) => g.status), ["In Progress", "In Review"]);
});

test("groupIssuesByStatus: unknown category sorts last", () => {
  const groups = groupIssuesByStatus([issue("Weird"), issue("To Do", "new")]);
  assert.deepEqual(groups.map((g) => g.status), ["To Do", "Weird"]);
});

test("groupIssuesByStatus: missing status is labelled, not dropped", () => {
  const groups = groupIssuesByStatus([issue("")]);
  assert.equal(groups[0].status, "No status");
  assert.equal(groups[0].issues.length, 1);
});

test("statusCategoryRank: In Progress ranks first so only it expands by default", () => {
  assert.equal(statusCategoryRank("indeterminate"), 0);
  assert.equal(statusCategoryRank("new"), 1);
  assert.equal(statusCategoryRank("done"), 2);
  assert.equal(statusCategoryRank(undefined), 3);
});

test("shouldGroupByStatus: only when there's more than one status", () => {
  assert.equal(shouldGroupByStatus([issue("To Do"), issue("Done")]), true);
  assert.equal(shouldGroupByStatus([issue("To Do"), issue("To Do")]), false);
  assert.equal(shouldGroupByStatus([]), false);
});

// ---- ticketFromArg ---------------------------------------------------------

test("ticketFromArg: extracts known fields from a tree node", () => {
  const node = {
    t: "ticket",
    grouped: true,
    issue: { key: "LPB-1", summary: "Add login", issueType: "Story", status: "In Progress" },
  };
  assert.deepEqual(ticketFromArg(node), {
    key: "LPB-1",
    summary: "Add login",
    issueType: "Story",
    status: "In Progress",
  });
});

test("ticketFromArg: accepts a bare key string", () => {
  assert.deepEqual(ticketFromArg("LPB-2"), { key: "LPB-2" });
});

test("ticketFromArg: rejects junk without throwing", () => {
  assert.equal(ticketFromArg(undefined), undefined);
  assert.equal(ticketFromArg({}), undefined);
  assert.equal(ticketFromArg({ issue: {} }), undefined);
  assert.equal(ticketFromArg(""), undefined);
});

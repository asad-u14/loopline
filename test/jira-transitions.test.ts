import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTransition, describeTransitions } from "../src/util/jira-transitions";

const transitions = [
  { id: "11", name: "Start Progress", toStatus: "In Progress" },
  { id: "21", name: "Ready for Review", toStatus: "In Review" },
  { id: "31", name: "Done", toStatus: "Done" },
];

test("pickTransition: matches by target status name", () => {
  assert.equal(pickTransition(transitions, "In Progress")?.id, "11");
});

test("pickTransition: case-insensitive status match", () => {
  assert.equal(pickTransition(transitions, "in review")?.id, "21");
});

test("pickTransition: matches by transition name when status doesn't match", () => {
  assert.equal(pickTransition(transitions, "Start Progress")?.id, "11");
});

test("pickTransition: partial match falls through", () => {
  assert.equal(pickTransition(transitions, "review")?.id, "21");
});

test("pickTransition: empty target returns undefined", () => {
  assert.equal(pickTransition(transitions, ""), undefined);
});

test("pickTransition: no match returns undefined", () => {
  assert.equal(pickTransition(transitions, "Deployed"), undefined);
});

test("describeTransitions: lists destination statuses", () => {
  assert.equal(describeTransitions(transitions), "In Progress, In Review, Done");
});

test("describeTransitions: empty list", () => {
  assert.equal(describeTransitions([]), "(none available)");
});

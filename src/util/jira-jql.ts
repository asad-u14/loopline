/**
 * Pure builder for the "my issues" JQL used by the create-branch picker.
 * Kept vscode/network-free so it's unit-testable.
 */
export function buildMyIssuesJql(activeSprintOnly: boolean): string {
  const clauses = ["assignee = currentUser()"];
  if (activeSprintOnly) {
    clauses.push("sprint in openSprints()");
  }
  clauses.push("resolution = Unresolved");
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

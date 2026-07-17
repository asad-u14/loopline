// Minimal stand-in for the "vscode" module, which only exists inside the real
// extension host. Plain `node --test` can't resolve it at all, which blocks
// loading any file that imports it — even transitively, even if the specific
// code path under test never touches a real vscode API.
//
// This is intentionally empty: the service classes exercised by these tests
// only reach vscode-importing modules (log.ts, progress.ts) through helpers
// (log/logError, OperationCancelled/isCancelled) that never call into
// `vscode.*` themselves — only the functions this stub does NOT need to
// support (initLog, withCancellableProgress) do. If a future test needs one
// of those, add the specific surface here rather than guessing ahead of time.
module.exports = {};

// Type augmentation for the test-only control surface bolted onto the vscode
// stub (test/support/vscode-stub.js). TypeScript type-checks `import "vscode"`
// against the real @types/vscode ambient declarations (the runtime module is
// swapped for the stub via test/support/register-vscode-stub.js), so these
// extra members need to be declared here or every test file referencing them
// fails to compile.
declare module "vscode" {
  /** Restore every overridable vscode.* surface + shared mutable state to fresh defaults. */
  export function __resetVscodeMock(): void;

  /** Bulk-set global config values for a section, e.g. __setConfig("loopline", {"jira.baseUrl": "..."}). */
  export function __setConfig(section: string, values: Record<string, unknown>): void;

  /** vscode.workspace.workspaceFolders is read-only in the real API; use this to set it in tests. */
  export function __setWorkspaceFolders(folders: readonly WorkspaceFolder[] | undefined): void;

  /** vscode.window.activeTextEditor is read-only in the real API; use this to set it in tests. */
  export function __setActiveTextEditor(editor: TextEditor | undefined): void;

  export function __makeWebviewPanel(viewType: string, title: string): WebviewPanel;
  export function __makeFileSystemWatcher(): FileSystemWatcher;
}

import * as vscode from "vscode";

/** In-memory Memento (globalState/workspaceState) backing store. */
function makeMemento() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return store.has(key) ? (store.get(key) as T) : (defaultValue as T);
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
    keys(): readonly string[] {
      return [...store.keys()];
    },
  };
}

/** In-memory SecretStorage. */
function makeSecrets() {
  const store = new Map<string, string>();
  const emitter = new vscode.EventEmitter<{ key: string }>();
  return {
    async get(key: string): Promise<string | undefined> {
      return store.get(key);
    },
    async store(key: string, value: string): Promise<void> {
      store.set(key, value);
      emitter.fire({ key });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
      emitter.fire({ key });
    },
    onDidChange: emitter.event,
  };
}

/** A minimal but functionally real vscode.ExtensionContext for unit tests. */
export function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: makeMemento(),
    workspaceState: makeMemento(),
    secrets: makeSecrets(),
    extensionUri: vscode.Uri.file("/mock/extension"),
    extensionPath: "/mock/extension",
    globalStorageUri: vscode.Uri.file("/mock/global-storage"),
    logUri: vscode.Uri.file("/mock/log"),
    storageUri: vscode.Uri.file("/mock/storage"),
  } as unknown as vscode.ExtensionContext;
}

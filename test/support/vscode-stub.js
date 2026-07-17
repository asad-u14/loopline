// Stand-in for the "vscode" module, which only exists inside the real extension
// host. Plain `node --test` can't resolve it at all, which blocks loading any
// file that imports it — even transitively.
//
// Every vscode.* surface actually used by src/ is implemented here as a plain,
// overridable object: tests reassign e.g. `vscode.window.showQuickPick` to a
// fresh function per-scenario, then call `vscode.__resetVscodeMock()` (in
// beforeEach) to restore defaults so state never leaks between tests.

// ---- enums -----------------------------------------------------------------

const StatusBarAlignment = { Left: 1, Right: 2 };
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// ---- simple value classes ----------------------------------------------------

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => {
        const i = this._listeners.indexOf(listener);
        if (i >= 0) this._listeners.splice(i, 1);
      } };
    };
  }
  fire(data) {
    for (const l of [...this._listeners]) {
      l(data);
    }
  }
  dispose() {
    this._listeners = [];
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class Uri {
  constructor(value) {
    this._value = value;
  }
  static parse(value) {
    const u = new Uri(value);
    try {
      const parsed = new URL(value);
      u.scheme = parsed.protocol.replace(/:$/, "");
      u.fsPath = decodeURIComponent(parsed.pathname);
      u.path = u.fsPath;
    } catch {
      u.scheme = "file";
      u.fsPath = value;
      u.path = value;
    }
    return u;
  }
  static file(fsPath) {
    const u = new Uri(fsPath);
    u.scheme = "file";
    u.fsPath = fsPath;
    u.path = fsPath;
    return u;
  }
  toString() {
    return this._value;
  }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new EventEmitter();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this._emitter.event,
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }
  dispose() {
    this._emitter.dispose();
  }
}

// ---- configuration store -----------------------------------------------------
// section -> dottedKey -> { globalValue, workspaceValue, workspaceFolderValue }

let configStore = {};

function slotFor(section, key) {
  configStore[section] = configStore[section] || {};
  configStore[section][key] = configStore[section][key] || {};
  return configStore[section][key];
}

function makeConfiguration(section) {
  return {
    get(key, defaultValue) {
      const slot = configStore[section]?.[key];
      if (slot) {
        if (slot.workspaceFolderValue !== undefined) return slot.workspaceFolderValue;
        if (slot.workspaceValue !== undefined) return slot.workspaceValue;
        if (slot.globalValue !== undefined) return slot.globalValue;
      }
      return defaultValue;
    },
    has(key) {
      return !!configStore[section]?.[key];
    },
    inspect(key) {
      const slot = configStore[section]?.[key] || {};
      return {
        key,
        globalValue: slot.globalValue,
        workspaceValue: slot.workspaceValue,
        workspaceFolderValue: slot.workspaceFolderValue,
      };
    },
    async update(key, value, target) {
      const slot = slotFor(section, key);
      const t = target ?? ConfigurationTarget.Global;
      if (t === ConfigurationTarget.WorkspaceFolder) {
        slot.workspaceFolderValue = value;
      } else if (t === ConfigurationTarget.Workspace) {
        slot.workspaceValue = value;
      } else {
        slot.globalValue = value;
      }
    },
  };
}

/** Test helper: bulk-set global values for a section, e.g. __setConfig("loopline", {"jira.baseUrl": "..."}). */
function __setConfig(section, values) {
  for (const [key, value] of Object.entries(values)) {
    slotFor(section, key).globalValue = value;
  }
}

// ---- output channel / status bar / webview mocks -----------------------------

function makeOutputChannel(name) {
  return {
    name,
    lines: [],
    appendLine(s) {
      this.lines.push(s);
    },
    append(s) {
      this.lines.push(s);
    },
    clear() {
      this.lines = [];
    },
    show() {},
    hide() {},
    dispose() {},
  };
}

function makeStatusBarItem() {
  return {
    text: "",
    tooltip: undefined,
    command: undefined,
    alignment: undefined,
    priority: undefined,
    shown: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    dispose() {},
  };
}

function makeWebview() {
  const listeners = [];
  return {
    html: "",
    _postedMessages: [],
    postMessage(msg) {
      this._postedMessages.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage(cb) {
      listeners.push(cb);
      return { dispose() {} };
    },
    /** Test helper: simulate the webview posting a message back to the extension. */
    _receiveMessage(msg) {
      for (const l of listeners) l(msg);
    },
    asWebviewUri(uri) {
      return uri;
    },
    cspSource: "vscode-resource:",
  };
}

function makeWebviewPanel(viewType, title) {
  const disposeListeners = [];
  return {
    viewType,
    title,
    webview: makeWebview(),
    visible: true,
    active: true,
    onDidDispose(cb) {
      disposeListeners.push(cb);
      return { dispose() {} };
    },
    reveal() {},
    dispose() {
      for (const l of disposeListeners) l();
    },
  };
}

function makeFileSystemWatcher() {
  const changeListeners = [];
  const createListeners = [];
  const deleteListeners = [];
  return {
    onDidChange(cb) {
      changeListeners.push(cb);
      return { dispose() {} };
    },
    onDidCreate(cb) {
      createListeners.push(cb);
      return { dispose() {} };
    },
    onDidDelete(cb) {
      deleteListeners.push(cb);
      return { dispose() {} };
    },
    /** Test helpers to simulate filesystem events. */
    _change(uri) {
      for (const l of changeListeners) l(uri);
    },
    _create(uri) {
      for (const l of createListeners) l(uri);
    },
    _delete(uri) {
      for (const l of deleteListeners) l(uri);
    },
    dispose() {},
  };
}

// ---- commands registry --------------------------------------------------------

let commandRegistry = new Map();

// ---- default (overridable) implementations -----------------------------------

function defaultWindow() {
  return {
    activeTextEditor: undefined,

    createStatusBarItem() {
      return makeStatusBarItem();
    },
    createOutputChannel(name) {
      return makeOutputChannel(name);
    },
    createWebviewPanel(viewType, title) {
      return makeWebviewPanel(viewType, title);
    },
    registerTreeDataProvider() {
      return { dispose() {} };
    },
    onDidChangeActiveTextEditor() {
      return { dispose() {} };
    },
    onDidChangeWindowState() {
      return { dispose() {} };
    },
    setStatusBarMessage() {
      return { dispose() {} };
    },
    async showInformationMessage() {
      return undefined;
    },
    async showWarningMessage() {
      return undefined;
    },
    async showErrorMessage() {
      return undefined;
    },
    async showInputBox() {
      return undefined;
    },
    async showQuickPick() {
      return undefined;
    },
    async showTextDocument(doc) {
      return { document: doc };
    },
    async withProgress(_options, fn) {
      const progress = { report() {} };
      const source = new CancellationTokenSource();
      return fn(progress, source.token);
    },
  };
}

function defaultWorkspace() {
  return {
    workspaceFolders: undefined,
    getConfiguration(section) {
      return makeConfiguration(section);
    },
    createFileSystemWatcher() {
      return makeFileSystemWatcher();
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    },
    onDidChangeWorkspaceFolders() {
      return { dispose() {} };
    },
    async openTextDocument(arg) {
      if (typeof arg === "string") {
        const fs = require("fs");
        let text = "";
        try {
          text = fs.readFileSync(arg, "utf8");
        } catch {
          /* file may not exist yet */
        }
        return {
          uri: Uri.file(arg),
          fileName: arg,
          getText: () => text,
        };
      }
      let text = arg?.content ?? "";
      return {
        uri: Uri.parse("untitled:Untitled"),
        fileName: "untitled",
        languageId: arg?.language,
        getText: () => text,
        _setText: (t) => {
          text = t;
        },
      };
    },
  };
}

function defaultEnv() {
  return {
    clipboard: {
      _text: "",
      async writeText(s) {
        this._text = s;
      },
      async readText() {
        return this._text;
      },
    },
    async openExternal() {
      return true;
    },
    version: "1.0.0-test",
  };
}

function defaultCommands() {
  return {
    registerCommand(id, callback) {
      commandRegistry.set(id, callback);
      return { dispose: () => commandRegistry.delete(id) };
    },
    async executeCommand(id, ...args) {
      const cb = commandRegistry.get(id);
      if (cb) {
        return cb(...args);
      }
      return undefined;
    },
  };
}

const window = defaultWindow();
const workspace = defaultWorkspace();
const env = defaultEnv();
const commands = defaultCommands();

/** Restore every overridable surface + shared mutable state to fresh defaults. */
function __resetVscodeMock() {
  Object.assign(window, defaultWindow());
  Object.assign(workspace, defaultWorkspace());
  Object.assign(env, defaultEnv());
  commandRegistry = new Map();
  Object.assign(commands, defaultCommands());
  configStore = {};
}

/** vscode.workspace.workspaceFolders is read-only in the real API; tests use this instead. */
function __setWorkspaceFolders(folders) {
  workspace.workspaceFolders = folders;
}

/** vscode.window.activeTextEditor is read-only in the real API; tests use this instead. */
function __setActiveTextEditor(editor) {
  window.activeTextEditor = editor;
}

module.exports = {
  window,
  workspace,
  commands,
  env,
  version: "1.0.0-test",

  EventEmitter,
  ThemeIcon,
  ThemeColor,
  TreeItem,
  RelativePattern,
  Uri,
  CancellationTokenSource,

  StatusBarAlignment,
  TreeItemCollapsibleState,
  ViewColumn,
  ProgressLocation,
  ConfigurationTarget,

  __resetVscodeMock,
  __setConfig,
  __setWorkspaceFolders,
  __setActiveTextEditor,
  __makeWebviewPanel: makeWebviewPanel,
  __makeFileSystemWatcher: makeFileSystemWatcher,
};

// Loaded via `node --require` before the test run starts. Redirects any
// `require("vscode")` to the stub, since no real "vscode" package is installed
// (only @types/vscode, which is types-only and has no runtime module).
const Module = require("module");
const path = require("path");

const stubPath = path.join(__dirname, "vscode-stub.js");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return stubPath;
  }
  return originalResolveFilename.call(this, request, ...rest);
};

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("Loopline");
  ctx.subscriptions.push(channel);
}

function stamp(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  channel?.appendLine(`[${stamp()}] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const detail = err ? ` — ${(err as Error)?.message ?? String(err)}` : "";
  channel?.appendLine(`[${stamp()}] ERROR: ${message}${detail}`);
}

export function showLog(): void {
  channel?.show(true);
}

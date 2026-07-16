import * as vscode from "vscode";

/** Thrown when the user cancels a long-running operation. Callers should swallow it quietly. */
export class OperationCancelled extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "OperationCancelled";
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof OperationCancelled;
}

/**
 * Run `fn` inside a cancellable notification progress. An AbortSignal is provided
 * and wired to the Cancel button so network requests (axios) actually abort.
 * If the user cancels, OperationCancelled is thrown.
 */
export function withCancellableProgress<T>(
  title: string,
  fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        return await fn(controller.signal, (message) => progress.report({ message }));
      } finally {
        sub.dispose();
      }
    }
  );
}

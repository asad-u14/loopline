import * as fs from "fs";
import * as path from "path";

const SKIP = new Set(["node_modules", ".git", "out", "out-test", "dist", "build", "target", ".vscode-test"]);

/** Shallow, top-level repo entries (names only) for lightly grounding the AI. */
export function topLevelEntries(repoRoot: string, max = 50): string[] {
  try {
    return fs
      .readdirSync(repoRoot, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") || d.name === ".github")
      .filter((d) => !SKIP.has(d.name))
      .slice(0, max)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
  } catch {
    return [];
  }
}

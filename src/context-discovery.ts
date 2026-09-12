import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

const names = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
export const skippedContextDirectories = new Set([
  ".git", ".hg", ".svn", ".devspace", "node_modules", "dist", "build",
  ".next", ".turbo", ".cache", ".build", ".swiftpm", ".gradle",
  "DerivedData", "Pods", "Carthage", ".venv", "venv", "__pycache__",
]);

// This is an advisory index, not instruction loading. Never block workspace
// creation on an exhaustive repository walk. Do not follow directory symlinks.
export async function discoverContextFiles(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("rg", ["--files", "--hidden", "--no-ignore", "--null",
      ...[...names].flatMap((name) => ["-g", name]),
      ...[...skippedContextDirectories].flatMap((name) => ["-g", `!**/${name}/**`]),
      "--", root,
    ], { timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error && "code" in error && error.code === "ENOENT") {
        void discoverContextFilesFallback(root).then(resolve);
        return;
      }
      // Only accept complete NUL-delimited records if a budget killed rg.
      resolve(stdout.split("\0").slice(0, -1).slice(0, 512));
    });
  });
}

export async function discoverContextFilesFallback(
  root: string,
  budget = { maxEntries: 20_000, maxFiles: 512, timeoutMs: 2_000 },
): Promise<string[]> {
  const paths: string[] = [];
  const pending = [root];
  const deadline = performance.now() + budget.timeoutMs;
  let entriesSeen = 0;
  while (pending.length && entriesSeen < budget.maxEntries && performance.now() < deadline) {
    const directory = pending.pop()!;
    try {
      for await (const entry of await opendir(directory)) {
        if (++entriesSeen > budget.maxEntries || performance.now() >= deadline) return paths;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !skippedContextDirectories.has(entry.name)) pending.push(path);
        if (entry.isFile() && names.has(entry.name)) paths.push(path);
        if (paths.length >= budget.maxFiles) return paths;
      }
    } catch { /* Unreadable or disappearing directories do not block opening. */ }
  }
  return paths;
}

import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await chmod(resolve(repositoryRoot, "dist", "cli.js"), 0o755);

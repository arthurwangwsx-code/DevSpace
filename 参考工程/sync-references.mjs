#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(root, "sources.lock.json"), "utf8"));
let failed = false;

function git(args, cwd = root) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

for (const repository of lock.repositories) {
  const destination = join(root, repository.name);
  if (existsSync(join(destination, ".git"))) {
    const head = git(["rev-parse", "HEAD"], destination);
    const current = head.stdout.trim();
    if (head.status === 0 && current === repository.commit) {
      console.log(`ok      ${repository.name} ${current.slice(0, 12)}`);
      continue;
    }
    console.error(
      `mismatch ${repository.name}: expected ${repository.commit}, found ${current || "unknown"}; preserving the existing checkout`,
    );
    failed = true;
    continue;
  }

  if (existsSync(destination)) {
    console.error(`blocked  ${repository.name}: destination exists but is not a Git checkout`);
    failed = true;
    continue;
  }

  const init = git(["init", destination]);
  const remote = git(["remote", "add", "origin", repository.url], destination);
  const fetch = git(["fetch", "--depth", "1", "origin", repository.commit], destination);
  const checkout = git(["checkout", "--detach", "FETCH_HEAD"], destination);
  if ([init, remote, fetch, checkout].some((result) => result.status !== 0)) {
    console.error(`failed   ${repository.name}`);
    for (const result of [init, remote, fetch, checkout]) {
      if (result.status !== 0) console.error(result.stderr.trim());
    }
    failed = true;
  } else {
    console.log(`cloned  ${repository.name} ${repository.commit.slice(0, 12)}`);
  }
}

process.exitCode = failed ? 1 : 0;

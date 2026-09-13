#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionId = process.argv[2]?.trim();
if (!extensionId) {
  console.error("Usage: node native-host/install.mjs <chrome-extension-id>");
  process.exit(2);
}
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error("Chrome extension id must be 32 lowercase letters in the range a-p.");
  process.exit(2);
}
if (process.platform !== "darwin") {
  console.error("The initial installer currently supports macOS only.");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const host = path.join(here, "devspace-browser-native-host.mjs");
const installRoot = process.env.DEVSPACE_BROWSER_NATIVE_HOST_DIR
  || path.join(os.homedir(), "Library", "Application Support", "DevSpace", "native-host");
const installedHost = path.join(installRoot, "devspace-browser-native-host.mjs");
const launcher = path.join(installRoot, "devspace-browser-native-host");
fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
fs.copyFileSync(host, installedHost);
fs.chmodSync(installedHost, 0o600);
fs.writeFileSync(
  launcher,
  `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(installedHost)}\n`,
  { mode: 0o700 },
);

const directory = process.env.DEVSPACE_CHROME_NATIVE_HOSTS_DIR
  || path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = path.join(directory, "com.devspace.browser_bridge.json");
fs.writeFileSync(target, JSON.stringify({
  name: "com.devspace.browser_bridge",
  description: "DevSpace browser extension native messaging bridge",
  path: launcher,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2) + "\n", { mode: 0o600 });
console.log(target);

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

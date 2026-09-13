import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function browserControlShouldEnable(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.DEVSPACE_BROWSER_EXTENSION === "0") return false;
  if (environment.DEVSPACE_BROWSER_EXTENSION === "1") return true;
  if (environment.DEVSPACE_CHROME_NATIVE_HOST_MANIFEST) {
    return existsSync(environment.DEVSPACE_CHROME_NATIVE_HOST_MANIFEST);
  }
  if (process.platform !== "darwin") return false;
  const home = environment.HOME || homedir();
  const manifest = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    "com.devspace.browser_bridge.json",
  );
  return existsSync(manifest);
}

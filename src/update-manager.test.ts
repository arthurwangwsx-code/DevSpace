import assert from "node:assert/strict";
import { validateManifest } from "./update-manager.js";

const manifest = validateManifest({
  schemaVersion: 1,
  version: "1.2.0",
  tag: "v1.2.0",
  channel: "stable",
  minimumMacOS: "13.0",
  artifacts: {
    "darwin-arm64": {
      name: "DevSpace-macOS-arm64-v1.2.0.zip",
      url: "https://example.test/DevSpace.zip",
      sha256: "a".repeat(64),
    },
  },
});
assert.equal(manifest.version, "1.2.0");
assert.throws(() => validateManifest({ schemaVersion: 2 }), /Unsupported/);
assert.throws(() => validateManifest({ ...manifest, artifacts: { bad: { name: "x", url: "x", sha256: "no" } } }), /Invalid release artifact/);
console.log("update manager manifest tests passed");

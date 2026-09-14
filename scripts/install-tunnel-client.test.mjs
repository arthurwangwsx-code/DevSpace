import assert from "node:assert/strict";
import { checksumFor, selectReleaseAsset } from "./install-tunnel-client.mjs";

const release = {
  tag_name: "v9.8.7",
  assets: [
    { name: "tunnel-client-v9.8.7-darwin-arm64.zip", browser_download_url: "https://example.test/arm.zip" },
    { name: "tunnel-client-v9.8.7-darwin-amd64.zip", browser_download_url: "https://example.test/amd.zip" },
    { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/SHA256SUMS.txt" },
  ],
};

assert.equal(selectReleaseAsset(release, "darwin", "arm64").archive.name, "tunnel-client-v9.8.7-darwin-arm64.zip");
assert.equal(selectReleaseAsset(release, "darwin", "x64").archive.name, "tunnel-client-v9.8.7-darwin-amd64.zip");
assert.equal(checksumFor(`${"a".repeat(64)}  tunnel-client-v9.8.7-darwin-arm64.zip\n`, "tunnel-client-v9.8.7-darwin-arm64.zip"), "a".repeat(64));
assert.throws(() => selectReleaseAsset({ tag_name: "v1", assets: [] }, "darwin", "arm64"), /No official tunnel-client/);
assert.throws(() => checksumFor("", "missing.zip"), /does not contain/);
console.log("tunnel-client installer tests passed: platform asset selection and checksum parsing");

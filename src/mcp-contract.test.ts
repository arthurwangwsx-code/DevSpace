import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureMcpApiContract, type McpApiContract } from "./mcp-contract.js";

const fixturePath = fileURLToPath(
  new URL("../test-fixtures/mcp-api-contract.json", import.meta.url),
);
const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as McpApiContract;
const actual = await captureMcpApiContract();

assert.deepEqual(
  actual,
  expected,
  "The existing /mcp tool contract changed. Regenerate only after an explicit API review.",
);

console.log(
  `MCP contract tests passed: ${Object.entries(actual)
    .map(([mode, tools]) => `${mode}=${tools.length}`)
    .join(", ")}`,
);

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureMcpApiContract } from "../src/mcp-contract.js";

const outputPath = resolve(process.argv[2] ?? "test-fixtures/mcp-api-contract.json");
const contract = await captureMcpApiContract();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o644 });
console.log(`Wrote MCP API contract to ${outputPath}`);

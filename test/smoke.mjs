import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

// 1. Ensure no Google OAuth client secrets are hardcoded anywhere in the repo.
for (const file of fs.readdirSync(srcDir)) {
	const text = fs.readFileSync(path.join(srcDir, file), "utf8");
	assert.equal(text.includes("GOCSPX-"), false, `Unexpected hardcoded OAuth secret in ${file}`);
	assert.equal(text.includes("openUrl"), false, `Deprecated interaction.openUrl in ${file}`);
}

// 2. Verify package.json extension manifest points to ./src/entry.ts and has zero runtime deps.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.deepEqual(pkg.pi?.extensions, ["./src/entry.ts"]);
assert.equal(pkg.dependencies, undefined);

console.log("Smoke checks PASSED (no secrets, clean manifest, valid entry).");

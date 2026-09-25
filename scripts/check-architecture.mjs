import fs from "node:fs";
import path from "node:path";

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules","build","dist","target",".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const forbidden = /from\s+["'](?:openai|anthropic|@anthropic-ai|elevenlabs|playwright|three|vrm|lancedb)/i;
const violations = [];

for (const file of walk(process.cwd())) {
  const rel = path.relative(process.cwd(), file);
  const source = fs.readFileSync(file, "utf8");
  if (rel.startsWith("core" + path.sep) && forbidden.test(source)) {
    violations.push(rel + ": concrete provider/runtime dependency");
  }
  if (rel.startsWith("core" + path.sep) && /from\s+["'][^"']*(?:modules|providers)[\\/]/i.test(source)) {
    violations.push(rel + ": Core imports module/provider implementation");
  }
}

for (const required of [
  "contracts/schemas/module-manifest.schema.json",
  "contracts/schemas/health-status.schema.json",
  "contracts/schemas/event-envelope.schema.json",
  "contracts/schemas/action-request.schema.json",
  "contracts/schemas/action-result.schema.json",
  "contracts/schemas/permission.schema.json",
  "contracts/schemas/provider-capability.schema.json",
  "apps/desktop-ui/src/main.tsx",
  "apps/desktop-host/src-tauri/Cargo.toml"
]) {
  if (!fs.existsSync(required)) violations.push("missing: " + required);
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Architecture guard passed.");

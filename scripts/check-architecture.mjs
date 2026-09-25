import fs from "node:fs";
import path from "node:path";

function walk(dir){
  const files=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(["node_modules","build","dist","target",".git"].includes(entry.name))continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())files.push(...walk(full));
    else if(full.endsWith(".ts"))files.push(full);
  }
  return files;
}
function normalized(file){return file.split(path.sep).join("/");}
const violations=[];
for(const file of walk(process.cwd())){
  const rel=normalized(path.relative(process.cwd(),file));
  const source=fs.readFileSync(file,"utf8");
  if(rel.startsWith("contracts/") && /from\s+["'][^"']*(core|modules|providers|host)[\/]/i.test(source))violations.push(rel+": Contracts may not depend on implementation layers.");
  if(rel.startsWith("core/") && /from\s+["'][^"']*(modules|providers|apps|host)[\/]/i.test(source))violations.push(rel+": Core may not import modules/providers/apps/host.");
  if(rel.startsWith("core/") && /from\s+["'](?:openai|anthropic|@anthropic-ai|elevenlabs|playwright|three|vrm|lancedb)/i.test(source))violations.push(rel+": Core may not import concrete runtime/provider libraries.");
  if(rel.startsWith("modules/") && /from\s+["'][^"']*modules[\/]/i.test(source))violations.push(rel+": Module may not import another module implementation.");
  if(rel.startsWith("providers/") && /from\s+["'][^"']*(core|modules)[\/]/i.test(source))violations.push(rel+": Provider may not import Core/module implementations.");
  if(rel.startsWith("apps/desktop-ui/") && /from\s+["'][^"']*src-tauri/i.test(source))violations.push(rel+": UI may not import Rust implementation internals.");
}
const required=[
  "contracts/schemas/module-manifest.schema.json","contracts/schemas/health-status.schema.json","contracts/schemas/event-envelope.schema.json",
  "contracts/schemas/action-request.schema.json","contracts/schemas/action-result.schema.json","contracts/schemas/permission.schema.json",
  "contracts/schemas/diagnostics.schema.json","contracts/schemas/credential-reference.schema.json","contracts/schemas/provider-configuration.schema.json","contracts/schemas/provider-connection-test-result.schema.json",
  "contracts/schemas/chat-message.schema.json","contracts/schemas/chat-context.schema.json","contracts/schemas/chat-generation-options.schema.json",
  "contracts/schemas/chat-request.schema.json","contracts/schemas/chat-response.schema.json","contracts/schemas/chat-error.schema.json","contracts/src/schema-validator.ts",
  "contracts/src/generated-schemas.ts","runtime/bootstrap/src/index.ts","host/config/src/index.ts","host/credentials/src/index.ts","apps/desktop-ui/src/main.tsx",
  "apps/desktop-host/src-tauri/build.rs","apps/desktop-host/src-tauri/capabilities/default.json"
];
for(const file of required)if(!fs.existsSync(file))violations.push("missing: "+file);
if(violations.length){console.error(violations.join("\n"));process.exit(1);}
console.log("Architecture guard passed.");

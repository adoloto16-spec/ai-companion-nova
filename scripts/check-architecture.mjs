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
  "contracts/schemas/chat-request.schema.json","contracts/schemas/chat-response.schema.json","contracts/schemas/chat-error.schema.json","contracts/schemas/core-book-entry.schema.json","contracts/schemas/context-source.schema.json","contracts/schemas/context-zone.schema.json","contracts/schemas/context-budget.schema.json","contracts/schemas/context-build-request.schema.json","contracts/schemas/memory-item.schema.json","contracts/schemas/memory-search-query.schema.json","contracts/schemas/memory-store-state.schema.json","contracts/schemas/context-candidate.schema.json","contracts/schemas/assembled-context.schema.json","contracts/src/schema-validator.ts",
  "contracts/src/generated-schemas.ts","runtime/bootstrap/src/index.ts","core/src/context-engine.ts","core/src/memory-broker.ts","host/config/src/index.ts","host/credentials/src/index.ts","apps/desktop-ui/src/main.tsx","host/characters/src/index.ts","host/core-book/src/index.ts","host/memory/src/index.ts",
  "host/retrieval/src/index.ts","host/model-profiles/src/index.ts","host/credential-profiles/src/index.ts","host/provider-presets/src/index.ts","core/src/retrieval-indexer.ts","contracts/schemas/model-profile.schema.json","contracts/schemas/model-profile-store-state.schema.json","contracts/schemas/credential-profile.schema.json","contracts/schemas/credential-profile-store-state.schema.json","contracts/schemas/provider-preset.schema.json","contracts/schemas/provider-preset-store-state.schema.json","contracts/schemas/retrieval-source.schema.json","contracts/schemas/retrieval-match.schema.json","contracts/schemas/retrieval-query.schema.json","contracts/schemas/retrieval-candidate.schema.json","contracts/schemas/retrieval-result.schema.json","contracts/schemas/retrieval-index-document.schema.json",
  "apps/desktop-host/src-tauri/build.rs","apps/desktop-host/src-tauri/capabilities/default.json","apps/desktop-host/src-tauri/src/memory.rs","apps/desktop-host/src-tauri/src/conversations.rs","apps/desktop-host/src-tauri/src/model_profiles.rs","apps/desktop-host/src-tauri/src/credential_profiles.rs","apps/desktop-host/src-tauri/src/provider_presets.rs","host/conversations/src/index.ts","core/src/conversation-manager.ts","host/model-profiles/src/index.ts"
];
for(const file of required)if(!fs.existsSync(file))violations.push("missing: "+file);

const tauriCapabilityPath=path.join(process.cwd(),"apps/desktop-host/src-tauri/capabilities/default.json");
const tauriBuildPath=path.join(process.cwd(),"apps/desktop-host/src-tauri/build.rs");
if(fs.existsSync(tauriCapabilityPath)&&fs.existsSync(tauriBuildPath)){
  let capability;
  try{capability=JSON.parse(fs.readFileSync(tauriCapabilityPath,"utf8"));}catch(error){violations.push("Tauri default capability must be valid JSON: "+String(error));capability={};}
  const permissions=Array.isArray(capability.permissions)?capability.permissions:[];
  const tauriCommands=[
    "get_characters","save_characters","get_core_book_entries","save_core_book_entries",
    "get_memory_state","save_memory_state","get_memory_semantic_index","save_memory_semantic_index","supersede_memory","search_retrieval_index",
    "rebuild_retrieval_index","rebuild_all_retrieval_index","upsert_retrieval_document",
    "remove_retrieval_document","remove_retrieval_character","list_conversations","get_conversation","save_conversation","delete_conversation","set_active_conversation","get_active_conversation","clear_conversation","get_model_profile","save_model_profile","delete_model_profile","get_credential_profiles","save_credential_profiles","delete_credential_profile","get_provider_presets","save_provider_presets","delete_provider_preset","ollama_http_request","ollama_http_stream","ollama_http_cancel"
  ];
  const buildSource=fs.readFileSync(tauriBuildPath,"utf8");
  for(const command of tauriCommands){
    const permission="allow-"+command.replaceAll("_","-");
    if(!permissions.includes(permission))violations.push("Tauri default capability missing: "+permission);
    if(!buildSource.includes("\""+command+"\""))violations.push("Tauri build manifest missing command for generated ACL: "+command);
  }
  const forbiddenPermissionPatterns=[
    /^core:default$/i,
    /^(?:core:)?fs:/i,
    /^(?:core:)?shell:/i,
    /^(?:core:)?process:/i,
    /^(?:core:)?automation:/i
  ];
  for(const permission of permissions){
    if(typeof permission!=="string")violations.push("Tauri capability permissions must be strings.");
    else if(permission.includes("*"))violations.push("Tauri capability may not use wildcard permission: "+permission);
    else if(forbiddenPermissionPatterns.some(pattern=>pattern.test(permission)))violations.push("Tauri capability has forbidden broad permission: "+permission);
  }
}
function assertNoSecretFields(file){
  if(!fs.existsSync(file))return;
  let value;
  try{value=JSON.parse(fs.readFileSync(file,"utf8"));}catch{return;}
  const forbidden=/^(secret|apiKey|api_key|password|accessToken|token)$/i;
  const walk=(node,path)=>{
    if(Array.isArray(node)){node.forEach((item,index)=>walk(item,path+"["+index+"]"));return;}
    if(node&&typeof node==="object"){
      for(const [key,child] of Object.entries(node)){
        if(forbidden.test(key))violations.push(file+" contains forbidden secret field: "+path+"."+key);
        walk(child,path+"."+key);
      }
    }
  };
  walk(value,"$");
}
assertNoSecretFields("contracts/schemas/credential-profile.schema.json");
assertNoSecretFields("contracts/schemas/credential-profile-store-state.schema.json");
assertNoSecretFields("contracts/schemas/provider-preset.schema.json");
assertNoSecretFields("contracts/schemas/provider-preset-store-state.schema.json");

const uiMain=path.join(process.cwd(),"apps/desktop-ui/src/main.tsx");
if(fs.existsSync(uiMain)){
  const uiSource=fs.readFileSync(uiMain,"utf8");
  if(/credentialStore\.getSecret\s*\(/.test(uiSource))violations.push("Desktop UI must not read credential secrets.");
}

const ttsRequired=[
  "contracts/src/tts.ts",
  "contracts/schemas/app-settings.schema.json",
  "providers/tts/registry/package.json",
  "providers/tts/registry/src/index.ts",
  "providers/tts/voice-studio/package.json",
  "providers/tts/voice-studio/src/index.ts",
  "modules/voice/tts/package.json",
  "modules/voice/tts/src/index.ts",
  "apps/desktop-ui/src/web-audio-output.ts"
];
for(const file of ttsRequired)if(!fs.existsSync(file))violations.push("missing TTS architecture component: "+file);

function importSpecifiers(source){
  return [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(match=>match[1]);
}
function sourceFor(file){
  if(!fs.existsSync(file)){violations.push("missing TTS architecture source: "+file);return "";}
  return fs.readFileSync(file,"utf8");
}
function assertImports(file,source,allowed,forbidden){
  for(const specifier of importSpecifiers(source)){
    if(forbidden.test(specifier))violations.push(file+" crosses a forbidden TTS architecture boundary via "+specifier);
    if(allowed&&!allowed.test(specifier))violations.push(file+" may import only its declared TTS layer dependencies; found "+specifier);
  }
}
const ttsProviderPath="providers/tts/voice-studio/src/index.ts";
const ttsProviderSource=sourceFor(ttsProviderPath);
assertImports(ttsProviderPath,ttsProviderSource,/contracts\/src\/tts\b/i,/\b(?:core|modules|apps|host|runtime)\/|^react(?:\/|$)/i);

const ttsRegistryPath="providers/tts/registry/src/index.ts";
assertImports(ttsRegistryPath,sourceFor(ttsRegistryPath),/contracts\/src\/tts\b/i,/\b(?:core|modules|apps|host|runtime|providers)\/|^react(?:\/|$)/i);

const ttsControllerPath="modules/voice/tts/src/index.ts";
const ttsControllerSource=sourceFor(ttsControllerPath);
assertImports(ttsControllerPath,ttsControllerSource,/contracts\/src\/(?:tts|mind-runtime)\b/i,/\b(?:core|providers|apps|host|runtime)\/|^react(?:\/|$)/i);
if(/127\.0\.0\.1|localhost|\/ws\/tts|\/generate|VoiceStudioTtsProvider|FormData|new WebSocket/i.test(ttsControllerSource))
  violations.push(ttsControllerPath+": playback/controller code must not know VoiceStudio URLs, HTTP forms or WebSocket protocol details.");

const webAudioPath="apps/desktop-ui/src/web-audio-output.ts";
const webAudioSource=sourceFor(webAudioPath);
assertImports(webAudioPath,webAudioSource,/modules\/voice\/tts\/src|contracts\/src\/tts\b/i,/providers\/tts|VoiceStudioTtsProvider|\bcore\/|\bruntime\//i);
if(/127\.0\.0\.1|localhost|\/ws\/tts|\/generate|VoiceStudioTtsProvider/i.test(webAudioSource))
  violations.push(webAudioPath+": the Web Audio adapter must not contain provider-specific URLs or protocol details.");

const ttsCompositionPath="runtime/bootstrap/src/index.ts";
const ttsComposition=sourceFor(ttsCompositionPath);
if(!ttsComposition.includes("new TtsProviderRegistry()")||!ttsComposition.includes("new VoiceStudioTtsProvider()")||
   !ttsComposition.includes("ttsProviders.register(()=>new VoiceStudioTtsProvider())"))
  violations.push(ttsCompositionPath+": the TTS provider must be registered in the composition root.");
if(/providers\/tts\/registry\/src|providers\/tts\/voice-studio\/src/.test(sourceFor("apps/desktop-ui/src/main.tsx")))
  violations.push("apps/desktop-ui/src/main.tsx: UI may not instantiate/import concrete TTS providers or their registry.");

const appSettingsPath="contracts/src/settings.ts";
const appSettingsSource=sourceFor(appSettingsPath);
if(!/APP_SETTINGS_SCHEMA_VERSION:"\d+"/.test(appSettingsSource)||!/tts:cloneTtsSettings\(DEFAULT_APP_SETTINGS\.tts\)/.test(appSettingsSource))
  violations.push(appSettingsPath+": AppSettings must declare a schema version and include copied TTS defaults.");
const ttsDefaults=sourceFor("contracts/src/tts.ts");
if(!/enabled:\s*false/.test(ttsDefaults))violations.push("contracts/src/tts.ts: TTS must be disabled by default.");

const tauriConfigPath="apps/desktop-host/src-tauri/tauri.conf.json";
if(fs.existsSync(tauriConfigPath)){
  try{
    const tauri=JSON.parse(fs.readFileSync(tauriConfigPath,"utf8"));
    const connect=tauri?.app?.security?.csp?.["connect-src"];
    if(typeof connect!=="string")violations.push(tauriConfigPath+": connect-src CSP must be a string.");
    else{
      for(const origin of ["ws://127.0.0.1:3900","ws://localhost:3900","ws://[::1]:3900"])
        if(!connect.split(/\s+/).includes(origin))violations.push(tauriConfigPath+": connect-src CSP is missing "+origin);
      if(connect.split(/\s+/).includes("ws:"))violations.push(tauriConfigPath+": connect-src CSP may not allow arbitrary WebSocket hosts.");
    }
  }catch(error){violations.push(tauriConfigPath+": invalid JSON: "+String(error));}
}

if(violations.length){console.error(violations.join("\n"));process.exit(1);}
console.log("Architecture guard passed.");

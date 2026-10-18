import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {chatDraftKey,readChatDraft,writeChatDraft,clearSubmittedChatDraft} from "../../apps/desktop-ui/src/chat-drafts";
import {passiveDiagnosticsOptions} from "../../apps/desktop-ui/src/provider-health-polling";
import {isAllowedOllamaRoute} from "../../apps/desktop-ui/src/ollama-http-client";

const sourcePath=path.resolve(process.cwd(),"apps/desktop-ui/src/main.tsx");
const source=fs.readFileSync(sourcePath,"utf8");
const foundationPath=path.resolve(process.cwd(),"runtime/bootstrap/src/index.ts");
const foundationSource=fs.readFileSync(foundationPath,"utf8");
assert.equal(isAllowedOllamaRoute("/api/tags","GET"),true,"Ollama model discovery keeps GET /api/tags");
assert.equal(isAllowedOllamaRoute("/api/show","POST"),true,"capability discovery permits POST /api/show through desktop IPC");
assert.equal(isAllowedOllamaRoute("/api/show","GET"),false,"capability discovery rejects the wrong HTTP method");
assert.equal(isAllowedOllamaRoute("/api/chat","POST"),true,"native chat remains allowed");
assert.equal(isAllowedOllamaRoute("/api/show","DELETE"),false,"undocumented Ollama methods remain blocked");
assert.ok(foundationSource.includes("activeModelProfile?.providerPresetId?.trim()||activeProviderPresetId"),"Nova Life follows Model Profile's pinned provider preset");
assert.ok(foundationSource.includes("activeModelProfile?.model?.trim()"),"Nova Life follows Model Profile's model override");
assert.ok(source.includes("Automatic Memory Agent"),"Memory settings expose separate agent configuration controls");
assert.ok(source.includes("await speechOutputController.finishTurn(context.turnId);"),"cognitive turn completion awaits real speech playback");

function blockBetween(startMarker:string,endMarker:string):string{
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start+startMarker.length);
  assert.notEqual(start,-1,startMarker+" must exist");
  assert.notEqual(end,-1,endMarker+" must exist after "+startMarker);
  return source.slice(start,end);
}

const providerPresets=blockBetween("function ProviderPresetsView(","function ModelProfileView(");
const settingsContainer=blockBetween("function SettingsContainerView(","function isTauriRuntime():boolean");
const appSettingsView=blockBetween("function AppSettingsView(","function TraceCandidate(");
const diagnosticsView=blockBetween("function DiagnosticsView(","class ViewErrorBoundary");
const syncCharacters=blockBetween("const syncCharacters=React.useCallback","const addConfigurationLoadError=React.useCallback");
const refreshRuntime=blockBetween("const refreshRuntime=React.useCallback","React.useEffect(()=>{");
const startupEffect=blockBetween('React.useEffect(()=>{\n    let active=true;\n    setStartupStatus("initializing")',"const selectCharacter=React.useCallback(async(id:string)=>{");
const manualConnectionTest=blockBetween("const testPreset=React.useCallback","const saveModelProfile=React.useCallback");
const modelDiscovery=blockBetween("const refreshPresetModels=React.useCallback","const testPreset=React.useCallback");
const providerPoolPath=path.resolve(process.cwd(),"runtime/bootstrap/src/provider-pool.ts");
const providerPoolSource=fs.readFileSync(providerPoolPath,"utf8");
const app=source.slice(source.indexOf("function App(){"));

assert.deepEqual(passiveDiagnosticsOptions("ollama"),{skipProviderHealthFor:["ollama"]},"Ollama periodic diagnostics reuses cached health");
assert.equal(passiveDiagnosticsOptions("openai-compatible"),undefined,"OpenAI-compatible/Mistral diagnostics retain their current health probes");
assert.equal(passiveDiagnosticsOptions("gemini"),undefined,"Gemini diagnostics retain their current health probes");
assert.ok(refreshRuntime.includes("next.diagnostics(passiveDiagnosticsOptions(config?.providerId))"),"runtime replacement avoids duplicate Ollama startup probes after the first snapshot");
assert.ok(startupEffect.includes("foundation.diagnostics(passiveDiagnosticsOptions(foundation.getProviderConfiguration()?.providerId))"),"the one-second runtime diagnostics loop does not re-probe Ollama");
assert.equal((startupEffect.match(/timer\s*=\s*setInterval/g)??[]).length,1,"runtime mount owns only one diagnostics timer start");
assert.ok(startupEffect.includes("if(timer)clearInterval(timer)"),"runtime cleanup clears its interval on unmount");
assert.ok(startupEffect.includes("active=false;"),"runtime cleanup invalidates in-flight sync work on unmount");
assert.ok(startupEffect.includes("if(!active)return;"),"late startup completion cannot create a timer after unmount");
assert.ok(diagnosticsView.includes("runtime.diagnostics(passiveDiagnosticsOptions(runtime.getProviderConfiguration()?.providerId))"),"Diagnostics view polling does not re-probe Ollama");
assert.ok(diagnosticsView.includes("const timer=setInterval(refresh,750);")&&diagnosticsView.includes("return ()=>clearInterval(timer);"),"Diagnostics view timer is cleaned up on unmount/remount");
assert.ok(diagnosticsView.includes("},[refresh]);"),"Diagnostics view creates one interval per effect mount");
assert.ok(manualConnectionTest.includes("testProviderPresetConfiguration(config,credentialStore,ollamaHttpClient)"),"manual connection testing remains a real request");
assert.ok(modelDiscovery.includes("listProviderModels("),"manual model discovery remains wired to the configured provider");
assert.equal(providerPoolSource.includes("setInterval"),false,"provider pool recovery is request-driven; no periodic health timer is required");
const chatStopAction=blockBetween("const stop=React.useCallback(async()=>{","const continueGeneration=React.useCallback");
const chatRetryAction=blockBetween("const retry=React.useCallback(async()=>{","const clear=React.useCallback");
const selectCharacterAction=blockBetween("const selectCharacter=React.useCallback(async(id:string)=>{","const selectConversation=React.useCallback(async(id:string)=>{");
const selectConversationAction=blockBetween("const selectConversation=React.useCallback(async(id:string)=>{","const createConversation=React.useCallback(async()=>{");
const createConversationAction=blockBetween("const createConversation=React.useCallback(async()=>{","const renameConversation=React.useCallback(async(conversation:Conversation)=>{");
const deleteConversationAction=blockBetween("const deleteConversation=React.useCallback(async(conversation:Conversation)=>{","const createCharacter=React.useCallback(async(name:string)=>{");
const deleteCharacterAction=blockBetween("const deleteCharacter=React.useCallback(async(id:string)=>{","const configurationForPreset=");
const settingsResetStart=source.indexOf("const resetAppSettings=React.useCallback(async()=>{");
const settingsResetEnd=source.indexOf("const savePromptOverride=React.useCallback",settingsResetStart);
assert.ok(settingsResetStart>=0&&settingsResetEnd>settingsResetStart,"settings reset handler must be present");
const settingsResetAction=source.slice(settingsResetStart,settingsResetEnd);
assert.ok(chatStopAction.indexOf("onStopSpeech();")>=0&&chatStopAction.indexOf("onStopSpeech();")<chatStopAction.indexOf("await controller.stop();"),"Chat Stop cancels speech before stopping generation");
assert.ok(chatRetryAction.indexOf("onStopSpeech();")>=0&&chatRetryAction.indexOf("onStopSpeech();")<chatRetryAction.indexOf("controller.retryLife("),"Nova Life retry cancels stale speech before restarting a turn");
for(const [name,block] of [["character switch",selectCharacterAction],["conversation switch",selectConversationAction],["new conversation",createConversationAction]] as const){
  assert.ok(block.includes("speechOutputController.stop("),"TTS is stopped immediately on "+name);
  assert.ok(block.indexOf("speechOutputController.stop(")<block.indexOf("foundation.setNovaTurnSink(undefined)"),"TTS stops before the old "+name+" context is detached");
}
assert.ok(deleteConversationAction.includes("if(activeConversation?.id===conversation.id){\n      speechOutputController.stop("),"deleting active conversation cancels speech before replacement");
assert.ok(deleteCharacterAction.includes("if(before?.id===id)speechOutputController.stop("),"deleting active character cancels speech");
assert.ok(settingsResetAction.indexOf("speechOutputController.stop(")<settingsResetAction.indexOf("await foundation.resetSettings()"),"settings reset cancels audio before persistence");



assert.equal(source.includes("function SettingsView("),false,"Legacy SettingsView component must be removed");
assert.equal(app.includes("<SettingsView "),false,"Legacy SettingsView render must be removed");
assert.equal(app.includes('view==="provider-settings"'),false,"Provider Settings must not remain a top-level route");
assert.equal(app.includes('view==="provider-presets"'),false,"Provider Presets must not remain a top-level route");

const navigation=app.slice(app.indexOf("<nav className=\"app-nav\""),app.indexOf("</nav>",app.indexOf("<nav className=\"app-nav\"")));
for(const label of ["Chat","Characters","Core Book","Model Profile","Settings","Diagnostics"]){
  assert.ok(navigation.includes(">"+label+"</button>"),"Primary navigation must expose "+label);
}
for(const removed of ["Provider Presets","Provider Settings"]){
  assert.equal(navigation.includes(">"+removed+"</button>"),false,"Primary navigation must not expose "+removed);
}

for(const label of ["General","Chat","Provider Presets"]){
  assert.ok(settingsContainer.includes(">"+label+"</button>"),"Settings sub-navigation must expose "+label);
}
assert.ok(settingsContainer.includes('tab==="general"'),"Settings must have a General tab");
assert.ok(settingsContainer.includes('tab==="chat"')&&settingsContainer.includes("<ChatSettingsView "),"Settings must expose the Chat response-mode settings tab");
assert.ok(appSettingsView.includes('settings.chat.reasoningMode')&&appSettingsView.includes('value="provider-default"')&&appSettingsView.includes('value="enabled"')&&appSettingsView.includes('value="disabled"'),"Chat settings bind provider-native reasoning modes");
assert.ok(settingsContainer.includes('tab==="provider-presets"'),"Settings must have a Provider Presets tab");
assert.ok(settingsContainer.includes("<AppSettingsView "), "General tab must render AppSettingsView");
assert.ok(diagnosticsView.includes("runtime.diagnostics(passiveDiagnosticsOptions(runtime.getProviderConfiguration()?.providerId))"),"DiagnosticsView diagnostics refresh must use cached Ollama health during periodic refresh");
assert.ok(diagnosticsView.includes("setRuntimeDiagnostics(snapshot.recentErrors)"),"DiagnosticsView must expose all recent runtime diagnostics separately");
assert.ok(diagnosticsView.includes("Runtime diagnostics"),"DiagnosticsView must label general runtime diagnostics");
for(const field of ["timestamp","source","code","message","requestId","providerPresetId","sourceId","providerId","model","category","httpStatus","durationMs","baseUrlHost"]){
  assert.ok(diagnosticsView.includes(field), "DiagnosticsView must expose "+field);
}
assert.ok(diagnosticsView.includes('entry.source==="memory-semantic-deduplication"'),"DiagnosticsView must display semantic-memory diagnostics");
assert.ok(diagnosticsView.includes("Memory Deduplication"),"DiagnosticsView must expose the Memory Deduplication section");
assert.ok(diagnosticsView.includes("candidateDiagnostics")&&diagnosticsView.includes("archiveMapping")&&diagnosticsView.includes("mutationResult"),"DiagnosticsView must display dedup candidate/mutation diagnostics");
assert.ok(diagnosticsView.includes("semanticDedupEnabled")&&diagnosticsView.includes("judgeProviderPresetId")&&diagnosticsView.includes("memoryCreatedSubscribers"),"DiagnosticsView must display effective runtime semantic settings");
assert.equal(appSettingsView.includes("memoryAgent"),false,"Settings UI must not restore the retired Memory Agent configuration");
assert.ok(appSettingsView.includes("settings.chat.automaticLongTermMemory"),"General settings retain the LONGMEMORY persistence gate");
assert.ok(appSettingsView.includes("Save LONGMEMORY candidates automatically"),"Automatic memory setting describes candidate persistence, not a second generator");
assert.ok(appSettingsView.includes("onClick={()=>void onSave()}"),"Settings UI exposes the existing Save Settings persistence path");
assert.ok(settingsContainer.includes("<ProviderPresetsView "), "Provider Presets tab must render the existing ProviderPresetsView");

for(const forbidden of ["appSettings","saveAppSettings","resetAppSettings","foundationRef","setSettingsLoadMessage","setSaving"]){
  assert.equal(providerPresets.includes(forbidden),false,"ProviderPresetsView must not access App-local "+forbidden);
}
assert.equal(providerPresets.includes("credentialChoice"),false,"ProviderPresetsView must not keep credentialChoice as independent state");
assert.ok(providerPresets.includes('value={selectedSource.credentialReference?.id??""}'),"Credential selector must derive its value from the source reference");
assert.ok(providerPresets.includes('updateSource(selectedSource.id,{credentialReference:null})'),"No credential must immediately clear the source reference");
assert.ok(providerPresets.includes('updateSource(selectedSource.id,{credentialReference:{...profile.credentialReference}})'),"Selecting or creating a credential must immediately update the source reference");
assert.ok(providerPresets.includes("validateProviderPresetCredentialReferences(draft,credentialProfiles)"),"Save must validate existing source credential references without reconstructing them from UI state");
assert.ok(providerPresets.includes("cloneProviderPresetForSaveAsNew"),"Save as new must clone the whole current draft rather than only selectedSource");
assert.equal(providerPresets.includes("selectedSource?{...selectedSource,id:"),false,"Save as new must not copy only selectedSource");
assert.equal(providerPresets.includes("setCredentialChoice"),false,"ProviderPresetsView must not update independent credential selection state");
assert.ok(providerPresets.includes("setAddingCredential(true)"),"Add credential remains UI-only state");
assert.ok(providerPresets.includes("await onSavePreset(next,false)"),"Save as new must persist the complete next preset");
assert.ok(providerPresets.includes('setDraft(next);setSelectedId(next.id);'),"After successful save the draft must become the saved preset");
assert.ok(providerPresets.includes('providerId,credentialReference:null'),"Changing provider must clear the previous credential reference");
assert.ok(providerPresets.includes('setAddingCredential(false)'),"Provider/source changes must reset only the UI add-credential mode");
assert.ok(providerPresets.includes(`presets.length===0?<option value="">No saved presets</option>`),"Provider Presets must render an empty-state option");
assert.match(providerPresets,/Model discovery failed:/);
assert.match(providerPresets,/Models refreshed\./);

assert.ok(!syncCharacters.includes("setChatController(current=>"),"syncCharacters must not reuse an existing controller");
assert.ok(syncCharacters.includes("setChatController(loaded.controller);"),"syncCharacters must install the freshly created controller");
assert.ok(refreshRuntime.includes("setChatController(null);"),"refreshRuntime must clear the stale controller before runtime replacement");
assert.ok(refreshRuntime.indexOf("setChatController(null);")<refreshRuntime.indexOf("await foundationRef.current?.stop();"),"stale controller must be cleared before stopping the old runtime");
assert.ok(refreshRuntime.includes("await syncCharacters(next);"),"new runtime must synchronize a freshly created controller");
assert.ok(app.includes("foundation.startLife()"),"global Life control must start the Foundation Mind Runtime");
assert.ok(app.includes("foundation.stopLife()"),"global Life control must stop the Foundation Mind Runtime");
assert.ok(app.includes("Nova Life:"),"App must expose the global Nova Life control");
assert.equal(navigation.includes(">Thoughts</button>"),false,"the standalone Thoughts tab is removed");
assert.equal(source.includes("function ThoughtsView("),false,"the standalone Thoughts screen is removed, not hidden");
assert.equal(foundationSource.includes("subscribeThoughts"),false,"Thought-only subscription API is removed");
assert.equal(foundationSource.includes("deleteThought"),false,"Thought-only delete API is removed");
assert.equal(foundationSource.includes("clearCurrentThoughts"),false,"Thought-only clear API is removed");
assert.equal(foundationSource.includes("clearAllThoughts"),false,"Thought-only clear-all API is removed");
assert.equal(source.includes("publishExpression"),false,"old expression publisher is removed from UI");
assert.equal(foundationSource.includes("setMindExpressionPublisher"),false,"old expression publisher is removed from runtime API");
assert.ok(source.includes("Show technical data"),"Chat restores the technical-data switch");
assert.ok(source.includes("checked={showTechnicalData}")&&source.includes("setShowTechnicalData(event.target.checked)"),"the technical-data switch is stateful and controls the rendered panel");
assert.ok(source.includes("resolveNovaTurnMessagePresentation(message,showTechnicalData)"),"Chat uses the shared parser/visibility resolver for persisted message content");
assert.ok(source.includes("presentation.text"),"the normal chat bubble renders only the resolved user-facing speech");
assert.ok(source.includes('{isNovaTurn&&showTechnicalData&&<section className="nova-turn-technical"'),"technical data is displayed only behind the explicit switch");
for(const heading of ["Situation","Thoughts (private)","Emotion","Tool calls","Tool results","Speech","Long-term memory","Next wake","Protocol diagnostics","Unrecognized / raw output (bounded)"]){
  assert.ok(source.includes("<strong>"+heading+"</strong>"),"NovaTurn technical panel exposes "+heading);
}
assert.ok(source.includes("message.content.length>4000")&&source.includes("slice(0,4000)")&&source.includes("[truncated at 4000 characters]"),"raw technical content is capped at 4000 characters with a truncation marker");
assert.ok(source.includes('message.role==="assistant"&&!isNovaTurn'),"recognized NovaTurn internals cannot be edited as ordinary raw messages");
assert.ok(source.includes("countVisibleSpeechMessages(conversation.messages)")&&source.includes("stored messages"),"conversation counter distinguishes stored records from visible speech messages");
assert.ok(app.includes('const [chatDrafts,setChatDrafts]=React.useState<Record<string,string>>({});'),"App owns in-memory Chat drafts");
assert.ok(app.includes('chatDraftKey(activeCharacter.id,activeConversation.id)'),"draft keys include both character and conversation identity");
assert.ok(app.includes('<ChatView key={activeChatDraftKey}'),"Chat view identity changes with character/conversation without losing App draft state");
assert.ok(app.includes('input={activeChatDraftKey?readChatDraft(chatDrafts,activeChatDraftKey):""}'),"Chat renders the current conversation draft");
assert.ok(app.includes('onClearSubmittedDraft={submitted=>{if(activeChatDraftKey)setChatDrafts(current=>clearSubmittedChatDraft(current,activeChatDraftKey,submitted));}}'),"successful submission clears only the unchanged draft from the submitting conversation");
assert.equal(source.includes('const [input,setInput]=React.useState("");'),false,"ChatView must not own transient draft state");
assert.ok(source.includes('if(result.status==="sent")onClearSubmittedDraft(submittedDraft);'),"ordinary Chat clears a draft only after a successful send");
assert.ok(source.includes('if(result.status==="awaiting-life")onClearSubmittedDraft(submittedDraft);'),"Nova Life clears a draft only after persistence and wake acceptance");
assert.ok(source.includes("commitNovaTurn"),"Chat persists the canonical NovaTurn record");
assert.ok(source.includes("setNovaTurnSink"),"UI registers the single canonical turn sink");
assert.ok(source.includes("subscribeMindState"),"UI must subscribe to runtime mind state rather than own the runtime");
assert.ok(source.includes('message.role==="assistant"&&!isNovaTurn'),"NovaTurn internals cannot be exposed by opening the raw record in the editor");
assert.ok(source.includes("Nova Life failed to produce a valid reply")&&source.includes("Retry Nova Life"),"failed reactive turns display a failed state and retry path");

assert.match(source,/class ViewErrorBoundary extends React\.Component/);
assert.match(source,/componentDidCatch\(error:Error,info:React\.ErrorInfo\)/);
assert.match(source,/This view failed to load\./);
assert.match(source,/onClick=\{this\.retry\}/);
assert.match(source,/foundationRef\.current\?\.recordDiagnosticError/);
assert.equal(source.match(/new ViewErrorBoundary/g)?.length??0,0,"ErrorBoundary should remain a React component, not be instantiated imperatively");

const draftA=chatDraftKey("character-a","conversation-a");
const draftB=chatDraftKey("character-a","conversation-b");
const draftOtherCharacter=chatDraftKey("character-b","conversation-a");
assert.notEqual(draftA,draftB,"separate conversations have separate draft keys");
assert.notEqual(draftA,draftOtherCharacter,"equal conversation IDs from different characters cannot share drafts");
let drafts:Record<string,string>={};
drafts=writeChatDraft(drafts,draftA,"unsent A");
drafts=writeChatDraft(drafts,draftB,"unsent B");
drafts=writeChatDraft(drafts,draftOtherCharacter,"unsent other character");
assert.equal(readChatDraft(drafts,draftA),"unsent A","navigating to other tabs and back restores draft A");
assert.equal(readChatDraft(drafts,draftB),"unsent B","switching conversations restores that conversation draft");
assert.equal(readChatDraft(drafts,draftOtherCharacter),"unsent other character","switching characters never transfers a draft");
const unchangedOnFailure=clearSubmittedChatDraft(drafts,draftA,"different submitted text");
assert.equal(readChatDraft(unchangedOnFailure,draftA),"unsent A","failed or stale submission does not clear the draft");
const afterSuccessfulSend=clearSubmittedChatDraft(drafts,draftA,"unsent A");
assert.equal(readChatDraft(afterSuccessfulSend,draftA),"","successful send clears the matching submitted draft");
assert.equal(readChatDraft(afterSuccessfulSend,draftB),"unsent B","successful send does not clear another conversation draft");
const ttsSettings=blockBetween("function TtsSettingsView(","function SettingsContainerView(");
assert.match(ttsSettings,/Enable audio playback/,"TTS UI requires an explicit user gesture before playback");
assert.match(settingsContainer,/ttsController:SpeechOutputController/,"settings container owns the dedicated speech controller prop");
assert.match(settingsContainer,/ttsProviders:readonly TtsProviderDescriptor\[\]/,"settings container receives TTS providers from composition root");
assert.doesNotMatch(providerPresets,/ttsController|ttsProviders/,"Chat Provider Presets remain independent of TTS settings");

const tauriConfigPath=path.resolve(process.cwd(),"apps/desktop-host/src-tauri/tauri.conf.json");
const tauriConfig=JSON.parse(fs.readFileSync(tauriConfigPath,"utf8")) as {app:{security:{csp:Record<string,string>}}};
const connectPolicy=tauriConfig.app.security.csp["connect-src"];
if(typeof connectPolicy!=="string")throw new Error("Tauri connect-src CSP policy must be present");
const connectSources=connectPolicy.split(/\s+/);
for(const origin of ["ws://127.0.0.1:3900","ws://localhost:3900","ws://[::1]:3900"]){
  assert.ok(connectSources.includes(origin),"CSP allows only the configured loopback VoiceStudio WebSocket origin "+origin);
}
assert.ok(!connectSources.includes("ws:"),"CSP must not allow arbitrary WebSocket hosts");

console.log("desktop-ui-regression: ok");console.log("desktop-ui-regression: ok");

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const sourcePath=path.resolve(process.cwd(),"apps/desktop-ui/src/main.tsx");
const source=fs.readFileSync(sourcePath,"utf8");
const foundationPath=path.resolve(process.cwd(),"runtime/bootstrap/src/index.ts");
const foundationSource=fs.readFileSync(foundationPath,"utf8");

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
const app=source.slice(source.indexOf("function App(){"));

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
assert.ok(settingsContainer.includes('settings.chat.responseMode')&&settingsContainer.includes('value="structured"')&&settingsContainer.includes('value="plain"'),"Chat settings bind both response modes");
assert.ok(settingsContainer.includes('tab==="provider-presets"'),"Settings must have a Provider Presets tab");
assert.ok(settingsContainer.includes("<AppSettingsView "), "General tab must render AppSettingsView");
assert.ok(diagnosticsView.includes("runtime.diagnostics()"),"DiagnosticsView must bridge runtime DiagnosticsStore");
assert.ok(diagnosticsView.includes("setRuntimeDiagnostics(snapshot.recentErrors)"),"DiagnosticsView must expose all recent runtime diagnostics separately");
assert.ok(diagnosticsView.includes("Runtime diagnostics"),"DiagnosticsView must label general runtime diagnostics");
for(const field of ["timestamp","source","code","message","requestId","providerPresetId","sourceId","providerId","model","category","httpStatus","durationMs","baseUrlHost"]){
  assert.ok(diagnosticsView.includes(field), "DiagnosticsView must expose "+field);
}
assert.ok(diagnosticsView.includes('entry.source==="memory-semantic-deduplication"'),"DiagnosticsView must display semantic-memory diagnostics");
assert.ok(diagnosticsView.includes("Memory Deduplication"),"DiagnosticsView must expose the Memory Deduplication section");
assert.ok(diagnosticsView.includes("candidateDiagnostics")&&diagnosticsView.includes("archiveMapping")&&diagnosticsView.includes("mutationResult"),"DiagnosticsView must display dedup candidate/mutation diagnostics");
assert.ok(diagnosticsView.includes("semanticDedupEnabled")&&diagnosticsView.includes("judgeProviderPresetId")&&diagnosticsView.includes("memoryCreatedSubscribers"),"DiagnosticsView must display effective runtime semantic settings");
assert.ok(appSettingsView.includes("value={settings.memoryAgent.providerPresetId??\"\"}"),"Settings UI must bind Memory Agent provider preset");
assert.ok(appSettingsView.includes("providerPresetId:event.target.value||null"),"Memory Agent provider preset selection updates app settings");
assert.ok(appSettingsView.includes("value={settings.memoryAgent.model}"),"Settings UI must bind Memory Agent model");
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
assert.ok(source.includes("Show technical data"),"Chat exposes a technical data switch");
assert.ok(source.includes("parsedTurn.speech"),"NovaTurn messages render only public speech");
assert.ok(source.includes("parseResult?.fields.thoughts")&&source.includes("isNovaTurn&&showTechnicalData"),"private thoughts are only rendered in technical mode");
assert.ok(source.includes("shouldRenderNovaTurn(parseResult,showTechnicalData)"),"a persisted NovaTurn is hidden only when technical mode is off and no safe speech exists");
assert.ok(source.includes("Unrecognized / raw output (bounded)")&&source.includes("slice(0,4000)"),"technical mode shows bounded raw output for malformed turns");
for(const heading of ["Situation","Thoughts (private)","Emotion","Tool calls","Tool results","Speech","Next wake","Protocol diagnostics"]){assert.ok(source.includes("<strong>"+heading+"</strong>"),"technical mode always supplies the "+heading+" section");}
assert.ok(source.includes("countVisibleSpeechMessages(conversation.messages)")&&source.includes("stored records"),"conversation counter distinguishes stored records from visible speech messages");
assert.ok(source.includes("commitNovaTurn"),"Chat persists the canonical NovaTurn record");
assert.ok(source.includes("setNovaTurnSink"),"UI registers the single canonical turn sink");
assert.ok(source.includes("subscribeMindState"),"UI must subscribe to runtime mind state rather than own the runtime");

assert.match(source,/class ViewErrorBoundary extends React\.Component/);
assert.match(source,/componentDidCatch\(error:Error,info:React\.ErrorInfo\)/);
assert.match(source,/This view failed to load\./);
assert.match(source,/onClick=\{this\.retry\}/);
assert.match(source,/foundationRef\.current\?\.recordDiagnosticError/);
assert.equal(source.match(/new ViewErrorBoundary/g)?.length??0,0,"ErrorBoundary should remain a React component, not be instantiated imperatively");

console.log("desktop-ui-regression: ok");

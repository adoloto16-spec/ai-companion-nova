import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const sourcePath=path.resolve(process.cwd(),"apps/desktop-ui/src/main.tsx");
const source=fs.readFileSync(sourcePath,"utf8");

function blockBetween(startMarker:string,endMarker:string):string{
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start+startMarker.length);
  assert.notEqual(start,-1,startMarker+" must exist");
  assert.notEqual(end,-1,endMarker+" must exist after "+startMarker);
  return source.slice(start,end);
}

const providerPresets=blockBetween("function ProviderPresetsView(","function ModelProfileView(");
const settingsContainer=blockBetween("function SettingsContainerView(","function isTauriRuntime():boolean");
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

for(const label of ["General","Provider Presets","Automatic Memory"]){
  assert.ok(settingsContainer.includes(">"+label+"</button>")||settingsContainer.includes(">"+label+"\n      </button>")||settingsContainer.includes(">\n        "+label+"\n      </button>"),"Settings sub-navigation must expose "+label);
}
assert.ok(settingsContainer.includes('tab==="general"'),"Settings must have a General tab");
assert.ok(settingsContainer.includes('tab==="provider-presets"'),"Settings must have a Provider Presets tab");
assert.ok(settingsContainer.includes('tab==="automatic-memory"'),"Settings must have an Automatic Memory tab");
assert.ok(settingsContainer.includes("<AutomaticMemorySettingsView"),"Settings must render AutomaticMemorySettingsView");
assert.ok(settingsContainer.includes("<AppSettingsView "), "General tab must render AppSettingsView");
assert.ok(settingsContainer.includes("<ProviderPresetsView "), "Provider Presets tab must render the existing ProviderPresetsView");

for(const forbidden of ["appSettings","saveAppSettings","resetAppSettings","foundationRef","setSettingsLoadMessage","setSaving"]){
  assert.equal(providerPresets.includes(forbidden),false,"ProviderPresetsView must not access App-local "+forbidden);
}
assert.ok(providerPresets.includes(`presets.length===0?<option value="">No saved presets</option>`),"Provider Presets must render an empty-state option");
assert.match(providerPresets,/Model discovery failed:/);
assert.match(providerPresets,/Models refreshed\./);

assert.ok(!syncCharacters.includes("setChatController(current=>"),"syncCharacters must not reuse an existing controller");
assert.ok(syncCharacters.includes("setChatController(loaded.controller);"),"syncCharacters must install the freshly created controller");
assert.ok(refreshRuntime.includes("setChatController(null);"),"refreshRuntime must clear the stale controller before runtime replacement");
assert.ok(refreshRuntime.indexOf("setChatController(null);")<refreshRuntime.indexOf("await foundationRef.current?.stop();"),"stale controller must be cleared before stopping the old runtime");
assert.ok(refreshRuntime.includes("await syncCharacters(next);"),"new runtime must synchronize a freshly created controller");

assert.match(source,/class ViewErrorBoundary extends React\.Component/);
assert.match(source,/componentDidCatch\(error:Error,info:React\.ErrorInfo\)/);
assert.match(source,/This view failed to load\./);
assert.match(source,/onClick=\{this\.retry\}/);
assert.match(source,/foundationRef\.current\?\.recordDiagnosticError/);
assert.equal(source.match(/new ViewErrorBoundary/g)?.length??0,0,"ErrorBoundary should remain a React component, not be instantiated imperatively");

console.log("desktop-ui-regression: ok");

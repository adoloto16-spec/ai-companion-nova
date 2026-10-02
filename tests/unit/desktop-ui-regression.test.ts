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
const app=source.slice(source.indexOf("function App(){"));

for(const forbidden of ["appSettings","saveAppSettings","resetAppSettings","foundationRef","setSettingsLoadMessage","setSaving"]){
  assert.equal(providerPresets.includes(forbidden),false,"ProviderPresetsView must not access App-local "+forbidden);
}

assert.match(app,/const saveAppSettings=React\.useCallback/);
assert.match(app,/const resetAppSettings=React\.useCallback/);
assert.match(app,/view==="provider-settings"/);
assert.match(app,/<SettingsView /);
assert.match(source,/class ViewErrorBoundary extends React\.Component/);
assert.match(source,/componentDidCatch\(error:Error,info:React\.ErrorInfo\)/);
assert.match(source,/This view failed to load\./);
assert.match(source,/onClick=\{this\.retry\}/);
assert.match(source,/foundationRef\.current\?\.recordDiagnosticError/);

assert.ok(providerPresets.includes(`presets.length===0?<option value="">No saved presets</option>`),"Provider Presets must render an empty-state option");
assert.match(providerPresets,/Model discovery failed:/);
assert.match(providerPresets,/Models refreshed\./);

const navigation=app.slice(app.indexOf("<nav className=\"app-nav\""),app.indexOf("</nav>",app.indexOf("<nav className=\"app-nav\"")));
for(const label of ["Chat","Characters","Core Book","Model Profile","Provider Presets","Provider Settings","Settings","Diagnostics"]){
  assert.ok(navigation.includes(">"+label+"</button>"),"Navigation must expose "+label);
}

console.log("desktop-ui-regression: ok");

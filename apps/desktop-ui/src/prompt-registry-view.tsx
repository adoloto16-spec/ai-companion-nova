import React from "react";
import {
  assemblePromptInstructions, bumpChangedPromptPresetVersions, clonePromptConfiguration, createDefaultPromptPreset,
  type AppSettings, type PromptConfiguration, type PromptPreset, type PromptPresetPrompt
} from "../../../contracts/src/index";

export interface PromptRegistryViewProps {
  settings:AppSettings;
  saving:boolean;
  message:string;
  onSaveSettings:(settings:AppSettings,message:string)=>Promise<void>;
}
function makeId(source:string,used:readonly string[]):string{
  const base=source.toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64)||"preset";
  let id=base,n=2;while(used.includes(id))id=base.slice(0,72)+"-"+n++;
  return id;
}
function validatePresetConfig(config:PromptConfiguration):string[]{
  const errors:string[]=[],ids=new Set<string>();
  if(config.presets.length>64)errors.push("Можно сохранить не более 64 пресетов.");
  for(const preset of config.presets){
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(preset.id))errors.push("Недопустимый ID пресета: "+preset.id);
    if(ids.has(preset.id))errors.push("Повторяется ID пресета: "+preset.id);ids.add(preset.id);
    if(!preset.name.trim()||preset.name.length>100)errors.push("Имя пресета должно содержать от 1 до 100 символов.");
    if(preset.prompts.length>128)errors.push("В пресете "+preset.name+" больше 128 промтов.");
    const promptIds=new Set<string>();
    for(const prompt of preset.prompts){
      if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(prompt.id))errors.push("Недопустимый ID промта: "+prompt.id);
      if(promptIds.has(prompt.id))errors.push("Повторяется ID промта: "+prompt.id);promptIds.add(prompt.id);
      if(!prompt.title.trim()||prompt.title.length>120)errors.push("Название промта должно содержать от 1 до 120 символов.");
      if(prompt.text.length>12000)errors.push("Текст промта превышает 12000 символов: "+prompt.id);
      if(!/^[a-z][a-z0-9._-]{0,79}$/.test(prompt.agentId))errors.push("Agent ID должен быть стабильным lowercase identifier: "+prompt.agentId);
      if(!Number.isInteger(prompt.order)||prompt.order < -100000||prompt.order>100000)errors.push("Порядок промта должен быть целым числом.");
      if(prompt.conditions?.scenarios?.some(value=>!value.trim()||value.length>80))errors.push("Некорректные сценарии: "+prompt.id);
    }
  }
  if(!config.presets.some(p=>p.id==="default"&&p.isBuiltIn))errors.push("Встроенный Default обязателен.");
  if(!config.presets.some(p=>p.id===config.activePresetId))errors.push("Активный пресет не существует.");
  return errors;
}

export function PromptRegistryView({settings,saving,message,onSaveSettings}:PromptRegistryViewProps){
  const [draft,setDraft]=React.useState<PromptConfiguration>(()=>clonePromptConfiguration(settings.prompts));
  const [selectedPromptId,setSelectedPromptId]=React.useState("");
  const [agent,setAgent]=React.useState("nova");
  const [scenario,setScenario]=React.useState("reactive");
  const [customScenario,setCustomScenario]=React.useState("");
  const [localMessage,setLocalMessage]=React.useState("");
  const fileRef=React.useRef<HTMLInputElement>(null);
  React.useEffect(()=>setDraft(clonePromptConfiguration(settings.prompts)),[settings.prompts]);
  const dirty=JSON.stringify(draft)!==JSON.stringify(settings.prompts);
  const active=draft.presets.find(p=>p.id===draft.activePresetId);
  const selected=active?.prompts.find(p=>p.id===selectedPromptId)??active?.prompts[0];
  const agents=[...new Set(["nova","memory-agent","memory-judge",...(active?.prompts.map(p=>p.agentId)??[])])].sort();
  const actualScenario=scenario==="custom"?(customScenario.trim()||"custom"):scenario;
  const assembly=assemblePromptInstructions(draft,agent,actualScenario);
  const updatePreset=(id:string,update:(preset:PromptPreset)=>PromptPreset)=>{
    setDraft(prev=>({...prev,presets:prev.presets.map(p=>p.id===id?update(p):p)}));setLocalMessage("");
  };
  const updateSelected=(update:(prompt:PromptPresetPrompt)=>PromptPresetPrompt)=>{
    if(!active||!selected)return;
    const pid=active.id,sid=selected.id;
    updatePreset(pid,p=>({...p,prompts:p.prompts.map(item=>item.id===sid?update(item):item)}));
  };
  const newPreset=()=>{
    const id=makeId("preset-"+Date.now().toString(36),draft.presets.map(p=>p.id));
    const p:PromptPreset={id,name:"Новый пресет",description:"",schemaVersion:1,version:1,isBuiltIn:false,prompts:[]};
    setDraft(prev=>({...prev,presets:[...prev.presets,p],activePresetId:id}));setSelectedPromptId("");setLocalMessage("");
  };
  const duplicate=()=>{
    if(!active)return;
    const id=makeId(active.id+"-copy",draft.presets.map(p=>p.id));
    const p:PromptPreset={...active,id,name:(active.name+" (копия)").slice(0,100),isBuiltIn:false,version:1,
      prompts:active.prompts.map(item=>({...item,...(item.conditions?{conditions:{...item.conditions,...(item.conditions.scenarios?{scenarios:[...item.conditions.scenarios]}:{})}}:{})}))};
    setDraft(prev=>({...prev,presets:[...prev.presets,p],activePresetId:id}));setSelectedPromptId("");setLocalMessage("");
  };
  const removePreset=()=>{
    if(!active||active.isBuiltIn)return;
    if(!window.confirm("Удалить пресет «"+active.name+"»?"))return;
    setDraft(prev=>({...prev,presets:prev.presets.filter(p=>p.id!==active.id),activePresetId:active.id===prev.activePresetId?"default":prev.activePresetId}));
    setSelectedPromptId("");setLocalMessage("");
  };
  const restoreDefault=()=>{
    if(!window.confirm("Заменить все записи Default эталонной копией? Пользовательские пресеты будут сохранены."))return;
    setDraft(prev=>({...prev,overrides:{},presets:[...prev.presets.filter(p=>p.id!=="default"),createDefaultPromptPreset()],activePresetId:"default"}));
    setSelectedPromptId("");setLocalMessage("Default восстановлен в черновике. Нажмите «Сохранить изменения».");
  };
  const addPrompt=()=>{
    if(!active||active.prompts.length>=128)return;
    let id="new-prompt",n=2;while(active.prompts.some(p=>p.id===id))id="new-prompt-"+n++;
    const p:PromptPresetPrompt={id,title:"Новый промт",text:"",agentId:agent||"nova",enabled:true,order:Math.max(0,...active.prompts.map(x=>x.order))+10};
    updatePreset(active.id,preset=>({...preset,prompts:[...preset.prompts,p]}));setSelectedPromptId(id);
  };
  const removePrompt=()=>{
    if(!active||!selected)return;
    if(!window.confirm("Удалить промт «"+selected.title+"» из выбранного пресета?"))return;
    updatePreset(active.id,preset=>({...preset,prompts:preset.prompts.filter(p=>p.id!==selected.id)}));setSelectedPromptId("");
  };
  const save=async()=>{
    const next=bumpChangedPromptPresetVersions(settings.prompts,clonePromptConfiguration(draft));
    const errors=validatePresetConfig(next);
    if(errors.length){setLocalMessage(errors.join(" "));return;}
    await onSaveSettings({...settings,prompts:next},"Изменения пресетов сохранены и применены.");
  };
  const exportActive=()=>{
    if(!active)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(active,null,2)],{type:"application/json"}));
    const a=document.createElement("a");a.href=url;a.download=active.id+".prompt-preset.json";a.click();URL.revokeObjectURL(url);
  };
  const importPreset=async(event:React.ChangeEvent<HTMLInputElement>)=>{
    const file=event.currentTarget.files?.[0];event.currentTarget.value="";if(!file)return;
    try{
      const parsed=JSON.parse(await file.text()) as PromptPreset;
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||parsed.isBuiltIn===true||parsed.id==="default")throw new Error("Можно импортировать только пользовательский пресет. Default защищён.");
      const id=makeId(typeof parsed.id==="string"?parsed.id:file.name.replace(/\.prompt-preset\.json$/i,""),draft.presets.map(p=>p.id));
      const imported:PromptPreset={...parsed,id,isBuiltIn:false};
      const next={...draft,presets:[...draft.presets,imported],activePresetId:id};
      const errors=validatePresetConfig(next);if(errors.length)throw new Error(errors.join(" "));
      setDraft(next);setSelectedPromptId("");setLocalMessage("Пресет импортирован в черновик. Сохраните изменения.");
    }catch(error){setLocalMessage(error instanceof Error?error.message:"Не удалось прочитать JSON-пресет.");}
  };
  return <main className="prompt-registry-panel">
    <header className="prompt-registry-header">
      <div><h2>Промты</h2><p className="chat-subtitle">Редактирование пресетов и полного текста инструкций всех агентов. Runtime использует выбранный пресет после сохранения; пустые наборы допустимы.</p></div>
      <div className="prompt-toolbar">
        <button type="button" disabled={saving} onClick={newPreset}>Новый пустой</button>
        <button type="button" disabled={saving||!active} onClick={duplicate}>Дублировать</button>
        <button type="button" disabled={saving||!active||active.isBuiltIn} onClick={removePreset}>Удалить пресет</button>
        <button type="button" disabled={saving} onClick={restoreDefault}>Восстановить Default</button>
        <button type="button" disabled={saving||!active} onClick={exportActive}>Экспорт JSON</button>
        <button type="button" disabled={saving} onClick={()=>fileRef.current?.click()}>Импорт JSON</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={event=>void importPreset(event)}/>
        <button type="button" disabled={saving||!dirty} onClick={()=>void save()}>Сохранить изменения</button>
      </div>
    </header>
    {(localMessage||message)&&<div className="notice" role="status">{localMessage||message}</div>}
    <div className="prompt-preset-select">
      <label>Активный пресет<select value={draft.activePresetId} disabled={saving} onChange={event=>{setDraft(prev=>({...prev,activePresetId:event.target.value}));setSelectedPromptId("");setLocalMessage("");}}>
        {draft.presets.map(p=><option key={p.id} value={p.id}>{p.name}{p.isBuiltIn?" · встроенный":""}</option>)}
      </select></label>
      {active&&<span className="prompt-status">schema v{active.schemaVersion} · версия {active.version} · {active.prompts.length} промтов</span>}
      {dirty&&<span className="hint">Есть несохранённые изменения</span>}
      {!active&&<span className="error">Активный пресет отсутствует; скрытого fallback нет.</span>}
    </div>
    {active&&<>
      <section className="prompt-preset-details">
        <label>Название пресета<input value={active.name} maxLength={100} disabled={saving||active.isBuiltIn} onChange={event=>updatePreset(active.id,p=>({...p,name:event.target.value}))}/></label>
        <label>Описание<textarea value={active.description} maxLength={2000} rows={2} disabled={saving} onChange={event=>updatePreset(active.id,p=>({...p,description:event.target.value}))}/></label>
      </section>
      <section className="prompt-editor-layout">
        <div className="prompt-records">
          <div className="prompt-section-title"><h3>Промты пресета</h3><button type="button" disabled={saving||active.prompts.length>=128} onClick={addPrompt}>Добавить</button></div>
          {active.prompts.length===0&&<p className="hint">Список пуст. После сохранения этот пресет намеренно не добавляет инструкций.</p>}
          {active.prompts.slice().sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).map(p=><button key={p.id} type="button" className={"prompt-record-row"+(selected?.id===p.id?" selected":"")} onClick={()=>setSelectedPromptId(p.id)}>
            <strong>{p.title||"(без названия)"}</strong><span className="prompt-record-meta">{p.agentId} · {p.enabled?"включён":"отключён"} · order {p.order}</span>
          </button>)}
        </div>
        <div className="prompt-editor">
          {selected?<><div className="prompt-section-title"><h3>Редактор промта</h3><button type="button" disabled={saving} onClick={removePrompt}>Удалить промт</button></div>
            <label>Название<input value={selected.title} maxLength={120} disabled={saving} onChange={event=>updateSelected(p=>({...p,title:event.target.value}))}/></label>
            <div className="prompt-fields">
              <label>Agent ID<input value={selected.agentId} maxLength={80} disabled={saving} onChange={event=>updateSelected(p=>({...p,agentId:event.target.value.trim().toLowerCase()}))}/><small>Например, nova, memory-agent или memory-judge.</small></label>
              <label>Категория<input value={selected.category??""} maxLength={120} disabled={saving} onChange={event=>updateSelected(p=>({...p,category:event.target.value}))}/></label>
              <label>Порядок включения<input type="number" min={-100000} max={100000} value={selected.order} disabled={saving} onChange={event=>updateSelected(p=>({...p,order:Number(event.target.value)}))}/></label>
              <label className="checkbox">Активен<input type="checkbox" checked={selected.enabled} disabled={saving} onChange={event=>updateSelected(p=>({...p,enabled:event.target.checked}))}/></label>
            </div>
            <label>Условия применения · сценарии через запятую<input value={(selected.conditions?.scenarios??[]).join(", ")} maxLength={1000} disabled={saving} placeholder="Пусто = все сценарии" onChange={event=>{
              const scenarios=event.target.value.split(",").map(v=>v.trim()).filter(Boolean);
              updateSelected(p=>({...p,conditions:scenarios.length?{...(p.conditions??{}),scenarios}:undefined}));
            }}/><small>Стандартные сценарии: reactive, background, after-tool, structured, plain. Допустимы пользовательские метки и *.</small></label>
            <label>Полный текст инструкции<textarea value={selected.text} maxLength={12000} rows={20} spellCheck={false} disabled={saving} onChange={event=>updateSelected(p=>({...p,text:event.target.value}))}/></label>
          </>:<p className="hint">Выберите промт или создайте новый. Пустой набор инструкций разрешён.</p>}
        </div>
      </section>
    </>}
    <section className="prompt-diagnostics">
      <h3>Диагностика сборки инструкций</h3>
      <div className="prompt-fields">
        <label>Агент<select value={agent} onChange={event=>setAgent(event.target.value)}>{agents.map(a=><option key={a} value={a}>{a}</option>)}</select></label>
        <label>Сценарий<select value={scenario} onChange={event=>setScenario(event.target.value)}>
          <option value="reactive">reactive — реактивный ход</option><option value="background">background — фоновый ход</option>
          <option value="reactive+after-tool">reactive+after-tool — после инструмента в реактивном ходе</option>
          <option value="background+after-tool">background+after-tool — после инструмента в фоновом ходе</option>
          <option value="after-tool">after-tool — пользовательский этап после инструмента</option><option value="structured">structured — формат JSON</option><option value="plain">plain — обычный текст</option><option value="custom">Пользовательский</option>
        </select></label>
      </div>
      {scenario==="custom"&&<label>Имя сценария<input value={customScenario} onChange={event=>setCustomScenario(event.target.value)}/></label>}
      <p className="hint">Пресет: {assembly.presetName??"отсутствует"} · schema v{assembly.presetSchemaVersion??"—"} · агент: {assembly.agentId} · сценарий: {assembly.scenario}</p>
      {assembly.error&&<p className="error">{assembly.error}</p>}
      <h4>Включённые записи в порядке runtime</h4>
      {assembly.included.length===0&&<p className="hint">Ни одной инструкции не включено; скрытые заводские инструкции не добавляются.</p>}
      <ol className="prompt-diagnostic-records">{assembly.included.map(p=><li key={p.id}><strong>{p.title}</strong> <small>{p.id} · agent {p.agentId} matched · enabled · scenarios {(p.conditions?.scenarios??[]).join(", ")||"all"} · order {p.order}</small><pre>{p.text}</pre></li>)}</ol>
      <h4>Итоговый текст системных инструкций</h4><pre className="prompt-assembled-text">{assembly.text||"(пусто)"}</pre>
      <details><summary>Исключённые записи ({assembly.excluded.length})</summary><ul>{assembly.excluded.map(item=><li key={item.prompt.id}><strong>{item.prompt.title}</strong> — {item.reason} · {item.prompt.id} · agent {item.prompt.agentId} · enabled {String(item.prompt.enabled)} · scenarios {(item.prompt.conditions?.scenarios??[]).join(", ")||"all"}</li>)}</ul></details>
      <h4>Данные и контракты, передаваемые отдельно</h4>
      {agent==="nova"?<ul><li>Персонаж: имя и описание.</li><li>История диалога, Core Book и собранные воспоминания.</li><li>Числовые параметры когнитивного расписания.</li><li>Схемы зарегистрированных нативных инструментов и параметры генерации / reasoning.</li></ul>
      :agent==="memory-agent"?<ul><li>Релевантный контекст разговора, сообщение пользователя и публичный ответ Nova передаются отдельным user-сообщением.</li><li>JSON Schema structured-ответа передаётся отдельно как responseFormat; валидация и MemoryBroker остаются программными.</li></ul>
      :<ul><li>Новая запись памяти и кандидаты передаются отдельным user-сообщением.</li><li>Response schema и проверка решения судьи остаются отдельными контрактами кода.</li></ul>}
      <p className="hint">Текст инструкций здесь и в runtime формируется одним assemblePromptInstructions. Диагностика не включает динамические значения и секреты текущего запроса.</p>
    </section>
  </main>;
}
export default PromptRegistryView;

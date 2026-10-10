import React from "react";
import {DEFAULT_PROMPT_TEXTS,PROMPT_REGISTRY,resolvePromptText,type AppSettings,type PromptId} from "../../../contracts/src/index";

export interface PromptRegistryViewProps{
  settings:AppSettings;
  saving:boolean;
  message:string;
  onSavePrompt:(id:PromptId,text:string)=>Promise<void>;
  onRestoreAll:()=>Promise<void>;
}

export function PromptRegistryView({settings,saving,message,onSavePrompt,onRestoreAll}:PromptRegistryViewProps){
  const [drafts,setDrafts]=React.useState<Partial<Record<PromptId,string>>>({});
  const lastEffective=React.useRef<Partial<Record<PromptId,string>>>({});
  React.useEffect(()=>{
    setDrafts(previous=>{
      const next={...previous};
      for(const prompt of PROMPT_REGISTRY){
        const resolved=resolvePromptText(settings.prompts,prompt.id);
        if(previous[prompt.id]===undefined||previous[prompt.id]===lastEffective.current[prompt.id])next[prompt.id]=resolved;
        lastEffective.current[prompt.id]=resolved;
      }
      return next;
    });
  },[settings.prompts,settings.semanticDedup.judge.prompt]);

  const categories=[...new Set(PROMPT_REGISTRY.map(prompt=>prompt.category))];
  const current=(id:PromptId)=>resolvePromptText(settings.prompts,id);
  return <main className="prompt-registry-panel">
    <header className="prompt-registry-header">
      <div>
        <h2>Промты</h2>
        <p className="chat-subtitle">Редактируемые текстовые шаблоны, которые приложение реально передаёт моделям. Заводские тексты остаются в коде; непустые переопределения сохраняются в настройках приложения и используются без перезапуска.</p>
      </div>
      <button type="button" className="prompt-reset-all" disabled={saving} onClick={()=>{
        if(window.confirm("Восстановить заводские значения для всех промтов? Все пользовательские переопределения промтов будут удалены.")){
          setDrafts(Object.fromEntries(PROMPT_REGISTRY.map(prompt=>[prompt.id,DEFAULT_PROMPT_TEXTS[prompt.id]])) as Partial<Record<PromptId,string>>);
          void onRestoreAll();
        }
      }}>Восстановить все заводские промты</button>
    </header>
    {message&&<div className="notice" role="status">{message}</div>}
    {categories.map(category=><section className="prompt-category" key={category}>
      <h3>{category}</h3>
      <div className="prompt-list">
        {PROMPT_REGISTRY.filter(prompt=>prompt.category===category).map(prompt=>{
          const draft=drafts[prompt.id]??current(prompt.id);
          const customized=draft!==current(prompt.id);
          const overridden=typeof settings.prompts.overrides[prompt.id]==="string"&&settings.prompts.overrides[prompt.id]!.trim().length>0;
          return <article className="prompt-card" key={prompt.id}>
            <div className="prompt-card-heading">
              <div><h4>{prompt.title}</h4><p>{prompt.purpose}</p></div>
              <span className="prompt-status">{overridden?"Переопределён":"Заводской текст"}</span>
            </div>
            <div className="prompt-fields">
              <label>Заводской текст
                <textarea value={prompt.defaultText} readOnly rows={Math.min(10,Math.max(4,prompt.defaultText.split("\n").length))} spellCheck={false}/>
              </label>
              <label>Текущий текст
                <textarea value={draft} onChange={event=>setDrafts(previous=>({...previous,[prompt.id]:event.currentTarget.value}))} rows={Math.min(10,Math.max(4,draft.split("\n").length))} spellCheck={false} aria-label={"Текущий текст: "+prompt.title}/>
              </label>
            </div>
            <div className="actions">
              <button type="button" disabled={saving||!customized} onClick={()=>void onSavePrompt(prompt.id,draft)}>Сохранить промт</button>
              <button type="button" disabled={saving||!overridden} onClick={()=>{setDrafts(previous=>({...previous,[prompt.id]:prompt.defaultText}));void onSavePrompt(prompt.id,"");}}>Восстановить заводской</button>
              {customized&&<span className="hint">Есть несохранённые изменения</span>}
            </div>
          </article>;
        })}
      </div>
    </section>)}
  </main>;
}

export default PromptRegistryView;


  const syncCharacters=React.useCallback(async(runtimeInstance:FoundationRuntime)=>{
    const list=await runtimeInstance.listCharacters();
    const active=await runtimeInstance.getActiveCharacter();
    const controller=await controllerForCharacter(active.id);
    setCharacters(list);
    setActiveCharacter(active);
    setActiveModelProfile(controller.getModelProfile()??defaultModelProfile(active.id));
    setChatController(current=>current?.getSnapshot().characterId===active.id?current:controller);
  },[controllerForCharacter]);

  const addConfigurationLoadError=React.useCallback((diagnostics:RuntimeDiagnostics):RuntimeDiagnostics=>{
    const recentErrors=[...diagnostics.recentErrors];
    const providerMessage=providerConfigurationErrorRef.current;
    const conversationMessage=conversationLoadErrorRef.current;
    const modelProfileMessage=modelProfileLoadErrorRef.current;
    if(providerMessage){
      recentErrors.push({
        timestamp:new Date().toISOString(),
        source:"provider-configuration",
        code:"LOAD_FAILED",
        message:providerMessage
      });
    }
    if(conversationMessage){
      recentErrors.push({
        timestamp:new Date().toISOString(),
        source:"conversation-storage",
        code:"LOAD_FAILED",
        message:conversationMessage
      });
    }
    if(modelProfileMessage){
      recentErrors.push({
        timestamp:new Date().toISOString(),
        source:"model-profile-storage",
        code:"LOAD_FAILED",
        message:modelProfileMessage
      });
    }
    return recentErrors.length===diagnostics.recentErrors.length?diagnostics:{...diagnostics,recentErrors};
  },[]);

  const refreshRuntime=React.useCallback(async(
    config:ProviderConfiguration|undefined,
    configurationLoadError?:string,
    presetState:ProviderPresetStoreState=providerPresetStateRef.current,
    credentialState:CredentialProfileStoreState=credentialProfileStateRef.current
  )=>{
    providerConfigurationErrorRef.current=configurationLoadError;
    providerPresetStateRef.current=presetState;
    credentialProfileStateRef.current=credentialState;
    await foundationRef.current?.stop();
    const next=await startFoundationRuntime({
      providerConfiguration:config,
      credentialStore,
      characterStore,
      coreBookStore,
      memoryStore,
      retriever,
      retrievalIndexWriter:retriever,
      providerPresetConfigurations:materializePresetConfigurations(presetState.presets,credentialState.profiles),
      activeProviderPresetId:presetState.activePresetId??undefined
    });
    foundationRef.current=next;
    setRuntime(await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(await next.diagnostics())));
    await syncCharacters(next);
    setRuntime(await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(await next.diagnostics())));
    setStartupStatus("ready");
    setStartupError("");
  },[addConfigurationLoadError,characterStore,coreBookStore,memoryStore,credentialStore,retriever,syncCharacters]);

  React.useEffect(()=>{
    let active=true;
    setStartupStatus("initializing");
    setStartupError("");
    let timer:ReturnType<typeof setInterval>|undefined;
    (async()=>{
      try{
        const loaded=await loadProviderConfigurationSafely(configurationStore);
        const legacy=loaded.configuration;
        let credentialState=await credentialProfileStore.load();
        if(!credentialState)credentialState=emptyCredentialProfileState();

        let presetState=await providerPresetStore.load();
        if(!presetState&&legacy){
          const migration=migrateProviderConfiguration(legacy);
          const existing=credentialState.profiles.find(profile=>profile.credentialReference.id===migration.preset.credentialProfileId);
          const nextCredentialProfiles=[
            ...credentialState.profiles,
            ...(migration.credentialProfile&&!existing?[migration.credentialProfile]:[])
          ];
          credentialState={...credentialState,profiles:nextCredentialProfiles};
          presetState={
            ...emptyProviderPresetState(),
            presets:[migration.preset],
            activePresetId:migration.preset.id
          };
          await credentialProfileStore.save(credentialState);
          await providerPresetStore.save(presetState);
        }
        if(!presetState){
          presetState=emptyProviderPresetState();
        }
        if(presetState.presets.length>0&&!presetState.activePresetId){
          presetState={...presetState,activePresetId:presetState.presets[0]!.id};
          await providerPresetStore.save(presetState);
        }

        const saved=legacy;
        if(saved)setConfiguration(saved);
        const savedMap:Record<string,boolean>={};
        for(const profile of credentialState.profiles){
          try{savedMap[profile.id]=await credentialStore.exists(profile.credentialReference);}
          catch{savedMap[profile.id]=false;}
        }
        const activePreset=presetState.activePresetId
          ?presetState.presets.find(preset=>preset.id===presetState.activePresetId)
          :undefined;
        const activeCredential=activePreset?.credentialProfileId
          ?credentialState.profiles.find(profile=>profile.id===activePreset.credentialProfileId)
          :undefined;
        const activeConfiguration=activePreset
          ?materializeProviderConfiguration(activePreset,activeCredential)
          :undefined;

        setCredentialProfiles(credentialState.profiles);
        setCredentialSavedMap(savedMap);
        setProviderPresets(presetState.presets);
        setActivePresetId(presetState.activePresetId);
        providerPresetStateRef.current=presetState;
        credentialProfileStateRef.current=credentialState;

        if(loaded.error){
          setSettingsMessage("Legacy provider configuration could not be loaded: "+loaded.error);
        }
        if(legacy){
          setCredentialSaved(Boolean(legacy.credentialReference&&savedMap[
            credentialState.profiles.find(profile=>profile.credentialReference.id===legacy.credentialReference?.id)?.id??""
          ]));
        }else{
          setCredentialSaved(false);
        }

        await refreshRuntime(activeConfiguration,loaded.error,presetState,credentialState);
        if(!active)return;
        setStartupStatus("ready");
        const hostSnapshot=await loadHost();
        if(active)setHost(hostSnapshot);
        const sync=async()=>{
          const foundation=foundationRef.current;
          if(!foundation||!active)return;
          try{
            const snapshot=await foundation.diagnostics();
            const live=await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(snapshot));
            if(active)setRuntime(live);
          }catch{
            if(active)setRuntime(current=>({...current,runtimeStatus:"error",coreStatus:"error"}));
          }
        };
        await sync();
        timer=setInterval(()=>{void sync()},1000);
      }catch(error){
        if(active){
          setStartupStatus("error");
          setStartupError(safeStartupError(error));
          setRuntime({...preview,runtimeStatus:"error",coreStatus:"error"});
        }
      }
    })();
    return ()=>{
      active=false;
      if(timer)clearInterval(timer);
      void foundationRef.current?.stop();
      foundationRef.current=undefined;
    };
  },[configurationStore,credentialProfileStore,providerPresetStore,credentialStore,refreshRuntime]);

  const selectCharacter=React.useCallback(async(id:string)=>{
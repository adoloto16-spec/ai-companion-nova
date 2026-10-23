import React from "react";
import { availableMonitors, getAllWindows, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import {
  DEFAULT_AVATAR_SETTINGS, findUniqueMatchingMonitor, normalizeAvatarSettings, publishAvatarIntent, publishAvatarProfileUpdated,
  resolveAvatarSignal, resolveOverlayPlacement, subscribeAvatarEvents, type AvatarIntent, type AvatarMonitorGeometry,
  type AvatarProfile, type AvatarSettings, type ScreenCaptureGeometry
} from "../../../modules/character/src/index";
import type { ScreenRegion } from "../../../modules/vision/src/index";
import { addAvatarModel, deleteAvatarProfile, getActiveAvatarProfileId, listAvatarProfiles, saveAvatarProfile, setActiveAvatarProfile } from "./avatar-library";
import VrmAvatarCanvas from "./vrm-avatar-canvas";
import ScreenUnderstandingPanel from "./screen-understanding-panel";
import "./avatar.css";

async function findOverlay() {
  return (await getAllWindows()).find(window => window.label === "avatar-overlay");
}

export default function AvatarStudioView({ visionModel, visionBaseUrl }: { visionModel: string; visionBaseUrl: string }) {
  const [profiles, setProfiles] = React.useState<AvatarProfile[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [settings, setSettings] = React.useState<AvatarSettings>({ ...DEFAULT_AVATAR_SETTINGS });
  const [intent, setIntent] = React.useState<AvatarIntent>(() => resolveAvatarSignal({ type: "dialogue", text: "", speaking: false }));
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const active = profiles.find(profile => profile.id === activeId);

  const refresh = React.useCallback(async (preferred?: string | null) => {
    const next = await listAvatarProfiles();
    const savedId = await getActiveAvatarProfileId();
    const selectedId = preferred && next.some(p => p.id === preferred) ? preferred :
      savedId && next.some(p => p.id === savedId) ? savedId : next[0]?.id ?? null;
    setProfiles(next); setActiveId(selectedId);
    const selected = next.find(p => p.id === selectedId);
    if (selected) {
      setName(selected.name); setSettings(normalizeAvatarSettings(selected.settings));
      if (savedId !== selected.id) await setActiveAvatarProfile(selected.id);
    } else { setName(""); setSettings({ ...DEFAULT_AVATAR_SETTINGS }); }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void refresh().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Avatar library could not be loaded."); });
    const unsubscribe = subscribeAvatarEvents(event => {
      if (event.kind === "intent") setIntent(event.intent);
      else void refresh().catch(cause => setError(cause instanceof Error ? cause.message : "Avatar refresh failed."));
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [refresh]);

  const importModel = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const profile = await addAvatarModel(file);
      await refresh(profile.id); publishAvatarProfileUpdated();
      setMessage("Imported " + profile.name + ". Model data stays in local IndexedDB.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Model import failed."); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const save = async () => {
    if (!active) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const saved = await saveAvatarProfile(active, settings, name);
      await refresh(saved.id);
      const overlay = await findOverlay();
      if (overlay) await overlay.setIgnoreCursorEvents(saved.settings.overlayPassthrough);
      publishAvatarProfileUpdated(); setMessage("Avatar profile saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Avatar profile could not be saved."); }
    finally { setBusy(false); }
  };
  const selectProfile = async (id: string) => {
    setError(""); setMessage("");
    try { await setActiveAvatarProfile(id); await refresh(id); publishAvatarProfileUpdated(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not select the avatar."); }
  };
  const remove = async () => {
    if (!active || !window.confirm("Delete this local avatar model and its settings?")) return;
    setBusy(true); setError(""); setMessage("");
    try { await deleteAvatarProfile(active.id); await refresh(); publishAvatarProfileUpdated(); setMessage("Avatar profile deleted."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete the avatar."); }
    finally { setBusy(false); }
  };
  const openOverlay = async () => {
    if (!active) { setError("Import a model first."); return; }
    setError(""); setMessage("");
    try {
      const overlay = await findOverlay();
      if (!overlay) throw new Error("The Tauri avatar-overlay window is not available.");
      await overlay.setIgnoreCursorEvents(settings.overlayPassthrough);
      await overlay.show();
      if (!settings.overlayPassthrough) await overlay.setFocus();
      setMessage("Desktop avatar window shown. Drag the avatar window to reposition it.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not show desktop avatar."); }
  };
  const hideOverlay = async () => {
    try { const overlay = await findOverlay(); if (overlay) await overlay.hide(); setMessage("Desktop avatar window hidden."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not hide desktop avatar."); }
  };
  const pointAt = async (region: ScreenRegion, capture: ScreenCaptureGeometry) => {
    setError(""); setMessage("");
    try {
      const next = resolveAvatarSignal({ type: "screen-region", label: region.label, bounds: region.bounds, confidence: region.confidence });
      const monitorList = await availableMonitors();
      const geometries: AvatarMonitorGeometry[] = monitorList.map(monitor => ({
        name: monitor.name,
        physicalSize: { width: monitor.size.width, height: monitor.size.height },
        logicalPosition: monitor.position.toLogical(monitor.scaleFactor),
        logicalSize: monitor.size.toLogical(monitor.scaleFactor),
        workAreaPosition: monitor.workArea.position.toLogical(monitor.scaleFactor),
        workAreaSize: monitor.workArea.size.toLogical(monitor.scaleFactor),
        scaleFactor: monitor.scaleFactor
      }));
      const monitor = findUniqueMatchingMonitor(capture, geometries);
      if (!monitor) {
        setIntent(next); publishAvatarIntent(next);
        setMessage(capture.surface === "window" || capture.surface === "browser"
          ? "Pointing from the current location. To move beside the target, share the entire monitor rather than a window or browser tab."
          : "Pointing from the current location. The captured dimensions did not match exactly one monitor, so Nova did not guess desktop coordinates.");
        return;
      }
      const overlay = await findOverlay();
      if (!overlay) throw new Error("The Tauri desktop overlay is not available.");
      const placement = resolveOverlayPlacement(region.bounds, monitor);
      const previousMonitor = await overlay.currentMonitor();
      const physicalStart = await overlay.outerPosition();
      const start = physicalStart.toLogical(previousMonitor?.scaleFactor ?? monitor.scaleFactor);
      const walk: AvatarIntent = {
        action: "walk", expression: "happy", intensity: 1,
        target: next.target, label: region.label
      };
      setIntent(walk); publishAvatarIntent(walk);
      await overlay.setSize(new LogicalSize(placement.width, placement.height));
      await overlay.setIgnoreCursorEvents(settings.overlayPassthrough);
      await overlay.show();
      for (let step = 1; step <= 12; step++) {
        const t = step / 12;
        const eased = t * t * (3 - 2 * t);
        await overlay.setPosition(new LogicalPosition(
          start.x + (placement.x - start.x) * eased,
          start.y + (placement.y - start.y) * eased
        ));
        await new Promise<void>(resolve => window.setTimeout(resolve, 24));
      }
      await overlay.setPosition(new LogicalPosition(placement.x, placement.y));
      setIntent(next); publishAvatarIntent(next);
      setMessage("Nova moved the desktop avatar beside “" + region.label + "” and is pointing at the estimated region. Positioning is approximate.");
    } catch (cause) {
      try {
        const fallback = resolveAvatarSignal({ type: "screen-region", label: region.label, bounds: region.bounds, confidence: region.confidence });
        setIntent(fallback); publishAvatarIntent(fallback);
      } catch { /* Preserve the original placement error. */ }
      setError(cause instanceof Error ? cause.message : "Could not move the desktop avatar to this screen region.");
    }
  };
  const update = <K extends keyof AvatarSettings>(key: K, value: AvatarSettings[K]) => {
    setSettings(current => normalizeAvatarSettings({ ...current, [key]: value }));
  };

  return <main className="avatar-studio">
    <header className="avatar-studio-header">
      <div><p className="eyebrow">NOVA / AVATAR SYSTEM</p><h2>Avatar Studio</h2><p>Separate model, motion and screen-understanding subsystem.</p></div>
      <div className="avatar-toolbar">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>Import VRM / GLB</button>
        <button type="button" className="secondary-button" onClick={() => void openOverlay()} disabled={!active || busy}>Show desktop avatar</button>
        <button type="button" className="secondary-button" onClick={() => void hideOverlay()}>Hide overlay</button>
        <input ref={fileRef} className="visually-hidden" type="file" accept=".vrm,.glb,model/gltf-binary,application/octet-stream" onChange={event => void importModel(event.currentTarget.files?.[0])}/>
      </div>
    </header>
    <div className="avatar-studio-grid">
      <section className="avatar-preview-card">
        <div className="avatar-preview-stage">
          <VrmAvatarCanvas profile={active} settings={settings} intent={intent}/>
          {!active && <div className="avatar-empty-overlay"><strong>Import your first model</strong><span>VRM has priority; self-contained GLB files are also supported.</span><button type="button" onClick={() => fileRef.current?.click()}>Select model</button></div>}
          {active && <div className="avatar-model-chip"><span className="status-dot active"/>{active.format.toUpperCase()} · {active.name}</div>}
        </div>
        <div className="avatar-preview-actions">
          <button type="button" onClick={() => { const next=resolveAvatarSignal({type:"user-action",action:"wave"}); setIntent(next); publishAvatarIntent(next); }} disabled={!active}>Wave / greet</button>
          <button type="button" onClick={() => { const next=resolveAvatarSignal({type:"user-action",action:"look"}); setIntent(next); publishAvatarIntent(next); }} disabled={!active}>Look around</button>
          <span>{active ? "Save profile to persist changes." : "No active avatar"}</span>
        </div>
      </section>
      <aside className="avatar-settings-card">
        <div className="section-heading"><div><h3>Model library</h3><p>Original model files stay local.</p></div><span>{profiles.length} saved</span></div>
        <label>Active avatar
          <select value={activeId ?? ""} onChange={event => void selectProfile(event.target.value)} disabled={!profiles.length || busy}>
            {!profiles.length && <option value="">No imported models</option>}
            {profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.name} · {profile.format.toUpperCase()}</option>)}
          </select>
        </label>
        <label>Profile name<input value={name} onChange={event => setName(event.target.value)} disabled={!active || busy} maxLength={120}/></label>
        <hr/><h3>Appearance and motion</h3>
        <label className="avatar-slider-label">Model scale <output>{settings.scale.toFixed(2)}×</output>
          <input type="range" min="0.5" max="1.8" step="0.05" value={settings.scale} onChange={event => update("scale", Number(event.target.value))} disabled={!active || busy}/>
        </label>
        <label className="avatar-slider-label">Camera distance <output>{settings.cameraDistance.toFixed(1)}×</output>
          <input type="range" min="1.1" max="3.5" step="0.1" value={settings.cameraDistance} onChange={event => update("cameraDistance", Number(event.target.value))} disabled={!active || busy}/>
        </label>
        <label className="avatar-slider-label">Motion intensity <output>{Math.round(settings.motionIntensity*100)}%</output>
          <input type="range" min="0" max="2" step="0.1" value={settings.motionIntensity} onChange={event => update("motionIntensity", Number(event.target.value))} disabled={!active || busy}/>
        </label>
        <div className="avatar-toggle-grid">
          <label><input type="checkbox" checked={settings.idleMotion} onChange={event => update("idleMotion", event.target.checked)} disabled={!active || busy}/> Idle motion</label>
          <label><input type="checkbox" checked={settings.breathing} onChange={event => update("breathing", event.target.checked)} disabled={!active || busy}/> Breathing</label>
          <label><input type="checkbox" checked={settings.blink} onChange={event => update("blink", event.target.checked)} disabled={!active || busy}/> Blinking</label>
          <label><input type="checkbox" checked={settings.lookAround} onChange={event => update("lookAround", event.target.checked)} disabled={!active || busy}/> Look around</label>
          <label><input type="checkbox" checked={settings.overlayPassthrough} onChange={event => update("overlayPassthrough", event.target.checked)} disabled={!active || busy}/> Pass pointer through overlay</label>
        </div>
        <label>Autonomy<select value={settings.autonomy} onChange={event => update("autonomy", event.target.value as AvatarSettings["autonomy"])} disabled={!active || busy}>
          <option value="off">Off — only explicit actions</option><option value="balanced">Balanced</option><option value="active">Active</option>
        </select></label>
        <div className="avatar-toolbar"><button type="button" onClick={() => void save()} disabled={!active || busy}>Save profile</button><button type="button" className="danger-button" onClick={() => void remove()} disabled={!active || busy}>Delete model</button></div>
        <div className="live2d-status"><strong>Live2D adapter</strong><span>Not configured: Cubism SDK runtime is not installed or bundled.</span></div>
      </aside>
    </div>
    <ScreenUnderstandingPanel model={visionModel} baseUrl={visionBaseUrl} onPointAt={pointAt}/>
    {(message || error) && <div className={error ? "avatar-notice error" : "avatar-notice"} role={error ? "alert" : "status"}>{error || message}</div>}
  </main>;
}

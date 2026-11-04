import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveAvatarSignal, subscribeAvatarEvents, type AvatarIntent, type AvatarProfile } from "../../../modules/character/src/index";
import { getActiveAvatarBundle } from "./avatar-library";
import VrmAvatarCanvas from "./vrm-avatar-canvas";
import "./avatar.css";

export default function AvatarOverlay() {
  const [bundle, setBundle] = React.useState<{ profile: AvatarProfile; asset: Blob }>();
  const [intent, setIntent] = React.useState<AvatarIntent>(() => resolveAvatarSignal({ type: "dialogue", text: "", speaking: false }));
  const [error, setError] = React.useState("");
  const [cursorTarget, setCursorTarget] = React.useState<{x:number;y:number}>();
  const refresh = React.useCallback(async () => {
    try {
      const next = await getActiveAvatarBundle();
      setBundle(next); setError("");
      if (next) await getCurrentWindow().setIgnoreCursorEvents(next.profile.settings.overlayPassthrough);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Avatar overlay could not load the local model."); }
  }, []);
  React.useEffect(() => {
    void refresh();
    return subscribeAvatarEvents(event => {
      if (event.kind === "intent") setIntent(event.intent);
      else void refresh();
    });
  }, [refresh]);
  React.useEffect(() => {
    if (!bundle?.profile.settings.trackCursor) { setCursorTarget(undefined); return; }
    const overlayWindow = getCurrentWindow();
    let active = true;
    let pending = false;
    const poll = async () => {
      if (!active || pending) return;
      pending = true;
      try {
        const [position, size] = await Promise.all([overlayWindow.cursorPosition(), overlayWindow.innerSize()]);
        if (!active) return;
        setCursorTarget({
          x: Math.max(-1, Math.min(2, position.x / Math.max(1, size.width))),
          y: Math.max(-1, Math.min(2, position.y / Math.max(1, size.height)))
        });
      } catch { /* Cursor polling is optional; a transient window error must not stop rendering. */ }
      finally { pending = false; }
    };
    const handle = window.setInterval(() => { void poll(); }, 40);
    void poll();
    return () => { active = false; window.clearInterval(handle); };
  }, [bundle?.profile.id, bundle?.profile.settings.trackCursor]);
  if (error) return <div className="avatar-overlay-error" role="alert">{error}</div>;
  if (!bundle) return <div className="avatar-overlay-empty">Import a VRM or GLB model in Avatar Studio.</div>;
  return <div className="avatar-overlay-root" data-tauri-drag-region>
    <VrmAvatarCanvas profile={bundle.profile} settings={bundle.profile.settings} intent={intent} cursorTarget={cursorTarget} className="avatar-overlay-canvas"/>
  </div>;
}

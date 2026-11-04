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
      if (next) await getCurrentWindow().setIgnoreCursorEvents(next.profile.settings.overlayPassthrough && !next.profile.settings.trackCursor);
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
    let active = true;
    let frame = 0;
    let latest = { x: 0.5, y: 0.5 };
    const handlePointerMove = (event: PointerEvent) => {
      latest = {
        x: Math.max(-1, Math.min(2, event.clientX / Math.max(1, window.innerWidth))),
        y: Math.max(-1, Math.min(2, event.clientY / Math.max(1, window.innerHeight)))
      };
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (active) setCursorTarget(latest);
      });
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      active = false;
      window.removeEventListener("pointermove", handlePointerMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [bundle?.profile.id, bundle?.profile.settings.trackCursor]);
  if (error) return <div className="avatar-overlay-error" role="alert">{error}</div>;
  if (!bundle) return <div className="avatar-overlay-empty">Import a VRM or GLB model in Avatar Studio.</div>;
  return <div className="avatar-overlay-root" data-tauri-drag-region>
    <VrmAvatarCanvas profile={bundle.profile} settings={bundle.profile.settings} intent={intent} cursorTarget={cursorTarget} className="avatar-overlay-canvas"/>
  </div>;
}

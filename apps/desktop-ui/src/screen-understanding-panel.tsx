import React from "react";
import { TauriOllamaHttpClient } from "./ollama-http-client";
import { analyzeScreenFrame, type ScreenFrame, type ScreenRegion, type ScreenObservation } from "../../../modules/vision/src/index";
import type { ScreenCaptureGeometry } from "../../../modules/character/src/index";

const ollama = new TauriOllamaHttpClient(120_000);

export default function ScreenUnderstandingPanel({ model, baseUrl, onPointAt }: {
  model: string; baseUrl: string; onPointAt: (region: ScreenRegion, capture: ScreenCaptureGeometry) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [visionModel, setVisionModel] = React.useState(model);
  const [endpoint, setEndpoint] = React.useState(baseUrl || "http://127.0.0.1:11434");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [preview, setPreview] = React.useState("");
  const [observation, setObservation] = React.useState<ScreenObservation>();

  React.useEffect(() => { if (model.trim()) setVisionModel(model); }, [model]);
  React.useEffect(() => { if (baseUrl.trim()) setEndpoint(baseUrl); }, [baseUrl]);
  React.useEffect(() => {
    const video = videoRef.current;
    if (video && stream && video.srcObject !== stream) video.srcObject = stream;
    if (video && !stream) video.srcObject = null;
    return () => { if (video?.srcObject === stream) video.srcObject = null; };
  }, [stream]);
  React.useEffect(() => () => stream?.getTracks().forEach(track => track.stop()), [stream]);

  const captureGeometry = React.useCallback((): ScreenCaptureGeometry => {
    const video = videoRef.current;
    const track = stream?.getVideoTracks()[0];
    const raw = (track?.getSettings() ?? {}) as MediaTrackSettings & { displaySurface?: string };
    const surface = raw.displaySurface === "monitor" || raw.displaySurface === "window" || raw.displaySurface === "browser"
      ? raw.displaySurface : "unknown";
    const width = typeof raw.width === "number" && Number.isFinite(raw.width) ? raw.width : video?.videoWidth ?? 0;
    const height = typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : video?.videoHeight ?? 0;
    return { surface, width, height };
  }, [stream]);

  const stopCapture = React.useCallback(() => {
    stream?.getTracks().forEach(track => track.stop());
    setStream(null);
    setObservation(undefined);
  }, [stream]);

  const startCapture = async () => {
    setError(""); setObservation(undefined); setPreview("");
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture is unavailable in this WebView.");
      const next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      const video = videoRef.current;
      if (!video) { next.getTracks().forEach(track => track.stop()); throw new Error("Screen preview element is unavailable."); }
      video.srcObject = next;
      await video.play();
      next.getVideoTracks().forEach(track => track.addEventListener("ended", () => setStream(null), { once: true }));
      setStream(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start screen sharing.");
    }
  };

  const analyze = async () => {
    const video = videoRef.current;
    if (!video || !stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1 || video.videoHeight < 1) {
      setError("Start screen sharing and wait for the preview before analyzing."); return;
    }
    if (!visionModel.trim()) { setError("Choose your existing local Ollama vision model."); return; }
    setBusy(true); setError("");
    try {
      const maxDimension = 1024;
      const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare the captured frame.");
      context.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.62);
      setPreview(dataUrl);
      const frame: ScreenFrame = {
        imageBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), width, height,
        capturedAt: new Date().toISOString(), source: "display-capture"
      };
      const normalizedUrl = endpoint.trim().replace(/\/+$/, "");
      if (!normalizedUrl) throw new Error("Configure the local Ollama endpoint.");
      const result = await analyzeScreenFrame(frame, {
        analyzeImage: async request => {
          const response = await ollama.request({
            url: normalizedUrl + "/api/chat", method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: request.model, stream: false, format: "json",
              messages: [{ role: "user", content: request.prompt, images: [request.imageBase64] }],
              options: { temperature: 0.1 }
            }),
            ...(request.signal ? { signal: request.signal } : {})
          });
          if (response.status < 200 || response.status >= 300) {
            let detail = "";
            try { const parsed = JSON.parse(response.body) as { error?: unknown }; if (typeof parsed.error === "string") detail = parsed.error.slice(0, 240); } catch { /* no response detail */ }
            throw new Error(detail || "Local Ollama returned HTTP " + response.status + ".");
          }
          const parsed = JSON.parse(response.body) as { message?: { content?: unknown }; error?: unknown };
          if (typeof parsed.message?.content !== "string") throw new Error(typeof parsed.error === "string" ? parsed.error : "The local vision model returned no message content.");
          return parsed.message.content;
        }
      }, visionModel, undefined);
      setObservation(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screen analysis failed.");
    } finally { setBusy(false); }
  };

  return <section className="screen-understanding">
    <div className="section-heading">
      <div><h3>Screen Understanding</h3><p>Capture is explicit; Nova sends only the selected frame to the configured local Ollama endpoint.</p></div>
      <span className={stream ? "status-dot active" : "status-dot"}>{stream ? "Sharing" : "Stopped"}</span>
    </div>
    <video ref={videoRef} muted playsInline className="screen-capture-source" aria-hidden="true" />
    <div className="screen-vision-fields">
      <label>Existing vision model
        <input value={visionModel} onChange={event => setVisionModel(event.target.value)} placeholder="Ollama model name" spellCheck={false}/>
      </label>
      <label>Local Ollama endpoint
        <input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:11434" spellCheck={false}/>
      </label>
    </div>
    <div className="avatar-toolbar">
      {!stream
        ? <button type="button" onClick={() => void startCapture()}>Share screen…</button>
        : <>
            <button type="button" onClick={() => void analyze()} disabled={busy}>{busy ? "Analyzing…" : "Analyze current frame"}</button>
            <button type="button" className="secondary-button" onClick={stopCapture} disabled={busy}>Stop sharing</button>
          </>}
    </div>
    <p className="privacy-note">No continuous analysis is started. Use Stop sharing to end capture. Regions are estimates. To move the desktop avatar beside a target, share the entire monitor rather than a window or browser tab.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {observation && <div className="screen-observation">
      <p className="screen-summary">{observation.summary}</p>
      {preview && <div className="vision-preview">
        <img src={preview} alt="Captured screen frame analyzed locally"/>
        {observation.regions.map(region => <button key={region.id} type="button" className="vision-region-hitbox"
          style={{ left: region.bounds.x * 100 + "%", top: region.bounds.y * 100 + "%", width: region.bounds.width * 100 + "%", height: region.bounds.height * 100 + "%" }}
          aria-label={"Point avatar at " + region.label} title={region.label + " · " + Math.round(region.confidence * 100) + "%"}
          onClick={() => onPointAt(region, captureGeometry())}/>)}
      </div>}
      <div className="screen-region-list">
        {observation.regions.map(region => <article className="screen-region-row" key={region.id}>
          <div><strong>{region.label}</strong><p>{region.description}</p><small>Model confidence estimate: {Math.round(region.confidence * 100)}%</small></div>
          <button type="button" className="secondary-button" onClick={() => onPointAt(region, captureGeometry())}>Point</button>
        </article>)}
        {!observation.regions.length && <p>No visible regions were returned. Try a clearer frame or check that the configured model supports image input.</p>}
      </div>
    </div>}
  </section>;
}

export interface PassiveDiagnosticsOptions {
  skipProviderHealthFor: readonly string[];
}

/**
 * Background status refreshes may reuse the last Ollama health result because its
 * health() probes /api/tags over HTTP. Other providers keep their existing probe path.
 */
export function passiveDiagnosticsOptions(providerId: string | undefined): PassiveDiagnosticsOptions | undefined {
  return providerId === "ollama" ? { skipProviderHealthFor: ["ollama"] } : undefined;
}

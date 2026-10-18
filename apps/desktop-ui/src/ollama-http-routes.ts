/** Pure allowlist for the local Ollama bridge; callers separately enforce loopback URL validation. */
export function isAllowedOllamaRoute(pathname: string, method: string): boolean {
  if (pathname === "/api/tags" || pathname === "/api/version") return method === "GET";
  if (pathname === "/api/chat" || pathname === "/api/show") return method === "POST";
  return false;
}

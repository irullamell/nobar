// Util routing kecil: baca parameter dinamis baik di Vercel (req.query)
// maupun di dev harness (parse dari URL).
import type { IncomingMessage } from "node:http";

export function routeParam(req: IncomingMessage, name: string): string | null {
  const maybeQuery = (req as IncomingMessage & { query?: Record<string, unknown> }).query;
  const fromQuery = maybeQuery?.[name];
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  // Fallback: cocokkan pola /api/rooms/<code>/... dari URL.
  const url = req.url ?? "";
  const m = url.match(/^\/api\/rooms\/([^/?]+)/);
  if (m && name === "code") return decodeURIComponent(m[1]);
  return null;
}

export function queryParam(req: IncomingMessage, name: string): string | null {
  const maybeQuery = (req as IncomingMessage & { query?: Record<string, unknown> }).query;
  const fromQuery = maybeQuery?.[name];
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return null;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  return params.get(name);
}

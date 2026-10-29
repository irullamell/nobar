// POST /api/rooms/:code/messages — kirim chat/reaksi/sinyal WebRTC.
import type { IncomingMessage, ServerResponse } from "node:http";
import { postMessage } from "../../_lib/rooms.js";
import { err, readJsonBody, result, sendJson } from "../../_lib/http.js";
import { routeParam } from "../../_lib/route.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, err(405, "METHOD_NOT_ALLOWED"));
  const code = routeParam(req, "code");
  if (!code) return sendJson(res, err(400, "INVALID_CODE"));
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch {
    return sendJson(res, err(400, "INVALID_JSON"));
  }
  sendJson(res, await result(postMessage(code, body)));
}

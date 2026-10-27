// POST /api/rooms/:code/host — aksi moderasi host: kick, ban, unban,
// set-password, rename, set-max-viewers, close.
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostAction } from "../../_lib/rooms.js";
import { err, readJsonBody, sendJson } from "../../_lib/http.js";
import { routeParam } from "../../_lib/route.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, err(405, "METHOD_NOT_ALLOWED"));
  const code = routeParam(req, "code");
  if (!code) return sendJson(res, err(400, "INVALID_CODE"));
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, err(400, "INVALID_JSON"));
  }
  sendJson(res, await hostAction(code, body));
}

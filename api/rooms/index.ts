// POST /api/rooms — buat room baru (host).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRoom } from "../_lib/rooms.js";
import { clientIp, err, readJsonBody, sendJson } from "../_lib/http.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, err(405, "METHOD_NOT_ALLOWED"));
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, err(400, "INVALID_JSON"));
  }
  sendJson(res, await createRoom({ ...body, ip: clientIp(req) }));
}

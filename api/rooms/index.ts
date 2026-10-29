// POST /api/rooms          — buat room baru (host).
// GET  /api/rooms?list=public — daftar room yang diaktifkan publik oleh host-nya.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRoom, listPublicRooms } from "../_lib/rooms.js";
import { clientIp, err, readJsonBody, result, sendJson } from "../_lib/http.js";
import { queryParam } from "../_lib/route.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    const list = queryParam(req, "list");
    if (list === "public") return sendJson(res, await result(listPublicRooms(clientIp(req))));
    return sendJson(res, err(400, "UNKNOWN_LIST", "Gunakan ?list=public."));
  }
  if (req.method !== "POST") return sendJson(res, err(405, "METHOD_NOT_ALLOWED"));
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, err(400, "INVALID_JSON"));
  }
  sendJson(res, await result(createRoom({ ...body, ip: clientIp(req) })));
}

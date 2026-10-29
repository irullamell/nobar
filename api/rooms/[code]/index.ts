// GET /api/rooms/:code — info publik room (hanya jika tahu kodenya).
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRoomInfo } from "../../_lib/rooms.js";
import { clientIp, err, result, sendJson } from "../../_lib/http.js";
import { routeParam } from "../../_lib/route.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, err(405, "METHOD_NOT_ALLOWED"));
  const code = routeParam(req, "code");
  if (!code) return sendJson(res, err(400, "INVALID_CODE"));
  sendJson(res, await result(getRoomInfo(code, clientIp(req))));
}

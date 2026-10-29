// GET /api/rooms/:code/events — aliran SSE (pengganti WebSocket di Vercel).
// Token peer dikirim lewat header Authorization (lebih aman daripada query).
// Klien me-reconnect otomatis dengan cursor (Last-Event-ID / query "cursor").
import type { IncomingMessage, ServerResponse } from "node:http";
import { streamEvents } from "../../_lib/rooms.js";
import { queryParam, routeParam } from "../../_lib/route.js";
import { getStorageMode } from "../../_lib/store.js";
import { SSE_MAX_DURATION_MS } from "../../../shared/protocol.js";

export const maxDuration = 60; // detik; didukung Fluid Compute (Hobby: default 300)

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Produksi tanpa Redis: balas JSON 503 yang jelas (sebelum header SSE dikirim).
  if (getStorageMode() === "missing") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "STORAGE_NOT_CONFIGURED",
        message: "Tambahkan UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN di Vercel, lalu deploy ulang.",
      }),
    );
    return;
  }

  const code = routeParam(req, "code");
  const peerId = queryParam(req, "peerId");
  const cursor = queryParam(req, "cursor");
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (queryParam(req, "token") ?? "");

  if (!code || !peerId || !token) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "MISSING_PARAMS" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1500\n\n");

  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  req.on("error", () => {
    closed = true;
  });

  const flush = typeof (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders === "function";
  if (flush) (res as ServerResponse & { flushHeaders: () => void }).flushHeaders();

  try {
    // Durasi maksimum satu koneksi SSE. Default mengikuti batas function;
    // PIIK_SSE_MAX_MS hanya untuk pengujian.
    const maxMs = Number(process.env.PIIK_SSE_MAX_MS ?? "") > 0
      ? Number(process.env.PIIK_SSE_MAX_MS)
      : SSE_MAX_DURATION_MS;
    await streamEvents(
      code,
      { peerId, token, cursor: cursor || null, maxMs },
      {
        emit(id, type, data) {
          if (closed) return;
          res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        comment(text) {
          if (closed) return;
          res.write(`: ${text}\n\n`);
        },
        isClosed() {
          return closed || res.writableEnded;
        },
      },
    );
  } finally {
    if (!res.writableEnded) res.end();
  }
}

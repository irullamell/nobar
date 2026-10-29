// GET /api/health — diagnosis konfigurasi penyimpanan.
// storage: "redis" (siap), "memory" (dev lokal), "missing" (produksi tanpa Redis!).
import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok, sendJson } from "./_lib/http.js";
import { getStorageMode } from "./_lib/store.js";

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") return sendJson(res, err(405, "METHOD_NOT_ALLOWED"));
  const storage = getStorageMode();
  sendJson(
    res,
    ok({
      ok: storage !== "missing",
      storage,
      // Nonce dev: memungkinkan test memastikan server yang menjawab adalah
      // anak yang baru dispawn (bukan zombie dari run sebelumnya).
      ...(process.env.PIIK_DEV_RUN_ID ? { runId: process.env.PIIK_DEV_RUN_ID } : {}),
      production: process.env.VERCEL === "1" || process.env.NODE_ENV === "production",
      hint:
        storage === "missing"
          ? "Tambahkan UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN di Vercel → Settings → Environment Variables, lalu deploy ulang."
          : storage === "memory"
            ? "Mode dev: data room hilang saat server di-restart."
            : undefined,
    }),
  );
}

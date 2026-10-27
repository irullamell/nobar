// Dev harness: menjalankan Vercel functions secara lokal di port 8787
// sehingga `vite dev` bisa proxy /api ke sini.
// Jalankan: npm run dev:api  (butuh tsx)
//
// Tanpa UPSTASH_REDIS_REST_URL/TOKEN, penyimpanan memakai mode in-memory.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import roomsIndex from "../api/rooms/index.js";
import roomInfo from "../api/rooms/[code]/index.js";
import join from "../api/rooms/[code]/join.js";
import heartbeat from "../api/rooms/[code]/heartbeat.js";
import messages from "../api/rooms/[code]/messages.js";
import host from "../api/rooms/[code]/host.js";
import leave from "../api/rooms/[code]/leave.js";
import events from "../api/rooms/[code]/events.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

const PORT = Number(process.env.PORT ?? 8787);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","rooms",...]

  // Isi req.query ala Vercel agar handler identik di kedua lingkungan.
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  (req as IncomingMessage & { query?: Record<string, string> }).query = query;

  let handler: Handler | null = null;
  if (parts[0] === "api" && parts[1] === "rooms") {
    if (parts.length === 2) handler = roomsIndex;
    else if (parts.length === 3) {
      query.code = parts[2];
      (req as IncomingMessage & { query?: Record<string, string> }).query = query;
      handler = roomInfo;
    } else if (parts.length === 4) {
      query.code = parts[2];
      (req as IncomingMessage & { query?: Record<string, string> }).query = query;
      const action = parts[3];
      handler =
        action === "join" ? join :
        action === "heartbeat" ? heartbeat :
        action === "messages" ? messages :
        action === "host" ? host :
        action === "leave" ? leave :
        action === "events" ? events : null;
    }
  }

  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
    return;
  }

  try {
    await handler(req, res);
  } catch (error) {
    console.error("[dev] handler error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "INTERNAL" }));
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dev] API server di http://localhost:${PORT}`);
});

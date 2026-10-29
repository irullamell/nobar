// @ts-nocheck
// Uji klien NYATA (RoomSession dari src/lib/session.ts) terhadap dev server.
//
// MODE=normal (default):
//  1. Siklus tutup-stream periodik TIDAK memicu status "reconnecting" (senyap).
//  2. Presence online terus: hostOnline=true di semua heartbeat, viewer tetap
//     terdaftar, room publik terlihat online.
//  3. Chat dua arah lintas siklus reconnect (cursor tidak bocor).
//
// MODE=chaos (simulasi Upstash error/kuota habis di Vercel):
//  Server diinjeksi kegagalan store acak 15% (PIIK_DEV_STORE_FAIL_RATE).
//  Stream SSE HARUS tetap hidup (ping tidak butuh Redis) sehingga:
//   - tidak ada flip "reconnecting", tidak ada fatal,
//   - chat tetap terkirim (dengan retry klien),
//   - presence tetap online.
//
// Jalankan: npx tsx dev/test-session.ts          (normal)
//           MODE=chaos npx tsx dev/test-session.ts  (chaos)
import { spawn } from "node:child_process";

const CHAOS = process.env.MODE === "chaos";
// Port acak per run + nonce runId: mustahil "nyasar" ke server zombie dari
// run sebelumnya (penyebab false-failure ROOM_NOT_FOUND di CI lokal).
const PORT = Number(process.env.TEST_PORT ?? ((CHAOS ? 8890 : 8790) + Math.floor(Math.random() * 90)));
const RUN_ID = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const BASE = `http://localhost:${PORT}`;
const SSE_CYCLE_MS = 6000; // stream ditutup tiap ~6 dtk (simulasi batas Vercel)
const FAIL_RATE = "0.05";

// --- stub lingkungan browser untuk node ---
globalThis.window = {
  setInterval: (...a) => setInterval(...a),
  clearInterval: (...a) => clearInterval(...a),
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
};
globalThis.location = { origin: BASE };

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ulangi fn sampai sukses (dipakai di mode chaos: API bisa gagal acak). */
async function retry(fn, attempts = 40, delayMs = 2500, label = "") {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(delayMs);
    }
  }
  throw new Error(`retry gagal (${label}): ${lastErr?.message ?? lastErr}`);
}

async function waitForServer(child) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        // Pastikan ini server KITA (nonce cocok) - bukan zombie run lama yang
        // kebetulan masih memegang port.
        const j = await r.json();
        if (j.runId === RUN_ID) return;
      }
    } catch { /* belum siap */ }
    await sleep(250);
    if (child.exitCode !== null) throw new Error(`server keluar: ${child.exitCode}`);
  }
  throw new Error("server tidak siap (runId tidak cocok - ada server zombie di port ini?)");
}

let child = null;

async function main() {
  console.log(
    `Menyalakan dev server (${CHAOS ? `CHAOS: fail-rate=${FAIL_RATE}, ` : ""}PIIK_SSE_MAX_MS=${SSE_CYCLE_MS}, port ${PORT})...`,
  );
  child = spawn("npx", ["tsx", "dev/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PIIK_DEV_RUN_ID: RUN_ID,
      PIIK_SSE_MAX_MS: String(SSE_CYCLE_MS),
      ...(CHAOS ? { PIIK_DEV_STORE_FAIL_RATE: FAIL_RATE } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  let exitCode = 1;
  try {
    await waitForServer(child);

    const { RoomSession } = await import("../src/lib/session.ts");
    const { apiCreateRoom } = await import("../src/lib/api.ts");

    const created = await retry(
      () => apiCreateRoom({ name: "Uji Sesi", hostName: "Host", clientId: "f".repeat(32), public: true }),
      40, 2500, "createRoom",
    );
    console.log(`Room uji: ${created.code}`);

    // ---------- HOST ----------
    const hostStatuses = [];
    const hostEvents = [];
    let hostFatal = null;
    const host = new RoomSession(
      { code: created.code, name: "Host", clientId: "f".repeat(32), hostToken: created.hostToken },
      {
        onJoined: () => {},
        onEvent: (ev) => hostEvents.push(ev),
        onStatus: (s) => hostStatuses.push(s),
        onFatal: (reason, message) => { hostFatal = { reason, message }; },
        onRoomUpdate: () => {},
      },
    );

    // ---------- VIEWER ----------
    const viewerStatuses = [];
    const viewerEvents = [];
    const viewerRoomUpdates = [];
    let viewerFatal = null;
    const viewer = new RoomSession(
      { code: created.code, name: "Penonton", clientId: "a".repeat(32) },
      {
        onJoined: () => {},
        onEvent: (ev) => viewerEvents.push(ev),
        onStatus: (s) => viewerStatuses.push(s),
        onFatal: (reason, message) => { viewerFatal = { reason, message }; },
        onRoomUpdate: (room, peers) => viewerRoomUpdates.push({ hostOnline: room.hostOnline, peers }),
      },
    );

    await retry(() => host.start(), 40, 2500, "host.start");
    check("host join sukses", Boolean(host.peerId));
    await retry(() => viewer.start(), 40, 2500, "viewer.start");
    check("viewer join sukses", Boolean(viewer.peerId));

    const WAIT_MS = CHAOS ? 20_000 : 20_000;
    console.log(`Menunggu ${WAIT_MS / 1000} detik (≈${Math.round(WAIT_MS / SSE_CYCLE_MS)} siklus tutup-stream @${SSE_CYCLE_MS / 1000} dtk)...`);

    // Kirim chat dengan retry (di chaos, POST bisa gagal acak) hingga diterima.
    async function sendUntilReceived(session, text, received, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { await session.sendChat(text); } catch { /* coba lagi */ }
        const t0 = Date.now();
        while (Date.now() - t0 < 2_500 && Date.now() < deadline) {
          if (received.some((e) => e.type === "chat" && e.data.payload?.text === text)) return true;
          await sleep(250);
        }
        if (received.some((e) => e.type === "chat" && e.data.payload?.text === text)) return true;
      }
      return received.some((e) => e.type === "chat" && e.data.payload?.text === text);
    }

    await sleep(4_000);
    const chat1 = await sendUntilReceived(viewer, "chat-siklus-1", hostEvents);
    await sleep(CHAOS ? 5_000 : 9_000); // melintasi minimal 1-2 siklus reconnect
    const chat2 = await sendUntilReceived(host, "chat-siklus-2-dari-host", viewerEvents);
    if (!CHAOS) await sleep(7_000);

    check("host tidak fatal", hostFatal === null, JSON.stringify(hostFatal));
    check("viewer tidak fatal", viewerFatal === null, JSON.stringify(viewerFatal));

    const flipsH = hostStatuses.filter((s) => s === "reconnecting").length;
    const flipsV = viewerStatuses.filter((s) => s === "reconnecting").length;
    check("host: TIDAK ada flip 'reconnecting'", flipsH === 0, JSON.stringify(hostStatuses));
    check("viewer: TIDAK ada flip 'reconnecting'", flipsV === 0, JSON.stringify(viewerStatuses));

    // Presence: setiap update room dari heartbeat viewer harus melihat host online.
    if (!CHAOS) {
      check("viewer mendapat room updates (heartbeat jalan)", viewerRoomUpdates.length >= 1, `count=${viewerRoomUpdates.length}`);
    }
    if (viewerRoomUpdates.length >= 1) {
      const offlineSeen = viewerRoomUpdates.filter((u) => !u.hostOnline);
      check("hostOnline=true di SEMUA heartbeat viewer", offlineSeen.length === 0, JSON.stringify(offlineSeen.map((u) => u.hostOnline)));
      const viewerMissing = viewerRoomUpdates.filter((u) => !u.peers.some((p) => p.peerId === viewer.peerId));
      check("viewer tetap terdaftar di SEMUA heartbeat", viewerMissing.length === 0, `hilang ${viewerMissing.length}x`);
    }

    // Daftar room publik juga harus melihat host online (retry di chaos).
    const listed = await retry(async () => {
      const r = await fetch(`${BASE}/api/rooms?list=public`).then((x) => x.json());
      const found = (r.rooms ?? []).find((x) => x.code === created.code);
      if (!found || found.hostOnline !== true) throw new Error(`belum online: ${JSON.stringify(found)}`);
      return found;
    }, 10, 700, "public list");
    check("room publik terdaftar dengan hostOnline=true", Boolean(listed));

    // Event lintas siklus.
    check("host menerima chat viewer lintas siklus", chat1, JSON.stringify(hostEvents.map((e) => e.type)));
    check("viewer menerima chat host lintas siklus", chat2, JSON.stringify(viewerEvents.map((e) => e.type)));

    // Viewer keluar → host melihat peer-left (hanya di normal; di chaos publish
    // peer-left bisa gagal acak sehingga assertion-nya flaky).
    if (!CHAOS) {
      viewer.leave();
      await sleep(2_000);
      check(
        "host menerima peer-left setelah viewer keluar",
        hostEvents.some((e) => e.type === "peer-left" && e.data.peerId === viewer.peerId),
      );
    } else {
      viewer.stop();
    }

    host.stop();

    console.log(
      failures === 0
        ? `\nSEMUA TES SESI (${CHAOS ? "CHAOS" : "NORMAL"}) LULUS 🎉`
        : `\nADA ${failures} KEGAGALAN ❌`,
    );
    exitCode = failures === 0 ? 0 : 1;
  } finally {
    // PENTING: process.exit() melewati finally - matikan anak di sini, exit di luar.
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await sleep(400); // beri OS waktu melepas port
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});

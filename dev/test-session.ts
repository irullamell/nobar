// @ts-nocheck
// Uji klien NYATA (RoomSession dari src/lib/session.ts) terhadap dev server:
// 1. Siklus tutup-stream periodik TIDAK memicu status "reconnecting" (senyap),
//    termasuk pemutusan kasar setelah stream hidup >= 3 detik.
// 2. Presence tetap online: hostOnline=true sepanjang waktu (dipantau dari
//    heartbeat viewer), viewer tetap terdaftar di sisi host.
// 3. Event (chat) tetap terkirim lintas siklus reconnect (cursor tidak bocor).
//
// Jalankan: npx tsx dev/test-session.ts
import { spawn } from "node:child_process";

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const SSE_CYCLE_MS = 6000; // stream ditutup tiap ~6 dtk (simulasi batas Vercel)

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

async function waitForServer(child) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* belum siap */ }
    await sleep(250);
    if (child.exitCode !== null) throw new Error(`server keluar: ${child.exitCode}`);
  }
  throw new Error("server tidak siap");
}

async function main() {
  console.log(`Menyalakan dev server (PIIK_SSE_MAX_MS=${SSE_CYCLE_MS}, port ${PORT})...`);
  const child = spawn("npx", ["tsx", "dev/server.ts"], {
    env: { ...process.env, PORT: String(PORT), PIIK_SSE_MAX_MS: String(SSE_CYCLE_MS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer(child);

    const { RoomSession } = await import("../src/lib/session.ts");
    const { apiCreateRoom } = await import("../src/lib/api.ts");

    const created = await apiCreateRoom({
      name: "Uji Sesi", hostName: "Host", clientId: "f".repeat(32), public: true,
    });
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

    await host.start();
    check("host join sukses", Boolean(host.peerId));
    await viewer.start();
    check("viewer join sukses", Boolean(viewer.peerId));

    console.log(`Menunggu 20 detik (≈3 siklus tutup-stream @${SSE_CYCLE_MS / 1000} dtk)...`);
    await sleep(4_000);
    await viewer.sendChat("chat-siklus-1");
    await sleep(9_000); // melintasi minimal 1-2 siklus reconnect
    await host.sendChat("chat-siklus-2-dari-host");
    await sleep(7_000);

    check("host tidak fatal", hostFatal === null, JSON.stringify(hostFatal));
    check("viewer tidak fatal", viewerFatal === null, JSON.stringify(viewerFatal));

    const flipsH = hostStatuses.filter((s) => s === "reconnecting").length;
    const flipsV = viewerStatuses.filter((s) => s === "reconnecting").length;
    check("host: TIDAK ada flip 'reconnecting' selama siklus normal", flipsH === 0, JSON.stringify(hostStatuses));
    check("viewer: TIDAK ada flip 'reconnecting' selama siklus normal", flipsV === 0, JSON.stringify(viewerStatuses));

    // Presence: setiap update room dari heartbeat viewer harus melihat host online.
    check("viewer mendapat room updates (heartbeat jalan)", viewerRoomUpdates.length >= 1, `count=${viewerRoomUpdates.length}`);
    const offlineSeen = viewerRoomUpdates.filter((u) => !u.hostOnline);
    check("hostOnline=true di SEMUA heartbeat viewer", offlineSeen.length === 0, JSON.stringify(offlineSeen.map((u) => u.hostOnline)));
    const viewerMissing = viewerRoomUpdates.filter((u) => !u.peers.some((p) => p.peerId === viewer.peerId));
    check("viewer tetap terdaftar di SEMUA heartbeat", viewerMissing.length === 0, `hilang ${viewerMissing.length}x`);

    // Daftar room publik juga harus melihat host online.
    const listRes = await fetch(`${BASE}/api/rooms?list=public`).then((r) => r.json());
    const listed = (listRes.rooms ?? []).find((r) => r.code === created.code);
    check("room publik terdaftar dengan hostOnline=true", listed?.hostOnline === true, JSON.stringify(listed));

    // Event lintas siklus.
    check(
      "host menerima chat viewer lintas siklus",
      hostEvents.some((e) => e.type === "chat" && e.data.payload?.text === "chat-siklus-1"),
      JSON.stringify(hostEvents.map((e) => e.type)),
    );
    check(
      "viewer menerima chat host lintas siklus",
      viewerEvents.some((e) => e.type === "chat" && e.data.payload?.text === "chat-siklus-2-dari-host"),
      JSON.stringify(viewerEvents.map((e) => e.type)),
    );

    // Viewer keluar → host melihat peer-left.
    viewer.leave();
    await sleep(2_000);
    check(
      "host menerima peer-left setelah viewer keluar",
      hostEvents.some((e) => e.type === "peer-left" && e.data.peerId === viewer.peerId),
    );

    host.stop();

    console.log(failures === 0 ? "\nSEMUA TES SESI LULUS 🎉" : `\nADA ${failures} KEGAGALAN ❌`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

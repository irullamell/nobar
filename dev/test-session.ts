// @ts-nocheck
// Uji klien NYATA (RoomSession dari src/lib/session.ts) terhadap dev server:
// memverifikasi bahwa siklus tutup-stream periodik TIDAK lagi memicu status
// "reconnecting" (reconnect senyap), dan event tetap terkirim lintas siklus.
//
// Jalankan: npx tsx dev/test-session.ts
import { spawn } from "node:child_process";

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;

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
  console.log("Menyalakan dev server (PIIK_SSE_MAX_MS=3000, port 8791)...");
  const child = spawn("npx", ["tsx", "dev/server.ts"], {
    env: { ...process.env, PORT: String(PORT), PIIK_SSE_MAX_MS: "3000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer(child);

    const { RoomSession } = await import("../src/lib/session.ts");
    const { apiCreateRoom, apiSendMessage } = await import("../src/lib/api.ts");

    const created = await apiCreateRoom({ name: "Uji Sesi", hostName: "Host", clientId: "f".repeat(32) });
    console.log(`Room uji: ${created.code}`);

    const statuses = [];
    const events = [];
    let fatal = null;
    const session = new RoomSession(
      { code: created.code, name: "Host", clientId: "f".repeat(32), hostToken: created.hostToken },
      {
        onJoined: () => {},
        onEvent: (ev) => events.push(ev),
        onStatus: (s) => statuses.push(s),
        onFatal: (reason, message) => { fatal = { reason, message }; },
        onRoomUpdate: () => {},
      },
    );

    await session.start();
    check("join sukses (peerId terisi)", Boolean(session.peerId));
    await sleep(500);
    check("status awal live", statuses.includes("live"), JSON.stringify(statuses));

    // Biarkan ~3 siklus tutup-stream periodik terjadi (3s each).
    console.log("Menunggu 10 detik (±3 siklus reconnect senyap)...");
    await sleep(10_000);

    check("tidak ada fatal", fatal === null, JSON.stringify(fatal));
    const firstLive = statuses.indexOf("live");
    const flips = statuses.slice(firstLive).filter((s) => s === "reconnecting").length;
    check("TIDAK ada flip ke 'reconnecting' selama siklus normal", flips === 0, JSON.stringify(statuses));

    // Kirim chat lintas siklus - harus tetap diterima (cursor tidak kehilangan event).
    await apiSendMessage(created.code, {
      peerId: session.peerId, token: session.token, kind: "chat", payload: { text: "lintas-siklus" },
    });
    await sleep(2_000);
    check(
      "event chat tetap diterima setelah beberapa siklus reconnect",
      events.some((e) => e.type === "chat" && e.data.payload?.text === "lintas-siklus"),
      JSON.stringify(events.map((e) => e.type)),
    );

    session.stop();

    // Uji jalur gagal: matikan server → status harus jadi "reconnecting" (bukan diam).
    console.log("Mematikan server untuk uji jalur gagal...");
    child.kill("SIGKILL");
    await sleep(300);

    const statuses2 = [];
    const session2 = new RoomSession(
      { code: created.code, name: "Host", clientId: "f".repeat(32), hostToken: created.hostToken },
      {
        onJoined: () => {}, onEvent: () => {}, onStatus: (s) => statuses2.push(s),
        onFatal: () => {}, onRoomUpdate: () => {},
      },
    );
    await session2.start().catch(() => {});
    await sleep(4_000);
    session2.stop();
    check("start gagal tanpa server tidak crash", true);

    console.log(failures === 0 ? "\nSEMUA TES SESI LULUS 🎉" : `\nADA ${failures} KEGAGALAN ❌`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// Smoke test end-to-end untuk API Piik Lite (jalankan dev/server.ts dulu).
// Uji: create → info → join (password) → SSE → chat → kick → ban → rejoin ditolak → unban.
const BASE = process.env.BASE ?? "http://localhost:8787";
let failures = 0;

function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function api(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* kosong */ }
  return { status: res.status, json };
}

function openSSE(code, peerId, token, cursor, onEvent) {
  const ctrl = new AbortController();
  const params = new URLSearchParams({ peerId });
  if (cursor) params.set("cursor", cursor);
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/rooms/${code}/events?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = "", data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) onEvent(type, JSON.parse(data));
        }
      }
    } catch { /* dibatalkan */ }
  })();
  return ctrl;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("0) Health check");
  const health = await api("/api/health");
  check("health 200", health.status === 200, JSON.stringify(health.json));
  check("storage terdeteksi (dev: memory)", ["redis", "memory"].includes(health.json?.storage), JSON.stringify(health.json));

  console.log("1) Buat room dengan password");
  const created = await api("/api/rooms", {
    name: "Nonton Bareng",
    hostName: "Budi",
    clientId: "client-host-0001",
    password: "rahasia123",
    maxViewers: 5,
  });
  check("create 200", created.status === 200, JSON.stringify(created.json));
  const { code, hostToken, hostPeerId } = created.json;
  check("kode 12 karakter", code?.length === 12, code);

  console.log("2) Info room (tanpa rahasia)");
  const info = await api(`/api/rooms/${code}`);
  check("info 200", info.status === 200);
  check("passwordProtected true", info.json?.room?.passwordProtected === true);
  check("tidak bocor hostToken", !JSON.stringify(info.json).includes(hostToken));

  console.log("3) Viewer join tanpa password ditolak");
  const noPw = await api(`/api/rooms/${code}/join`, { name: "Sari", clientId: "client-viewer-0001" });
  check("403 PASSWORD_REQUIRED", noPw.status === 403 && noPw.json?.error === "PASSWORD_REQUIRED", JSON.stringify(noPw.json));

  const wrongPw = await api(`/api/rooms/${code}/join`, { name: "Sari", clientId: "client-viewer-0001", password: "salah" });
  check("403 WRONG_PASSWORD", wrongPw.status === 403 && wrongPw.json?.error === "WRONG_PASSWORD");

  console.log("4) Viewer join dengan password benar");
  const v1 = await api(`/api/rooms/${code}/join`, { name: "Sari", clientId: "client-viewer-0001", password: "rahasia123" });
  check("join 200", v1.status === 200, JSON.stringify(v1.json));
  const viewer1 = v1.json;

  const v2 = await api(`/api/rooms/${code}/join`, { name: "Joko", clientId: "client-viewer-0002", password: "rahasia123" });
  check("viewer kedua join", v2.status === 200);
  const viewer2 = v2.json;

  console.log("5) Host join dengan hostToken");
  const host = await api(`/api/rooms/${code}/join`, { name: "Budi", clientId: "client-host-0001", hostToken });
  check("host join 200", host.status === 200, JSON.stringify(host.json));
  check("peerId host konsisten", host.json?.peerId === hostPeerId);
  check("peers mencakup 3 orang", host.json?.peers?.length === 3, JSON.stringify(host.json?.peers));

  const badHost = await api(`/api/rooms/${code}/join`, { name: "Hacker", clientId: "client-x", hostToken: "palsu" });
  check("hostToken palsu ditolak", badHost.status === 403);

  console.log("6) SSE: chat dari host diterima viewer");
  const received = [];
  const sse1 = openSSE(code, viewer1.peerId, viewer1.token, viewer1.cursor, (t, d) => received.push({ t, d }));
  await sleep(600);
  const msgRes = await api(`/api/rooms/${code}/messages`, {
    peerId: host.json.peerId, token: host.json.token, kind: "chat", payload: { text: "Halo semua!" },
  });
  check("kirim chat 200", msgRes.status === 200, JSON.stringify(msgRes.json));
  await sleep(1600);
  check("viewer menerima chat via SSE", received.some((e) => e.t === "chat" && e.d.payload?.text === "Halo semua!"), JSON.stringify(received));

  console.log("7) Signal tertarget: hanya untuk penerima");
  const sigRes = await api(`/api/rooms/${code}/messages`, {
    peerId: host.json.peerId, token: host.json.token, kind: "signal", to: viewer1.peerId,
    payload: { sdp: { type: "offer", sdp: "v=0 dummy" } },
  });
  check("signal 200", sigRes.status === 200, JSON.stringify(sigRes.json));
  await sleep(1600);
  check("viewer1 menerima signal", received.some((e) => e.t === "signal" && e.d.payload?.sdp));

  const received2 = [];
  openSSE(code, viewer2.peerId, viewer2.token, viewer2.cursor, (t, d) => received2.push({ t, d }));
  await sleep(400);
  check("viewer2 TIDAK menerima signal tertarget viewer1", !received2.some((e) => e.t === "signal" && e.d.payload?.sdp));

  console.log("8) Viewer tidak bisa menyamar jadi host");
  const fakeAction = await api(`/api/rooms/${code}/host`, { hostToken: "palsu", action: "kick", peerId: viewer1.peerId });
  check("hostToken palsu → 403", fakeAction.status === 403);
  const viewerBroadcast = await api(`/api/rooms/${code}/messages`, {
    peerId: viewer1.peerId, token: viewer1.token, kind: "signal", to: "*", payload: { hostState: { sharing: true } },
  });
  check("viewer broadcast → 403", viewerBroadcast.status === 403);

  console.log("9) Host kick viewer2");
  const kick = await api(`/api/rooms/${code}/host`, { hostToken, action: "kick", peerId: viewer2.peerId });
  check("kick 200", kick.status === 200, JSON.stringify(kick.json));
  check("peers tersisa 2", kick.json?.peers?.length === 2, JSON.stringify(kick.json?.peers));
  await sleep(1600);
  // viewer2 boleh join lagi setelah kick
  const rejoin = await api(`/api/rooms/${code}/join`, { name: "Joko", clientId: "client-viewer-0002", password: "rahasia123" });
  check("viewer yang di-kick bisa join lagi", rejoin.status === 200);

  console.log("10) Host ban viewer1");
  const ban = await api(`/api/rooms/${code}/host`, { hostToken, action: "ban", peerId: viewer1.peerId });
  check("ban 200", ban.status === 200, JSON.stringify(ban.json));
  await sleep(1600);
  check("viewer1 menerima you-removed(banned)", received.some((e) => e.t === "you-removed" && e.d.reason === "banned"), JSON.stringify(received.slice(-3)));
  const bannedJoin = await api(`/api/rooms/${code}/join`, { name: "Sari", clientId: "client-viewer-0001", password: "rahasia123" });
  check("join setelah ban → 403 BANNED", bannedJoin.status === 403 && bannedJoin.json?.error === "BANNED", JSON.stringify(bannedJoin.json));

  console.log("11) Daftar ban + unban");
  const bans = await api(`/api/rooms/${code}/host`, { hostToken, action: "list-bans" });
  check("list-bans berisi clientId", Array.isArray(bans.json?.bans) && bans.json.bans.length >= 1, JSON.stringify(bans.json));
  const unbanned = bans.json?.bans?.[0]?.clientId;
  const unban = await api(`/api/rooms/${code}/host`, { hostToken, action: "unban", clientId: unbanned });
  check("unban 200", unban.status === 200, JSON.stringify(unban.json));
  const afterUnban = await api(`/api/rooms/${code}/join`, { name: "Sari", clientId: "client-viewer-0001", password: "rahasia123" });
  check("setelah unban bisa join lagi", afterUnban.status === 200, JSON.stringify(afterUnban.json));

  console.log("12) Ganti password → viewer lama TIDAK ditendang, join baru wajib password baru");
  const setPw = await api(`/api/rooms/${code}/host`, { hostToken, action: "set-password", password: "baru456" });
  check("set-password 200", setPw.status === 200);
  check("room-updated: passwordProtected true", setPw.json?.room?.passwordProtected === true, JSON.stringify(setPw.json?.room));
  const stillIn = await api(`/api/rooms/${code}/heartbeat`, {
    peerId: afterUnban.json.peerId, token: afterUnban.json.token,
  });
  check("viewer yang sudah bergabung TETAP di dalam (heartbeat 200)", stillIn.status === 200, JSON.stringify(stillIn.json));
  const stillPeers = stillIn.json?.peers ?? [];
  check("peer viewer masih terdaftar", stillPeers.some((p) => p.peerId === afterUnban.json.peerId));
  const oldPw = await api(`/api/rooms/${code}/join`, { name: "Orang", clientId: "client-viewer-0009", password: "rahasia123" });
  check("password lama ditolak", oldPw.status === 403);
  const newPw = await api(`/api/rooms/${code}/join`, { name: "Orang", clientId: "client-viewer-0009", password: "baru456" });
  check("password baru diterima", newPw.status === 200);

  console.log("13) Kapasitas room");
  const setMax = await api(`/api/rooms/${code}/host`, { hostToken, action: "set-max-viewers", maxViewers: 1 });
  check("set-max-viewers 200", setMax.status === 200);
  const overflow = await api(`/api/rooms/${code}/join`, { name: "Penuh", clientId: "client-viewer-0010", password: "baru456" });
  check("join saat penuh → 409 ROOM_FULL", overflow.status === 409 && overflow.json?.error === "ROOM_FULL", JSON.stringify(overflow.json));

  console.log("14) Room tidak dikenal → 404 (tidak bisa enumerasi)");
  const ghost = await api("/api/rooms/ZZZZZZZZZZZZ");
  check("info room tak dikenal → 404", ghost.status === 404);
  const ghostJoin = await api("/api/rooms/ZZZZZZZZZZZZ/join", { name: "X", clientId: "client-viewer-0011" });
  check("join room tak dikenal → 404", ghostJoin.status === 404);

  console.log("15) Tutup room");
  const close = await api(`/api/rooms/${code}/host`, { hostToken, action: "close" });
  check("close 200", close.status === 200);
  await sleep(1200);
  const afterClose = await api(`/api/rooms/${code}/join`, { name: "X", clientId: "client-viewer-0012", password: "baru456" });
  check("join setelah close → 404", afterClose.status === 404, JSON.stringify(afterClose.json));

  console.log("16) Room publik: daftar, toggle, dan cleanup");
  const priv = await api("/api/rooms", { name: "Privat", hostName: "H", clientId: "client-pub-0001" });
  const pub = await api("/api/rooms", { name: "Nobar Publik", hostName: "H2", clientId: "client-pub-0002", public: true });
  check("create public 200 + isPublic true", pub.status === 200 && pub.json?.room?.isPublic === true, JSON.stringify(pub.json?.room));
  check("create privat → isPublic false", priv.json?.room?.isPublic === false);

  let list = await api("/api/rooms?list=public");
  check("list 200", list.status === 200, JSON.stringify(list.json));
  check("room publik terdaftar", (list.json?.rooms ?? []).some((r) => r.code === pub.json.code));
  check("room privat TIDAK terdaftar", !(list.json?.rooms ?? []).some((r) => r.code === priv.json.code));
  check("list tidak membocorkan hostToken", !JSON.stringify(list.json).includes(pub.json.hostToken));

  const goPrivate = await api(`/api/rooms/${pub.json.code}/host`, { hostToken: pub.json.hostToken, action: "set-public", public: false });
  check("set-public(false) 200", goPrivate.status === 200 && goPrivate.json?.room?.isPublic === false);
  list = await api("/api/rooms?list=public");
  check("hilang dari daftar setelah diprivat", !(list.json?.rooms ?? []).some((r) => r.code === pub.json.code));

  const goPublic = await api(`/api/rooms/${pub.json.code}/host`, { hostToken: pub.json.hostToken, action: "set-public", public: true });
  check("set-public(true) 200", goPublic.status === 200 && goPublic.json?.room?.isPublic === true);
  list = await api("/api/rooms?list=public");
  check("muncul lagi setelah dipublikkan", (list.json?.rooms ?? []).some((r) => r.code === pub.json.code));

  // viewer tanpa hostToken tetap butuh kode; room publik TANPA password bisa langsung join
  const pubJoin = await api(`/api/rooms/${pub.json.code}/join`, { name: "Penonton", clientId: "client-pub-0003" });
  check("join room publik tanpa password 200", pubJoin.status === 200);

  const viewerFake = await api(`/api/rooms/${pub.json.code}/host`, { hostToken: "bukan-host", action: "set-public", public: true });
  check("set-public oleh non-host → 403", viewerFake.status === 403);

  const pubClose = await api(`/api/rooms/${pub.json.code}/host`, { hostToken: pub.json.hostToken, action: "close" });
  check("close room publik 200", pubClose.status === 200);
  list = await api("/api/rooms?list=public");
  check("room ditutup → hilang dari daftar publik", !(list.json?.rooms ?? []).some((r) => r.code === pub.json.code));

  sse1.abort();
  console.log(failures === 0 ? "\nSEMUA TES LULUS 🎉" : `\nADA ${failures} KEGAGALAN ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Inti logika room Piik Lite. Dipakai oleh Vercel functions (api/rooms/**)
// dan oleh dev harness lokal (dev/server.ts).
//
// Model keamanan:
// - Room HANYA bisa dimasuki dengan kode undangan (12 karakter acak kriptografis).
//   Tidak ada endpoint daftar room; tidak bisa ditebak/di-enumerasi.
// - Opsional password room (hash sha256 + salt per room).
// - Host memegang hostToken (rahasia) untuk aksi moderasi: kick, ban, unban,
//   ganti password, tutup room.
// - Ban menempel pada clientId browser + hash IP (per room), disimpan di Redis.
// - Semua pesan tervalidasi + rate limit per IP/peer.

import { randomBytes, randomInt } from "node:crypto";
import { getStore } from "./store.js";
import { err, ok, safeEqual, sha256, str, type JsonResult } from "./http.js";
import {
  DEFAULT_MAX_VIEWERS,
  ABS_MAX_VIEWERS,
  PRESENCE_TIMEOUT_MS,
  ROOM_CODE_LENGTH,
  ROOM_TTL_SECONDS,
  REACTIONS,
  normalizeRoomCode,
  type ChatEventPayload,
  type PeerInfo,
  type RoomInfo,
} from "../../shared/protocol.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // tanpa 0/O/1/I

const ROOM_NOT_FOUND_MESSAGE =
  "Room tidak ditemukan atau sudah ditutup/kedaluwarsa (room otomatis dihapus setelah 24 jam tanpa aktivitas). Periksa lagi kode/tautan undangannya, atau buat room baru.";

function roomNotFound(): JsonResult {
  return err(404, "ROOM_NOT_FOUND", ROOM_NOT_FOUND_MESSAGE);
}

// ------------------------- keys -------------------------

const kRoom = (code: string) => `piik:room:${code}`;
const kPeers = (code: string) => `piik:peers:${code}`;
const kBans = (code: string) => `piik:bans:${code}`;
const kBanMeta = (code: string) => `piik:banmeta:${code}`;
const kEvents = (code: string) => `piik:events:${code}`;
const kGone = (code: string, peerId: string) => `piik:gone:${code}:${peerId}`;
/** Set global berisi kode room yang diaktifkan sebagai room publik. */
const kPublicRooms = "piik:public-rooms";

interface PeerRecord {
  peerId: string;
  name: string;
  role: "host" | "viewer";
  clientId: string;
  ipHash: string;
  tokenHash: string;
  joinedAt: number;
  lastSeen: number;
}

function publicPeer(p: PeerRecord): PeerInfo {
  return { peerId: p.peerId, name: p.name, role: p.role, joinedAt: p.joinedAt };
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

async function rateLimit(scope: string, id: string, limit: number, windowSec: number): Promise<boolean> {
  const store = getStore();
  const key = `piik:rl:${scope}:${id}`;
  const n = await store.incr(key);
  if (n === 1) await store.expire(key, windowSec);
  return n <= limit;
}

async function touchRoom(code: string): Promise<void> {
  const store = getStore();
  await Promise.all([
    store.expire(kRoom(code), ROOM_TTL_SECONDS),
    store.expire(kPeers(code), ROOM_TTL_SECONDS),
    store.expire(kEvents(code), ROOM_TTL_SECONDS),
    store.expire(kBans(code), ROOM_TTL_SECONDS),
    store.expire(kBanMeta(code), ROOM_TTL_SECONDS),
  ]);
}

interface RoomMeta {
  name: string;
  hostTokenHash: string;
  hostPeerId: string;
  pwSalt: string;
  pwHash: string;
  maxViewers: number;
  createdAt: number;
  closed: boolean;
  isPublic: boolean;
}

async function loadRoom(code: string): Promise<RoomMeta | null> {
  const h = await getStore().hgetall(kRoom(code));
  if (!h.name || !h.hostTokenHash) return null;
  return {
    name: h.name,
    hostTokenHash: h.hostTokenHash,
    hostPeerId: h.hostPeerId ?? "",
    pwSalt: h.pwSalt ?? "",
    pwHash: h.pwHash ?? "",
    maxViewers: Number(h.maxViewers ?? DEFAULT_MAX_VIEWERS),
    createdAt: Number(h.createdAt ?? 0),
    closed: h.closed === "1",
    isPublic: h.isPublic === "1",
  };
}

async function loadPeers(code: string): Promise<PeerRecord[]> {
  const h = await getStore().hgetall(kPeers(code));
  const now = Date.now();
  const peers: PeerRecord[] = [];
  const stale: string[] = [];
  for (const [peerId, raw] of Object.entries(h)) {
    try {
      const p = JSON.parse(raw) as PeerRecord;
      if (now - p.lastSeen > PRESENCE_TIMEOUT_MS) stale.push(peerId);
      else peers.push(p);
    } catch {
      stale.push(peerId);
    }
  }
  if (stale.length) {
    const store = getStore();
    await store.hdel(kPeers(code), ...stale);
    for (const peerId of stale) {
      await publish(code, { type: "peer-left", peerId, reason: "timeout" });
    }
  }
  peers.sort((a, b) => a.joinedAt - b.joinedAt);
  return peers;
}

function roomInfoOf(meta: RoomMeta, peers: PeerRecord[], code: string): RoomInfo {
  const now = Date.now();
  const host = peers.find((p) => p.role === "host");
  return {
    code,
    name: meta.name,
    passwordProtected: Boolean(meta.pwHash),
    maxViewers: meta.maxViewers,
    viewerCount: peers.filter((p) => p.role === "viewer").length,
    hostOnline: Boolean(host && now - host.lastSeen < PRESENCE_TIMEOUT_MS),
    createdAt: meta.createdAt,
    isPublic: meta.isPublic,
  };
}

async function publish(code: string, event: Record<string, unknown>, to?: string): Promise<string> {
  return getStore().xadd(kEvents(code), {
    type: String(event.type),
    payload: JSON.stringify(event),
    ...(to ? { to } : {}),
  });
}

async function verifyPeer(code: string, peerId: unknown, token: unknown): Promise<PeerRecord | null> {
  if (typeof peerId !== "string" || typeof token !== "string") return null;
  const raw = await getStore().hget(kPeers(code), peerId);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PeerRecord;
    if (!safeEqual(p.tokenHash, sha256(token))) return null;
    p.lastSeen = Date.now();
    await getStore().hset(kPeers(code), { [peerId]: JSON.stringify(p) });
    return p;
  } catch {
    return null;
  }
}

/**
 * Refresh lastSeen peer TANPA validasi token - dipanggil dari loop SSE.
 * Inilah kunci presence yang andal: koneksi SSE adalah kanal jaringan yang
 * tidak di-throttle browser (berbeda dengan setInterval di tab background),
 * jadi selama stream hidup, peer dianggap online.
 */
async function refreshPeer(code: string, peerId: string): Promise<void> {
  const store = getStore();
  const raw = await store.hget(kPeers(code), peerId);
  if (!raw) return;
  try {
    const p = JSON.parse(raw) as PeerRecord;
    p.lastSeen = Date.now();
    await store.hset(kPeers(code), { [peerId]: JSON.stringify(p) });
  } catch {
    /* record rusak; biarkan di-prune */
  }
}

// ------------------------- create -------------------------

export async function createRoom(input: { ip: string; [key: string]: unknown }): Promise<JsonResult> {
  if (!(await rateLimit("create", input.ip, 20, 3600))) return err(429, "RATE_LIMITED", "Terlalu banyak room dibuat dari jaringan ini. Coba lagi nanti.");
  const name = str(input.name, 40) ?? "Room";
  const hostName = str(input.hostName, 40);
  const clientId = str(input.clientId, 64);
  if (!hostName) return err(400, "INVALID_NAME", "Nama host wajib diisi (maks 40 karakter).");
  if (!clientId) return err(400, "INVALID_CLIENT_ID", "clientId tidak valid.");

  let maxViewers = DEFAULT_MAX_VIEWERS;
  if (typeof input.maxViewers === "number" && Number.isInteger(input.maxViewers)) {
    maxViewers = Math.min(Math.max(input.maxViewers, 1), ABS_MAX_VIEWERS);
  }

  let password = "";
  if (input.password != null && input.password !== "") {
    const pw = str(input.password, 64);
    if (!pw || pw.length < 4) return err(400, "INVALID_PASSWORD", "Password minimal 4 karakter, maksimal 64.");
    password = pw;
  }

  // Room publik opsional (default privat / invite-only).
  const isPublic = input.public === true;

  const store = getStore();
  let code = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    let candidate = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) candidate += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const exists = await store.hget(kRoom(candidate), "name");
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) return err(500, "CODE_EXHAUSTED");

  const hostToken = hex(32);
  const hostPeerId = `h-${hex(8)}`;
  const now = Date.now();
  const pwSalt = password ? hex(16) : "";
  const pwHash = password ? sha256(pwSalt + password) : "";

  const meta: Record<string, string> = {
    name,
    hostTokenHash: sha256(hostToken),
    hostPeerId,
    pwSalt,
    pwHash,
    maxViewers: String(maxViewers),
    createdAt: String(now),
    isPublic: isPublic ? "1" : "",
  };
  await store.hset(kRoom(code), meta);
  await store.expire(kRoom(code), ROOM_TTL_SECONDS);
  if (isPublic) await store.sadd(kPublicRooms, code);

  const hostRecord: PeerRecord = {
    peerId: hostPeerId,
    name: hostName,
    role: "host",
    clientId,
    ipHash: sha256(input.ip + ":" + code),
    tokenHash: sha256(hostToken),
    joinedAt: now,
    lastSeen: now,
  };
  await store.hset(kPeers(code), { [hostPeerId]: JSON.stringify(hostRecord) });
  await store.expire(kPeers(code), ROOM_TTL_SECONDS);

  const roomMeta: RoomMeta = {
    name,
    hostTokenHash: meta.hostTokenHash,
    hostPeerId,
    pwSalt,
    pwHash,
    maxViewers,
    createdAt: now,
    closed: false,
    isPublic,
  };
  const room = roomInfoOf(roomMeta, [hostRecord], code);
  await publish(code, { type: "room-updated", room });

  return ok({ code, hostToken, hostPeerId, room });
}

// ------------------------- info -------------------------

export async function getRoomInfo(codeRaw: string, ip: string): Promise<JsonResult> {
  const code = normalizeRoomCode(codeRaw);
  if (code.length !== ROOM_CODE_LENGTH) return roomNotFound();
  if (!(await rateLimit("info", `${ip}:${code}`, 60, 60))) return err(429, "RATE_LIMITED");
  const meta = await loadRoom(code);
  if (!meta || meta.closed) return roomNotFound();
  const peers = await loadPeers(code);
  return ok({ room: roomInfoOf(meta, peers, code) });
}

// ------------------------- join -------------------------

export async function joinRoom(
  codeRaw: string,
  input: { ip: string; [key: string]: unknown },
): Promise<JsonResult> {
  const code = normalizeRoomCode(codeRaw);
  if (code.length !== ROOM_CODE_LENGTH) return roomNotFound();
  if (!(await rateLimit("join", `${ip2Key(input.ip)}:${code}`, 30, 60))) {
    return err(429, "RATE_LIMITED", "Terlalu banyak percobaan bergabung. Tunggu sebentar.");
  }

  const meta = await loadRoom(code);
  if (!meta || meta.closed) return roomNotFound();

  const name = str(input.name, 40);
  const clientId = str(input.clientId, 64);
  if (!name) return err(400, "INVALID_NAME", "Nama wajib diisi (maks 40 karakter).");
  if (!clientId) return err(400, "INVALID_CLIENT_ID", "clientId tidak valid.");

  const store = getStore();
  const ipHash = sha256(input.ip + ":" + code);

  // Cek ban (clientId browser + hash IP).
  const bannedClient = await store.sismember(kBans(code), `c:${clientId}`);
  const bannedIp = await store.sismember(kBans(code), `i:${ipHash}`);
  if (bannedClient || bannedIp) {
    return err(403, "BANNED", "Anda telah dilarang (di-ban) oleh host dari room ini.");
  }

  const isHost = typeof input.hostToken === "string" && input.hostToken.length > 0;
  let peers = await loadPeers(code);

  if (isHost) {
    if (!safeEqual(sha256(input.hostToken as string), meta.hostTokenHash)) {
      return err(403, "INVALID_TOKEN", "Token host tidak valid.");
    }
  } else {
    // Viewer: wajib password bila diaktifkan.
    if (meta.pwHash) {
      const pw = typeof input.password === "string" ? input.password : "";
      if (!pw) return err(403, "PASSWORD_REQUIRED", "Room ini dilindungi password.");
      if (!safeEqual(sha256(meta.pwSalt + pw), meta.pwHash)) {
        return err(403, "WRONG_PASSWORD", "Password room salah.");
      }
    }
    const viewerCount = peers.filter((p) => p.role === "viewer").length;
    if (viewerCount >= meta.maxViewers) {
      return err(409, "ROOM_FULL", `Room penuh (maks ${meta.maxViewers} penonton).`);
    }
  }

  // Rekam kehadiran.
  const now = Date.now();
  let peerId: string;
  let token: string;
  if (isHost) {
    peerId = meta.hostPeerId || `h-${hex(8)}`;
    token = hex(24);
  } else {
    peerId = `v-${hex(8)}`;
    token = hex(24);
  }
  const record: PeerRecord = {
    peerId,
    name,
    role: isHost ? "host" : "viewer",
    clientId,
    ipHash,
    tokenHash: sha256(token),
    joinedAt: isHost ? (peers.find((p) => p.peerId === peerId)?.joinedAt ?? now) : now,
    lastSeen: now,
  };
  await store.hset(kPeers(code), { [peerId]: JSON.stringify(record) });

  await publish(code, { type: "peer-joined", peer: publicPeer(record) });
  await touchRoom(code);

  peers = await loadPeers(code);

  // Riwayat chat terakhir untuk klien baru.
  const recent = await store.xrangeAfter(kEvents(code), null, 400);
  const chatHistory: ChatEventPayload[] = [];
  for (const entry of recent) {
    if (entry.fields.type !== "chat") continue;
    try {
      const payload = JSON.parse(entry.fields.payload) as { payload?: ChatEventPayload };
      if (payload.payload) chatHistory.push(payload.payload);
    } catch {
      /* abaikan */
    }
  }

  const cursor = recent.length ? recent[recent.length - 1].id : null;

  return ok({
    peerId,
    token,
    role: record.role,
    room: roomInfoOf(meta, peers, code),
    peers: peers.map(publicPeer),
    cursor,
    chatHistory: chatHistory.slice(-50),
  });
}

function ip2Key(ip: string): string {
  return sha256(ip).slice(0, 16);
}

// ------------------------- heartbeat -------------------------

export async function heartbeatRoom(
  codeRaw: string,
  input: Record<string, unknown>,
): Promise<JsonResult> {
  const code = normalizeRoomCode(codeRaw);
  const peer = await verifyPeer(code, input.peerId, input.token);
  if (!peer) return err(401, "SESSION_EXPIRED");
  const meta = await loadRoom(code);
  if (!meta || meta.closed) return roomNotFound();
  const peers = await loadPeers(code); // sekaligus prune yang timeout
  await touchRoom(code);
  return ok({ ok: true, room: roomInfoOf(meta, peers, code), peers: peers.map(publicPeer) });
}

// ------------------------- pesan (signal/chat/reaction) -------------------------

export async function postMessage(
  codeRaw: string,
  input: Record<string, unknown>,
): Promise<JsonResult> {
  const code = normalizeRoomCode(codeRaw);
  const peer = await verifyPeer(code, input.peerId, input.token);
  if (!peer) return err(401, "SESSION_EXPIRED");

  if (!(await rateLimit("msg", `${code}:${peer.peerId}`, 600, 60))) {
    return err(429, "RATE_LIMITED");
  }

  const kind = input.kind;
  if (kind === "chat") {
    const text = str((input.payload as Record<string, unknown> | undefined)?.text, 500);
    if (!text) return err(400, "INVALID_MESSAGE");
    const payload: ChatEventPayload = { peerId: peer.peerId, name: peer.name, text, ts: Date.now() };
    const id = await publish(code, { type: "chat", payload });
    return ok({ ok: true, id });
  }

  if (kind === "reaction") {
    const emoji = String((input.payload as Record<string, unknown> | undefined)?.emoji ?? "");
    if (!(REACTIONS as readonly string[]).includes(emoji)) return err(400, "INVALID_REACTION");
    const id = await publish(code, {
      type: "reaction",
      payload: { peerId: peer.peerId, name: peer.name, emoji, ts: Date.now() },
    });
    return ok({ ok: true, id });
  }

  if (kind === "signal") {
    const to = str(input.to, 40);
    if (!to) return err(400, "INVALID_TARGET");
    const data = (input.payload ?? {}) as Record<string, unknown>;
    // Host boleh broadcast (to:"*") HANYA untuk hostState.
    if (to === "*" && peer.role !== "host") return err(403, "FORBIDDEN");
    if (to !== "*") {
      const target = await getStore().hget(kPeers(code), to);
      if (!target) return err(404, "TARGET_GONE");
    }
    const signal: Record<string, unknown> = { from: peer.peerId, to };
    if (data.sdp !== undefined) {
      const sdp = data.sdp as { type?: unknown; sdp?: unknown };
      if (
        typeof sdp?.type !== "string" ||
        !["offer", "answer"].includes(sdp.type) ||
        typeof sdp.sdp !== "string" ||
        sdp.sdp.length > 40_000
      ) {
        return err(400, "INVALID_SDP");
      }
      signal.sdp = { type: sdp.type, sdp: sdp.sdp };
    } else if (data.candidate !== undefined) {
      if (typeof data.candidate !== "object" || data.candidate === null) return err(400, "INVALID_CANDIDATE");
      if (JSON.stringify(data.candidate).length > 4_000) return err(400, "INVALID_CANDIDATE");
      signal.candidate = data.candidate;
    } else if (data.hostState !== undefined) {
      if (peer.role !== "host") return err(403, "FORBIDDEN");
      const sharing = Boolean((data.hostState as { sharing?: unknown }).sharing);
      signal.hostState = { sharing };
    } else if (data.requestOffer === true) {
      signal.requestOffer = true;
    } else {
      return err(400, "INVALID_SIGNAL");
    }
    const id = await publish(code, { type: "signal", payload: signal }, to === "*" ? undefined : to);
    return ok({ ok: true, id });
  }

  return err(400, "UNKNOWN_KIND");
}

// ------------------------- aksi host (kick/ban/dll) -------------------------

export async function hostAction(
  codeRaw: string,
  input: Record<string, unknown>,
): Promise<JsonResult> {
  const code = normalizeRoomCode(codeRaw);
  const meta = await loadRoom(code);
  if (!meta || meta.closed) return roomNotFound();
  if (typeof input.hostToken !== "string" || !safeEqual(sha256(input.hostToken), meta.hostTokenHash)) {
    return err(403, "INVALID_TOKEN", "Token host tidak valid.");
  }
  if (!(await rateLimit("host", code, 300, 60))) return err(429, "RATE_LIMITED");

  const store = getStore();
  const action = String(input.action ?? "");

  if (action === "kick" || action === "ban") {
    const peerId = str(input.peerId, 40);
    if (!peerId) return err(400, "INVALID_PEER");
    if (peerId === meta.hostPeerId) return err(400, "CANNOT_TARGET_HOST");
    const raw = await store.hget(kPeers(code), peerId);
    const target = raw ? (JSON.parse(raw) as PeerRecord) : null;

    if (action === "ban" && target) {
      await store.sadd(kBans(code), `c:${target.clientId}`, `i:${target.ipHash}`);
      await store.hset(kBanMeta(code), { [target.clientId]: target.ipHash });
      await store.expire(kBans(code), ROOM_TTL_SECONDS);
      await store.expire(kBanMeta(code), ROOM_TTL_SECONDS);
    }
    if (target) {
      await store.hdel(kPeers(code), peerId);
      await store.set(kGone(code, peerId), action === "ban" ? "banned" : "kicked", 120);
      await publish(code, { type: "peer-left", peerId, reason: action === "ban" ? "banned" : "kicked" });
    }
    const peers = await loadPeers(code);
    return ok({ ok: true, room: roomInfoOf(meta, peers, code), peers: peers.map(publicPeer) });
  }

  if (action === "unban") {
    const clientId = str(input.clientId, 64);
    if (!clientId) return err(400, "INVALID_CLIENT_ID");
    const ipHash = await store.hget(kBanMeta(code), clientId);
    const members = [`c:${clientId}`];
    if (ipHash) members.push(`i:${ipHash}`);
    await store.srem(kBans(code), ...members);
    await store.hdel(kBanMeta(code), clientId);
    return ok({ ok: true, bans: await listBans(code) });
  }

  if (action === "list-bans") {
    return ok({ ok: true, bans: await listBans(code) });
  }

  if (action === "set-password") {
    let pwSalt = "";
    let pwHash = "";
    if (input.password != null && input.password !== "") {
      const pw = str(input.password, 64);
      if (!pw || pw.length < 4) return err(400, "INVALID_PASSWORD", "Password minimal 4 karakter.");
      pwSalt = hex(16);
      pwHash = sha256(pwSalt + pw);
    }
    await store.hset(kRoom(code), { pwSalt, pwHash });
    const peers = await loadPeers(code);
    const room = roomInfoOf({ ...meta, pwSalt, pwHash }, peers, code);
    await publish(code, { type: "room-updated", room });
    return ok({ ok: true, room });
  }

  if (action === "rename") {
    const name = str(input.name, 40);
    if (!name) return err(400, "INVALID_NAME");
    await store.hset(kRoom(code), { name });
    const peers = await loadPeers(code);
    const room = roomInfoOf({ ...meta, name }, peers, code);
    await publish(code, { type: "room-updated", room });
    return ok({ ok: true, room });
  }

  if (action === "set-max-viewers") {
    let maxViewers = DEFAULT_MAX_VIEWERS;
    if (typeof input.maxViewers === "number" && Number.isInteger(input.maxViewers)) {
      maxViewers = Math.min(Math.max(input.maxViewers, 1), ABS_MAX_VIEWERS);
    }
    await store.hset(kRoom(code), { maxViewers: String(maxViewers) });
    const peers = await loadPeers(code);
    const room = roomInfoOf({ ...meta, maxViewers }, peers, code);
    await publish(code, { type: "room-updated", room });
    return ok({ ok: true, room });
  }

  if (action === "set-public") {
    const isPublic = input.public === true;
    await store.hset(kRoom(code), { isPublic: isPublic ? "1" : "" });
    if (isPublic) await store.sadd(kPublicRooms, code);
    else await store.srem(kPublicRooms, code);
    const peers = await loadPeers(code);
    const room = roomInfoOf({ ...meta, isPublic }, peers, code);
    await publish(code, { type: "room-updated", room });
    return ok({ ok: true, room });
  }

  if (action === "close") {
    await store.hset(kRoom(code), { closed: "1" });
    await store.srem(kPublicRooms, code);
    await publish(code, { type: "room-closed" });
    // Beri waktu 60 detik agar stream SSE yang aktif sempat membaca penutupan.
    await Promise.all([
      store.expire(kRoom(code), 60),
      store.expire(kPeers(code), 60),
      store.expire(kEvents(code), 60),
    ]);
    return ok({ ok: true });
  }

  return err(400, "UNKNOWN_ACTION");
}

async function listBans(code: string): Promise<{ clientId: string }[]> {
  const meta = await getStore().hgetall(kBanMeta(code));
  return Object.keys(meta).map((clientId) => ({ clientId }));
}

// ------------------------- daftar room publik -------------------------

const MAX_PUBLIC_LIST = 50;

/**
 * Daftar room yang diaktifkan publik oleh host-nya.
 * Sambil membaca, set global dibersihkan dari room yang sudah kedaluwarsa/ditutup.
 * Tidak membocorkan rahasia apa pun - hanya info yang sama dengan endpoint info room.
 */
export async function listPublicRooms(ip: string): Promise<JsonResult> {
  if (!(await rateLimit("list-public", ip2Key(ip), 30, 60))) return err(429, "RATE_LIMITED");
  const store = getStore();
  const codes = (await store.smembers(kPublicRooms)).slice(0, 200);
  const rooms: RoomInfo[] = [];
  const dead: string[] = [];
  for (const code of codes) {
    if (!/^[A-Z0-9]{12}$/.test(code)) {
      dead.push(code);
      continue;
    }
    const meta = await loadRoom(code);
    if (!meta || meta.closed || !meta.isPublic) {
      dead.push(code);
      continue;
    }
    const peers = await loadPeers(code);
    rooms.push(roomInfoOf(meta, peers, code));
  }
  if (dead.length) await store.srem(kPublicRooms, ...dead);
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  return ok({ rooms: rooms.slice(0, MAX_PUBLIC_LIST) });
}

// ------------------------- leave -------------------------

export async function leaveRoom(
  codeRaw: string,
  input: Record<string, unknown>,
): Promise<JsonResult> {
  const code = normalizeRoomCode(codeRaw);
  const peer = await verifyPeer(code, input.peerId, input.token);
  if (!peer) return ok({ ok: true });
  const store = getStore();
  await store.hdel(kPeers(code), peer.peerId);
  await publish(code, { type: "peer-left", peerId: peer.peerId, reason: "left" });
  return ok({ ok: true });
}

// ------------------------- SSE stream -------------------------

export interface StreamHandlers {
  emit(id: string, type: string, data: unknown): void;
  comment(text: string): void;
  isClosed(): boolean;
}

/**
 * Loop SSE: kirim event room ke satu peer sampai koneksi ditutup,
 * batas durasi tercapai, atau peer dihapus dari room.
 */
export async function streamEvents(
  codeRaw: string,
  input: { peerId: string; token: string; cursor: string | null; maxMs: number },
  handlers: StreamHandlers,
): Promise<void> {
  const code = normalizeRoomCode(codeRaw);
  const store = getStore();

  const peer = await verifyPeer(code, input.peerId, input.token);
  if (!peer) {
    handlers.emit("0", "error", { error: "SESSION_EXPIRED" });
    return;
  }

  const started = Date.now();
  let cursor = input.cursor;
  let lastPing = Date.now();
  let lastPrune = 0;

  while (!handlers.isClosed()) {
    if (Date.now() - started > input.maxMs) break;

    const entries = await store.xrangeAfter(kEvents(code), cursor, 100);
    for (const entry of entries) {
      cursor = entry.id;
      const to = entry.fields.to;
      if (to && to !== peer.peerId) continue; // bukan untuk koneksi ini
      try {
        const payload = JSON.parse(entry.fields.payload) as Record<string, unknown>;
        handlers.emit(entry.id, String(payload.type ?? entry.fields.type), payload);
      } catch {
        /* lewati event rusak */
      }
    }

    // Prune peer mati + refresh presence sendiri, maksimal tiap 10 detik.
    const now = Date.now();
    if (now - lastPrune > 10_000) {
      lastPrune = now;
      await refreshPeer(code, peer.peerId);
      await loadPeers(code);
    }

    // Masih jadi anggota room?
    const stillMember = await store.hget(kPeers(code), peer.peerId);
    if (!stillMember) {
      const reason = (await store.get(kGone(code, peer.peerId))) ?? "timeout";
      handlers.emit("0", "you-removed", { reason });
      break;
    }

    // Room ditutup?
    const roomExists = await store.hget(kRoom(code), "name");
    if (!roomExists) {
      handlers.emit("0", "you-removed", { reason: "closed" });
      break;
    }
    const closed = await store.hget(kRoom(code), "closed");
    if (closed === "1") break; // event room-closed sudah terkirim lewat stream

    if (now - lastPing > 15_000) {
      lastPing = now;
      handlers.comment("ping");
    }

    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

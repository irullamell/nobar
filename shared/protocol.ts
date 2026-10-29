// Protokol bersama antara frontend dan serverless functions.
// Dijaga tetap kecil dan bebas dependensi agar bisa di-import dari api/ dan src/.

export const APP_NAME = "Piik Lite";

/** Jumlah viewer maksimal default (P2P mesh dari uplink host). */
export const DEFAULT_MAX_VIEWERS = 12;
export const ABS_MAX_VIEWERS = 20;

/** Umur room tanpa aktivitas (detik). */
export const ROOM_TTL_SECONDS = 24 * 60 * 60;

/** Interval heartbeat presence klien (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Peer dianggap offline jika tidak ter-refresh selama ini (ms).
 * Sengaja longgar (120 detik): browser men-throttle timer di tab background
 * (bisa jadi ±1x/menit), dan loop SSE server juga ikut me-refresh lastSeen.
 */
export const PRESENCE_TIMEOUT_MS = 120_000;

/** Alur sinyal SSE: server menutup stream setelah ini (ms), klien reconnect. */
export const SSE_MAX_DURATION_MS = 50_000;

export const ICE_SERVERS: { urls: string[] }[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

export type PeerRole = "host" | "viewer";

export interface PeerInfo {
  peerId: string;
  name: string;
  role: PeerRole;
  joinedAt: number;
}

export interface RoomInfo {
  code: string;
  name: string;
  passwordProtected: boolean;
  maxViewers: number;
  viewerCount: number;
  hostOnline: boolean;
  createdAt: number;
  /** True bila host mengaktifkan "room publik" (tampil di daftar room publik). */
  isPublic: boolean;
}

export interface CreateRoomResponse {
  code: string;
  hostToken: string;
  hostPeerId: string;
  room: RoomInfo;
}

export interface JoinResponse {
  peerId: string;
  token: string;
  role: PeerRole;
  room: RoomInfo;
  peers: PeerInfo[];
  cursor: string | null;
  /** Riwayat chat terakhir agar klien baru tidak kosong. */
  chatHistory: ChatEventPayload[];
}

export interface ChatEventPayload {
  peerId: string;
  name: string;
  text: string;
  ts: number;
}

export interface ReactionEventPayload {
  peerId: string;
  name: string;
  emoji: string;
  ts: number;
}

/** Payload signal WebRTC yang direlai server. */
export interface SignalPayload {
  from: string;
  to: string;
  sdp?: { type: string; sdp: string };
  candidate?: unknown;
  hostState?: { sharing: boolean };
  requestOffer?: boolean;
}

export type RoomEvent =
  | { id: string; type: "peer-joined"; peer: PeerInfo }
  | { id: string; type: "peer-left"; peerId: string; reason: "left" | "kicked" | "banned" | "timeout" }
  | { id: string; type: "signal"; payload: SignalPayload }
  | { id: string; type: "chat"; payload: ChatEventPayload }
  | { id: string; type: "reaction"; payload: ReactionEventPayload }
  | { id: string; type: "room-updated"; room: RoomInfo }
  | { id: string; type: "room-closed" }
  /** Dikirim HANYA ke peer yang dihapus (bukan broadcast). */
  | { id: string; type: "you-removed"; reason: "kicked" | "banned" | "closed" | "timeout" };

export const REACTIONS = ["👍", "❤️", "😂", "😮", "🎉", "👏"] as const;

/** Format kode room: XXXX-XXXX-XXXX (tanpa karakter ambigu). */
export function formatRoomCode(code: string): string {
  const clean = normalizeRoomCode(code);
  return clean.replace(/(.{4})(?=.)/g, "$1-");
}

export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const ROOM_CODE_LENGTH = 12;

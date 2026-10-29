// Klien HTTP untuk serverless API Piik Lite.
import type { CreateRoomResponse, JoinResponse, PeerInfo, RoomInfo } from "../../shared/protocol";

/** Basis URL API: origin yang sama di browser; bisa di-override untuk pengujian di Node. */
export const API_BASE: string =
  typeof location !== "undefined" && location.origin ? location.origin : "";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API_BASE + url, init);
  } catch {
    throw new ApiError("NETWORK", "Tidak dapat menghubungi server. Periksa koneksi Anda.", 0);
  }
  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(record.error ?? `HTTP_${response.status}`, record.message ?? `Server error (${response.status})`, response.status);
  }
  return body as T;
}

function postJson(_label: string, body: unknown): RequestInit {
  void _label;
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function apiCreateRoom(input: {
  name: string;
  hostName: string;
  clientId: string;
  password?: string;
  maxViewers?: number;
  public?: boolean;
}): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>("/api/rooms", postJson("/api/rooms", input));
}

export function apiListPublicRooms(): Promise<{ rooms: RoomInfo[] }> {
  return request<{ rooms: RoomInfo[] }>("/api/rooms?list=public", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
}

export interface HealthInfo {
  ok: boolean;
  storage: "redis" | "memory" | "missing";
  production: boolean;
  hint?: string;
}

export function apiHealth(): Promise<HealthInfo> {
  return request<HealthInfo>("/api/health", { cache: "no-store" });
}

export function apiRoomInfo(code: string): Promise<{ room: RoomInfo }> {
  return request<{ room: RoomInfo }>(`/api/rooms/${encodeURIComponent(code)}`);
}

export function apiJoin(
  code: string,
  input: { name: string; clientId: string; password?: string; hostToken?: string },
): Promise<JoinResponse> {
  return request<JoinResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, postJson("join", input));
}

export function apiHeartbeat(
  code: string,
  input: { peerId: string; token: string },
): Promise<{ ok: boolean; room: RoomInfo; peers: PeerInfo[] }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/heartbeat`, postJson("heartbeat", input));
}

export function apiSendMessage(
  code: string,
  input: { peerId: string; token: string; kind: string; to?: string; payload?: unknown },
): Promise<{ ok: boolean; id?: string }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/messages`, postJson("messages", input));
}

export function apiHostAction<T = { ok: boolean }>(
  code: string,
  input: { hostToken: string; action: string } & Record<string, unknown>,
): Promise<T> {
  return request<T>(`/api/rooms/${encodeURIComponent(code)}/host`, postJson("host", input));
}

export function apiLeave(code: string, input: { peerId: string; token: string }): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/leave`, postJson("leave", input));
}

// RoomSession: bergabung, menjaga koneksi SSE (pengganti WebSocket di Vercel),
// heartbeat presence, kirim pesan, dan aksi host.
import {
  HEARTBEAT_INTERVAL_MS,
  type JoinResponse,
  type PeerInfo,
  type PeerRole,
  type RoomInfo,
} from "../../shared/protocol";
import { ApiError, apiHeartbeat, apiHostAction, apiJoin, apiSendMessage } from "./api";

export interface SessionEventEnvelope {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export type SessionFatalReason = "kicked" | "banned" | "closed" | "timeout" | "session-lost";

export interface SessionCallbacks {
  onJoined(info: JoinResponse): void;
  onEvent(ev: SessionEventEnvelope): void;
  onStatus(status: "connecting" | "live" | "reconnecting"): void;
  onFatal(reason: SessionFatalReason, message?: string): void;
  onRoomUpdate(room: RoomInfo, peers: PeerInfo[]): void;
}

export interface SessionCredentials {
  code: string;
  name: string;
  clientId: string;
  password?: string;
  hostToken?: string;
}

export class RoomSession {
  peerId = "";
  token = "";
  role: PeerRole = "viewer";
  room: RoomInfo | null = null;
  peers: PeerInfo[] = [];

  private cursor: string | null = null;
  private stopped = false;
  private abort: AbortController | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private status: "connecting" | "live" | "reconnecting" = "connecting";
  private processedIds = new Set<string>();
  private lastProcessedId: string | null = null;

  constructor(
    private readonly creds: SessionCredentials,
    private readonly cb: SessionCallbacks,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.join();
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    void this.sseLoop();
  }

  private setStatus(s: "connecting" | "live" | "reconnecting"): void {
    this.status = s;
    this.cb.onStatus(s);
  }

  private async join(): Promise<void> {
    const info = await apiJoin(this.creds.code, {
      name: this.creds.name,
      clientId: this.creds.clientId,
      password: this.creds.password,
      hostToken: this.creds.hostToken,
    });
    this.peerId = info.peerId;
    this.token = info.token;
    this.role = info.role;
    this.room = info.room;
    this.peers = info.peers;
    if (info.cursor) {
      this.cursor = info.cursor;
      this.lastProcessedId = info.cursor;
    }
    this.processedIds.clear();
    this.cb.onJoined(info);
  }

  /** Rejoin setelah sesi kedaluwarsa di server (mis. tab tidur lama). */
  private async rejoin(): Promise<boolean> {
    try {
      await this.join();
      return true;
    } catch (error) {
      if (error instanceof ApiError && ["BANNED", "ROOM_NOT_FOUND", "ROOM_FULL", "WRONG_PASSWORD"].includes(error.code)) {
        this.fatal(error.code === "BANNED" ? "banned" : "session-lost", error.message);
      }
      return false;
    }
  }

  private fatal(reason: SessionFatalReason, message?: string): void {
    this.stopInternal(false);
    this.cb.onFatal(reason, message);
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.peerId) return;
    try {
      const result = await apiHeartbeat(this.creds.code, { peerId: this.peerId, token: this.token });
      this.room = result.room;
      this.peers = result.peers;
      this.cb.onRoomUpdate(result.room, result.peers);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Sesi hilang di server: coba masuk ulang dengan kredensial yang sama.
        if (await this.rejoin()) this.setStatus("live");
      } else if (error instanceof ApiError && error.status === 404) {
        this.fatal("closed", error.message || "Room ditutup atau sudah kedaluwarsa.");
      }
      // Error jaringan sesaat diabaikan; percobaan berikutnya menyusul.
    }
  }

  private async sseLoop(): Promise<void> {
    while (!this.stopped) {
      this.setStatus(this.status === "live" ? "reconnecting" : this.status);
      try {
        await this.openStream();
        if (this.stopped) return;
        // Stream berakhir normal (batas durasi server) - reconnect setelah jeda.
        this.setStatus("reconnecting");
      } catch {
        if (this.stopped) return;
        this.setStatus("reconnecting");
      }
      await sleep(1200 + Math.random() * 800);
      // Pastikan sesi masih hidup sebelum reconnect.
      try {
        await apiHeartbeat(this.creds.code, { peerId: this.peerId, token: this.token });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          if (!(await this.rejoin())) return;
        } else if (error instanceof ApiError && error.status === 404) {
          this.fatal("closed", error.message || "Room ditutup atau sudah kedaluwarsa.");
          return;
        }
      }
    }
  }

  private async openStream(): Promise<void> {
    this.abort = new AbortController();
    const params = new URLSearchParams({ peerId: this.peerId });
    if (this.cursor) params.set("cursor", this.cursor);
    const response = await fetch(`/api/rooms/${encodeURIComponent(this.creds.code)}/events?${params}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    this.setStatus("live");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        this.handleFrame(frame);
        if (this.stopped) return;
      }
    }
  }

  private handleFrame(frame: string): void {
    let id = "";
    let type = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4).trim();
      else if (line.startsWith("event: ")) type = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
      else if (line.startsWith(":")) continue; // komentar (ping)
    }
    if (!data) return;
    if (id && id !== "0") {
      this.cursor = id;
      if (this.lastProcessedId && id === this.lastProcessedId) return;
      if (this.processedIds.has(id)) return;
      this.processedIds.add(id);
      this.lastProcessedId = id;
      if (this.processedIds.size > 4096) this.processedIds.clear();
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (type === "you-removed") {
      const reason = String(parsed.reason ?? "timeout");
      if (reason === "kicked") this.fatal("kicked", "Anda dikeluarkan (kick) oleh host.");
      else if (reason === "banned") this.fatal("banned", "Anda di-ban oleh host dan tidak dapat masuk kembali.");
      else if (reason === "closed") this.fatal("closed", "Room ditutup oleh host.");
      else this.fatal("timeout", "Koneksi presence kedaluwarsa.");
      return;
    }
    if (type === "error") {
      if (String(parsed.error) === "SESSION_EXPIRED") void this.heartbeat();
      return;
    }
    this.cb.onEvent({ id, type, data: parsed });
  }

  // ------- aksi keluar -------

  async sendChat(text: string): Promise<void> {
    await apiSendMessage(this.creds.code, { peerId: this.peerId, token: this.token, kind: "chat", payload: { text } });
  }

  async sendReaction(emoji: string): Promise<void> {
    await apiSendMessage(this.creds.code, { peerId: this.peerId, token: this.token, kind: "reaction", payload: { emoji } });
  }

  async sendSignal(to: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await apiSendMessage(this.creds.code, { peerId: this.peerId, token: this.token, kind: "signal", to, payload });
    } catch (error) {
      // TARGET_GONE wajar saat viewer menutup tab di tengah negosiasi.
      if (error instanceof ApiError && error.code !== "TARGET_GONE" && error.code !== "RATE_LIMITED") {
        console.warn("[session] sendSignal gagal:", error.code);
      }
    }
  }

  async hostCall<T = { ok: boolean }>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.creds.hostToken) throw new ApiError("NOT_HOST", "Bukan host", 403);
    return apiHostAction<T>(this.creds.code, { hostToken: this.creds.hostToken, action, ...params });
  }

  /** Keluar sukarela dan hentikan semua loop. */
  leave(): void {
    const payload = { peerId: this.peerId, token: this.token };
    const code = this.creds.code;
    this.stopInternal(false);
    if (payload.peerId) {
      // best-effort; pakai keepalive agar tetap terkirim saat tab ditutup.
      fetch(`/api/rooms/${encodeURIComponent(code)}/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  /** Berhenti tanpa memberi tahu server (dipakai saat fatal). */
  stop(): void {
    this.stopInternal(false);
  }

  private stopInternal(_sendLeave: boolean): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

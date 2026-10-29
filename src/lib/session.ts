// RoomSession: bergabung, menjaga koneksi SSE (pengganti WebSocket di Vercel),
// heartbeat presence, kirim pesan, dan aksi host.
//
// Prinsip ketahanan (penting di Vercel):
// - Server menutup tiap stream SSE di batas durasi function (±50 dtk), dan
//   Vercel bisa MEMUTUS PAKSA function (mis. paket Hobby 10 dtk). Keduanya
//   adalah siklus normal: selama stream pernah hidup >= HEALTHY_STREAM_MIN_MS,
//   reconnect dilakukan SENYAP (status tetap "live") karena cursor Redis
//   menjamin tidak ada event yang hilang.
// - Status "reconnecting" hanya ditampilkan bila stream gagal/berakhir sangat
//   cepat secara BERUNTUN (masalah sungguhan), dengan backoff.
// - Presence dipertahankan oleh heartbeat (15 dtk) + refresh lastSeen dari
//   loop SSE di server; timeout server longgar (120 dtk) agar tab background
//   yang di-throttle browser tidak dianggap offline.
// - Bila presence terlanjur kedaluwarsa (you-removed timeout), sesi melakukan
//   REJOIN SENYAP - pengguna tidak ditendang dari room.
import {
  HEARTBEAT_INTERVAL_MS,
  type JoinResponse,
  type PeerInfo,
  type PeerRole,
  type RoomInfo,
} from "../../shared/protocol";
import { ApiError, API_BASE, apiHeartbeat, apiHostAction, apiJoin, apiSendMessage } from "./api";

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

/** Stream yang hidup sepanjang ini dianggap siklus sehat walau berakhir kasar. */
const HEALTHY_STREAM_MIN_MS = 3_000;
/** Server mengirim ping tiap ±15 dtk; tanpa byte selama ini = stream mati. */
const STALL_TIMEOUT_MS = 45_000;
/** Saat tab visible lagi, paksa refresh stream bila sunyi lebih dari ini. */
const REFRESH_ON_VISIBLE_AFTER_MS = 20_000;

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
  private watchdogTimer: number | null = null;
  private lastActivity = 0;
  private processedIds = new Set<string>();
  private lastProcessedId: string | null = null;
  private rejoinPromise: Promise<boolean> | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor(
    private readonly creds: SessionCredentials,
    private readonly cb: SessionCallbacks,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.join();
    if (this.stopped) return;
    this.attachVisibility();
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    void this.sseLoop();
  }

  private setStatus(s: "connecting" | "live" | "reconnecting"): void {
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

  /** Rejoin terdeduplikasi: panggilan paralel berbagi satu promise. */
  private ensureRejoin(): Promise<boolean> {
    if (!this.rejoinPromise) {
      this.rejoinPromise = this.rejoin().finally(() => {
        this.rejoinPromise = null;
      });
    }
    return this.rejoinPromise;
  }

  private fatal(reason: SessionFatalReason, message?: string): void {
    this.stopInternal();
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
      if (this.stopped) return;
      if (error instanceof ApiError && error.status === 401) {
        // Sesi hilang di server: coba masuk ulang dengan kredensial yang sama.
        if (await this.ensureRejoin()) this.setStatus("live");
      } else if (error instanceof ApiError && error.status === 404) {
        this.fatal("closed", error.message || "Room ditutup atau sudah kedaluwarsa.");
      }
      // Error jaringan sesaat diabaikan; percobaan berikutnya menyusul.
    }
  }

  /** Pulihkan presence yang kedaluwarsa tanpa menendang pengguna. */
  private async handlePresenceReset(): Promise<void> {
    if (this.stopped) return;
    const okJoin = await this.ensureRejoin();
    if (!okJoin && !this.stopped) {
      this.fatal("timeout", "Koneksi presence kedaluwarsa dan gagal memulihkan sesi.");
    }
  }

  private attachVisibility(): void {
    if (typeof document === "undefined" || this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (this.stopped || document.visibilityState !== "visible") return;
      // Tab aktif lagi: segera heartbeat; bila stream tampak mati (tab tadi
      // tidur), paksa putus agar loop menyambung ulang dengan cepat.
      void this.heartbeat();
      if (Date.now() - this.lastActivity > REFRESH_ON_VISIBLE_AFTER_MS) this.abort?.abort();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private detachVisibility(): void {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }

  private async sseLoop(): Promise<void> {
    // quickEnds: jumlah stream beruntun yang gagal/berakhir sangat cepat.
    // Siklus normal (server menutup stream di batas durasi function, atau
    // Vercel memutus paksa setelah stream hidup beberapa detik) TIDAK mengubah
    // status - reconnect senyap karena cursor menjamin tidak ada event hilang.
    let quickEnds = 0;
    while (!this.stopped) {
      if (this.rejoinPromise) {
        await this.rejoinPromise;
        if (this.stopped) return;
      }

      const startedAt = Date.now();
      let healthy = false;
      try {
        await this.openStream(startedAt);
        healthy = Date.now() - startedAt >= HEALTHY_STREAM_MIN_MS;
      } catch {
        healthy = false;
      }
      if (this.stopped) return;

      if (healthy) quickEnds = 0;
      else quickEnds = Math.min(quickEnds + 1, 10);

      const degraded = quickEnds >= 2;
      if (degraded) this.setStatus("reconnecting");
      // else: status dibiarkan "live" (reconnect senyap)

      const delay = degraded
        ? Math.min(1_000 * quickEnds + Math.random() * 800, 8_000)
        : 200 + Math.random() * 300;
      await sleep(delay);
      if (this.stopped) return;

      // Hanya pada jalur bermasalah: pastikan sesi masih hidup sebelum reconnect.
      if (degraded) {
        try {
          await apiHeartbeat(this.creds.code, { peerId: this.peerId, token: this.token });
        } catch (error) {
          if (this.stopped) return;
          if (error instanceof ApiError && error.status === 401) {
            if (!(await this.ensureRejoin())) return;
          } else if (error instanceof ApiError && error.status === 404) {
            this.fatal("closed", error.message || "Room ditutup atau sudah kedaluwarsa.");
            return;
          }
        }
      }
    }
  }

  private async openStream(startedAt: number): Promise<void> {
    this.abort = new AbortController();
    const params = new URLSearchParams({ peerId: this.peerId });
    if (this.cursor) params.set("cursor", this.cursor);
    const response = await fetch(
      `${API_BASE}/api/rooms/${encodeURIComponent(this.creds.code)}/events?${params}`,
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
        signal: this.abort.signal,
      },
    );
    if (!response.ok) {
      let message = `SSE HTTP ${response.status}`;
      let code = "";
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        code = body.error ?? "";
        if (body.message) message = body.message;
      } catch {
        /* body bukan JSON */
      }
      if (response.status === 503 || code === "STORAGE_NOT_CONFIGURED") {
        // Server salah konfigurasi - jangan loop tanpa ujung.
        this.fatal("session-lost", message);
        throw new Error("FATAL");
      }
      throw new Error(message);
    }
    if (!response.body) throw new Error("SSE tanpa body");
    this.setStatus("live");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    this.lastActivity = Date.now();

    // Watchdog: server selalu mengirim data/ping tiap ±15 dtk. Tanpa byte
    // selama 45 dtk berarti koneksi setengah mati (mis. pindah jaringan) -
    // putuskan agar loop reconnect.
    this.watchdogTimer = window.setInterval(() => {
      if (Date.now() - this.lastActivity > STALL_TIMEOUT_MS) this.abort?.abort();
    }, 5_000);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.lastActivity = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleFrame(frame);
          if (this.stopped) return;
        }
      }
    } catch (error) {
      if (this.stopped) return;
      // Pemutusan KASAR setelah stream sempat hidup sehat (Vercel membunuh
      // function di maxDuration, proxy menutup koneksi, dsb.) diperlakukan
      // seperti siklus normal: kembali senyap, loop akan reconnect.
      if (Date.now() - startedAt >= HEALTHY_STREAM_MIN_MS) return;
      throw error;
    } finally {
      if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
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
      else void this.handlePresenceReset(); // timeout → pulihkan senyap
      return;
    }
    if (type === "error") {
      if (String(parsed.error) === "SESSION_EXPIRED") void this.ensureRejoin();
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
    this.stopInternal();
    if (payload.peerId) {
      // best-effort; pakai keepalive agar tetap terkirim saat tab ditutup.
      fetch(`${API_BASE}/api/rooms/${encodeURIComponent(code)}/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  /** Berhenti tanpa memberi tahu server (dipakai saat fatal). */
  stop(): void {
    this.stopInternal();
  }

  private stopInternal(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
    this.detachVisibility();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WebRTC P2P: host menyiarkan layar ke setiap viewer (mesh), sinyal direlai
// lewat API serverless (SSE + POST). Tanpa SFU - sesuai desain P2P-first Piik.
import { ICE_SERVERS, type PeerInfo } from "../../shared/protocol";
import type { RoomSession, SessionEventEnvelope } from "./session";

type SignalData = {
  from?: string;
  to?: string;
  sdp?: { type: string; sdp: string };
  candidate?: RTCIceCandidateInit;
  hostState?: { sharing: boolean };
  requestOffer?: boolean;
};

function signalDataOf(ev: SessionEventEnvelope): SignalData | null {
  if (ev.type !== "signal") return null;
  const payload = ev.data.payload as SignalData | undefined;
  return payload ?? null;
}

// ============================ HOST ============================

export type PeerConnState = "new" | "connecting" | "connected" | "failed" | "closed";

export class HostBroadcaster {
  private pcs = new Map<string, RTCPeerConnection>();
  private stream: MediaStream | null = null;
  sharing = false;

  constructor(
    private readonly session: RoomSession,
    private readonly onPeerState: (peerId: string, state: PeerConnState) => void,
    private readonly onLocalStream: (stream: MediaStream | null) => void,
  ) {}

  handleEvent(ev: SessionEventEnvelope): void {
    if (ev.type === "peer-joined") {
      const peer = ev.data.peer as PeerInfo;
      if (peer.role === "viewer" && this.sharing) void this.openPeer(peer.peerId);
      return;
    }
    if (ev.type === "peer-left") {
      this.closePeer(String(ev.data.peerId));
      return;
    }
    const sig = signalDataOf(ev);
    if (!sig) return;
    if (sig.requestOffer && this.sharing) {
      void this.openPeer(String(sig.from));
      return;
    }
    const pc = sig.from ? this.pcs.get(sig.from) : undefined;
    if (!pc) return;
    if (sig.sdp?.type === "answer") {
      pc.setRemoteDescription(new RTCSessionDescription(sig.sdp as RTCSessionDescriptionInit)).catch((e) =>
        console.warn("[host] setRemoteDescription gagal:", e),
      );
    } else if (sig.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch((e) => console.warn("[host] addIceCandidate:", e));
    }
  }

  async startSharing(): Promise<void> {
    if (this.sharing) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });
    this.stream = stream;
    this.sharing = true;
    this.onLocalStream(stream);
    // Bila pengguna menekan "Stop sharing" di UI browser:
    stream.getVideoTracks()[0]?.addEventListener("ended", () => void this.stopSharing());
    await this.session.sendSignal("*", { hostState: { sharing: true } });
    for (const peer of this.session.peers) {
      if (peer.role === "viewer") await this.openPeer(peer.peerId);
    }
  }

  async stopSharing(): Promise<void> {
    if (!this.sharing && !this.stream) return;
    this.sharing = false;
    for (const peerId of [...this.pcs.keys()]) this.closePeer(peerId);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.onLocalStream(null);
    await this.session.sendSignal("*", { hostState: { sharing: false } }).catch(() => undefined);
  }

  private async openPeer(peerId: string): Promise<void> {
    if (!this.stream || this.pcs.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pcs.set(peerId, pc);
    this.onPeerState(peerId, "connecting");

    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void this.session.sendSignal(peerId, { candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") this.onPeerState(peerId, "connected");
      else if (state === "failed") {
        this.onPeerState(peerId, "failed");
        // Coba pulihkan sekali dengan offer baru (ICE restart).
        void this.restartPeer(peerId);
      } else if (state === "closed" || state === "disconnected") {
        this.onPeerState(peerId, state === "closed" ? "closed" : "connecting");
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.session.sendSignal(peerId, {
        sdp: { type: offer.type ?? "offer", sdp: offer.sdp ?? "" },
      });
    } catch (error) {
      console.warn("[host] gagal membuat offer untuk", peerId, error);
      this.closePeer(peerId);
    }
  }

  private restartCount = new Map<string, number>();

  private async restartPeer(peerId: string): Promise<void> {
    const count = this.restartCount.get(peerId) ?? 0;
    if (count >= 2) {
      this.closePeer(peerId);
      return;
    }
    this.restartCount.set(peerId, count + 1);
    const pc = this.pcs.get(peerId);
    if (!pc || !this.stream) return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await this.session.sendSignal(peerId, { sdp: { type: "offer", sdp: offer.sdp ?? "" } });
    } catch {
      this.closePeer(peerId);
    }
  }

  private closePeer(peerId: string): void {
    const pc = this.pcs.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      this.pcs.delete(peerId);
      this.onPeerState(peerId, "closed");
    }
  }

  dispose(): void {
    for (const peerId of [...this.pcs.keys()]) this.closePeer(peerId);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.onLocalStream(null);
    this.sharing = false;
  }
}

// ============================ VIEWER ============================

export type ViewerStatus = "waiting-host" | "connecting" | "live" | "ended";

export class ViewerConnection {
  private pc: RTCPeerConnection | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hostPeerId: string | null = null;

  constructor(
    private readonly session: RoomSession,
    private readonly onStatus: (status: ViewerStatus) => void,
    private readonly onStream: (stream: MediaStream | null) => void,
  ) {}

  setHostPeerId(peerId: string | null): void {
    this.hostPeerId = peerId;
  }

  handleEvent(ev: SessionEventEnvelope): void {
    if (ev.type === "peer-joined") {
      const peer = ev.data.peer as PeerInfo;
      if (peer.role === "host") {
        this.hostPeerId = peer.peerId;
        // Minta offer terbaru bila host mungkin sudah berbagi.
        void this.session.sendSignal(peer.peerId, { requestOffer: true });
      }
      return;
    }
    if (ev.type === "peer-left") {
      if (String(ev.data.peerId) === this.hostPeerId || this.isHost(String(ev.data.peerId))) {
        this.teardown();
        this.onStatus("waiting-host");
      }
      return;
    }
    const sig = signalDataOf(ev);
    if (!sig) return;

    if (sig.hostState && (sig.to === "*" || sig.from === this.hostPeerId)) {
      if (!sig.hostState.sharing) {
        this.teardown();
        this.onStatus("waiting-host");
      } else if (!this.pc && sig.from) {
        // Host mulai berbagi - minta offer.
        this.hostPeerId = sig.from;
        void this.session.sendSignal(sig.from, { requestOffer: true });
      }
      return;
    }

    if (sig.from !== this.hostPeerId && !this.isHost(String(sig.from))) return;

    if (sig.sdp?.type === "offer") {
      void this.handleOffer(sig.sdp, String(sig.from));
    } else if (sig.candidate) {
      if (this.pc?.remoteDescription) {
        this.pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => undefined);
      } else {
        this.pendingCandidates.push(sig.candidate);
      }
    }
  }

  private isHost(peerId: string): boolean {
    return this.session.peers.some((p) => p.peerId === peerId && p.role === "host");
  }

  private async handleOffer(sdp: { type: string; sdp: string }, from: string): Promise<void> {
    this.hostPeerId = from;
    if (!this.pc) {
      this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.pc.ontrack = (event) => {
        this.onStream(event.streams[0] ?? new MediaStream([event.track]));
        this.onStatus("live");
      };
      this.pc.onicecandidate = (event) => {
        if (event.candidate) void this.session.sendSignal(from, { candidate: event.candidate.toJSON() });
      };
      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === "connecting" || state === "new") this.onStatus("connecting");
        else if (state === "connected") this.onStatus("live");
        else if (state === "failed" || state === "closed") {
          this.onStatus("waiting-host");
          if (state === "failed") void this.session.sendSignal(from, { requestOffer: true });
        }
      };
      this.onStatus("connecting");
    }
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp as RTCSessionDescriptionInit));
      for (const candidate of this.pendingCandidates) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
      }
      this.pendingCandidates = [];
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.session.sendSignal(from, { sdp: { type: answer.type ?? "answer", sdp: answer.sdp ?? "" } });
    } catch (error) {
      console.warn("[viewer] negosiasi gagal:", error);
    }
  }

  /** Buang koneksi lama tanpa mengubah status (mis. setelah sesi rejoin). */
  reset(): void {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    this.pendingCandidates = [];
  }

  private teardown(): void {
    this.reset();
    this.onStream(null);
  }

  dispose(): void {
    this.teardown();
    this.onStatus("ended");
  }
}

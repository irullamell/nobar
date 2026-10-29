import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { JoinResponse, PeerInfo, RoomInfo } from "../../shared/protocol";
import { formatRoomCode } from "../../shared/protocol";
import { ApiError, apiRoomInfo } from "../lib/api";
import { getClientId } from "../lib/clientid";
import { loadDisplayName, navigate, saveDisplayName } from "../lib/navigation";
import { RoomSession, type SessionEventEnvelope, type SessionFatalReason } from "../lib/session";
import { ViewerConnection, type ViewerStatus } from "../lib/webrtc";
import { Chat, type ChatMessage } from "../components/Chat";

interface ViewerRoomProps {
  code: string;
  onExit(): void;
}

interface Floater {
  id: number;
  emoji: string;
  left: number;
}

let floaterSeq = 0;

export function ViewerRoom({ code, onExit }: ViewerRoomProps) {
  const [phase, setPhase] = useState<"loading" | "form" | "in" | "fatal">("loading");
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [name, setName] = useState(loadDisplayName);
  const [password, setPassword] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>("waiting-host");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [fatal, setFatal] = useState<{ reason: SessionFatalReason; message: string } | null>(null);
  const [floaters, setFloaters] = useState<Floater[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const connRef = useRef<ViewerConnection | null>(null);
  const prevRoomRef = useRef<RoomInfo | null>(null);
  const chatSeq = useRef(0);

  const addChat = useCallback((msg: Omit<ChatMessage, "key">) => {
    chatSeq.current += 1;
    setChat((prev) => [...prev.slice(-199), { ...msg, key: `c${chatSeq.current}` }]);
  }, []);

  const addFloater = useCallback((emoji: string) => {
    floaterSeq += 1;
    const id = floaterSeq;
    const left = 10 + Math.random() * 70;
    setFloaters((prev) => [...prev, { id, emoji, left }]);
    window.setTimeout(() => setFloaters((prev) => prev.filter((f) => f.id !== id)), 2400);
  }, []);

  // Ambil info room saat pertama dibuka.
  useEffect(() => {
    let cancelled = false;
    apiRoomInfo(code)
      .then((result) => {
        if (cancelled) return;
        setRoom(result.room);
        prevRoomRef.current = result.room;
        setPhase("form");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === "BANNED") {
          setFatal({ reason: "banned", message: e.message });
        } else {
          setFatal({ reason: "closed", message: e instanceof ApiError ? e.message : "Room tidak ditemukan." });
        }
        setPhase("fatal");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function join(event: FormEvent): Promise<void> {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setJoinError("Isi nama Anda.");
      return;
    }
    setJoinError(null);
    saveDisplayName(displayName);

    const session = new RoomSession(
      { code, name: displayName, clientId: getClientId(), password: password || undefined },
      {
        onJoined(info: JoinResponse) {
          setRoom(info.room);
          prevRoomRef.current = info.room;
          setPeers(info.peers);
          setChat(info.chatHistory.map((m, i) => ({ key: `h${i}`, name: m.name, text: m.text, self: false })));
          const hostPeer = info.peers.find((p) => p.role === "host");
          connRef.current?.setHostPeerId(hostPeer?.peerId ?? null);
          if (hostPeer) {
            // Host mungkin sudah berbagi sebelum kita masuk - minta offer.
            void session.sendSignal(hostPeer.peerId, { requestOffer: true });
          }
          setPhase("in");
        },
        onEvent(ev: SessionEventEnvelope) {
          connRef.current?.handleEvent(ev);
          switch (ev.type) {
            case "chat": {
              const p = ev.data.payload as { peerId: string; name: string; text: string };
              addChat({ name: p.name, text: p.text, self: p.peerId === session.peerId });
              break;
            }
            case "reaction": {
              const p = ev.data.payload as { emoji: string };
              addFloater(p.emoji);
              break;
            }
            case "peer-joined": {
              const peer = ev.data.peer as PeerInfo;
              setPeers((prev) => (prev.some((p) => p.peerId === peer.peerId) ? prev : [...prev, peer]));
              if (peer.role === "host") connRef.current?.setHostPeerId(peer.peerId);
              break;
            }
            case "peer-left": {
              const peerId = String(ev.data.peerId);
              setPeers((prev) => prev.filter((p) => p.peerId !== peerId));
              break;
            }
            case "room-updated": {
              const updated = ev.data.room as RoomInfo;
              const prev = prevRoomRef.current;
              if (prev) {
                if (prev.passwordProtected !== updated.passwordProtected) {
                  addChat({
                    name: "",
                    text: updated.passwordProtected
                      ? "🔑 Host mengaktifkan/memperbarui password room — Anda yang sudah di dalam tidak terpengaruh"
                      : "🔓 Host menghapus password room",
                    self: false,
                    system: true,
                  });
                }
                if (prev.isPublic !== updated.isPublic) {
                  addChat({
                    name: "",
                    text: updated.isPublic
                      ? "🌐 Room kini PUBLIK — tampil di daftar room publik"
                      : "🔒 Room kini PRIVAT — hanya bisa dimasuki lewat undangan",
                    self: false,
                    system: true,
                  });
                }
              }
              prevRoomRef.current = updated;
              setRoom(updated);
              break;
            }
            case "room-closed":
              setFatal({ reason: "closed", message: "Room ditutup oleh host." });
              setPhase("fatal");
              break;
          }
        },
        onStatus: setStatus,
        onFatal(reason, message) {
          setFatal({ reason, message: message ?? "Sesi berakhir." });
          setPhase("fatal");
        },
        onRoomUpdate(updated, updatedPeers) {
          prevRoomRef.current = updated;
          setRoom(updated);
          setPeers(updatedPeers);
        },
      },
    );

    const conn = new ViewerConnection(
      session,
      (s) => setViewerStatus(s),
      (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          if (stream) void videoRef.current.play().catch(() => undefined);
        }
      },
    );

    sessionRef.current = session;
    connRef.current = conn;

    try {
      await session.start();
    } catch (e) {
      if (e instanceof ApiError) {
        setJoinError(e.message);
        if (e.code === "BANNED") {
          setFatal({ reason: "banned", message: e.message });
          setPhase("fatal");
        }
      } else {
        setJoinError("Gagal bergabung. Coba lagi.");
      }
      session.stop();
    }
  }

  // Bersihkan saat unmount / tab ditutup.
  useEffect(() => {
    const onUnload = () => sessionRef.current?.leave();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      connRef.current?.dispose();
      sessionRef.current?.leave();
    };
  }, []);

  if (phase === "fatal" && fatal) {
    const icon = fatal.reason === "banned" ? "🚫" : fatal.reason === "kicked" ? "👋" : "🔒";
    return (
      <div className="app">
        <div className="join-center">
          <div className="card join-card" style={{ textAlign: "center" }}>
            <h3>{icon} {fatal.reason === "banned" ? "Anda di-ban" : fatal.reason === "kicked" ? "Anda dikeluarkan" : "Room berakhir"}</h3>
            <p className="muted">{fatal.message}</p>
            <button className="btn btn-primary mt" onClick={() => (fatal.reason === "kicked" ? window.location.reload() : onExit())}>
              {fatal.reason === "kicked" ? "Muat Ulang" : "Kembali ke Beranda"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="app">
        <div className="join-center">
          <div className="card join-card" style={{ textAlign: "center" }}>
            <p className="muted">Memeriksa room…</p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "form") {
    return (
      <div className="app">
        <div className="join-center">
          <form className="card join-card" onSubmit={join}>
            <h3>🎟️ Gabung Room</h3>
            <p className="muted" style={{ marginBottom: 14 }}>
              <strong>{room?.name ?? "Room"}</strong> · kode <span className="mono">{formatRoomCode(code)}</span>
              {" · "}
              {room?.viewerCount ?? 0}/{room?.maxViewers ?? 12} penonton
              {room?.hostOnline ? " · host online" : " · host sedang offline"}
            </p>
            {joinError && <div className="error-box">{joinError}</div>}
            <div className="field">
              <label htmlFor="v-name">Nama Anda</label>
              <input id="v-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="mis. Sari" required />
            </div>
            {room?.passwordProtected && (
              <div className="field">
                <label htmlFor="v-pass">Password room 🔒</label>
                <input id="v-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} required autoComplete="off" />
              </div>
            )}
            <button className="btn btn-green btn-block" type="submit">Masuk Room</button>
            <button className="btn btn-ghost btn-block mt" type="button" onClick={onExit}>Batal</button>
          </form>
        </div>
      </div>
    );
  }

  const overlay =
    viewerStatus === "live" ? null : viewerStatus === "connecting" ? (
      <div className="stage-overlay">
        <div className="big">Menghubungkan…</div>
        <div>Menyambungkan media P2P dari host.</div>
      </div>
    ) : (
      <div className="stage-overlay">
        <div className="big">Menunggu host berbagi layar</div>
        <div>
          {room?.hostOnline
            ? "Host sedang online. Gambar akan muncul otomatis saat host mulai berbagi."
            : "Host sedang offline. Tetap di halaman ini — gambar muncul saat host kembali."}
        </div>
      </div>
    );

  return (
    <div className="room">
      <header className="room-header">
        <span className="room-title">{room?.name ?? "Room"}</span>
        <span className="room-code">{formatRoomCode(code)}</span>
        <span className={`badge ${status === "live" ? "live" : "warn"}`}>
          <span className="dot" />
          {status === "live" ? "Terhubung" : status === "reconnecting" ? "Menyambung ulang..." : "Menghubungkan..."}
        </span>
        <span className={`badge ${room?.hostOnline ? "live" : "bad"}`}>
          <span className="dot" />
          Host {room?.hostOnline ? "online" : "offline"}
        </span>
        {room?.passwordProtected && <span className="badge">🔒 Password</span>}
        {room?.isPublic && <span className="badge">🌐 Publik</span>}
        <div className="header-spacer" />
        <span className="muted">{peers.filter((p) => p.role === "viewer").length} penonton</span>
        <button className="btn btn-ghost btn-small" onClick={() => navigate("/")}>Keluar</button>
      </header>

      <div className="room-body">
        <div className="stage">
          <div className="video-wrap">
            <video ref={videoRef} autoPlay playsInline />
            {overlay}
            {floaters.map((f) => (
              <span key={f.id} className="floater" style={{ left: `${f.left}%` }}>{f.emoji}</span>
            ))}
          </div>
        </div>
        <aside className="sidebar">
          <div className="sidebar-section">
            <h4>Peserta ({peers.length})</h4>
            {peers.map((p) => (
              <div className="peer-row" key={p.peerId}>
                {p.role === "host" ? <span className="crown">👑</span> : <span className="conn-dot conn-connected" />}
                <div style={{ minWidth: 0 }}>
                  <div className="peer-name">{p.name}{p.peerId === sessionRef.current?.peerId ? " (Anda)" : ""}</div>
                  <div className="peer-meta">{p.role === "host" ? "Host" : "Penonton"}</div>
                </div>
              </div>
            ))}
          </div>
          <Chat
            messages={chat}
            disabled={status !== "live" && status !== "reconnecting"}
            onSend={(text) => void sessionRef.current?.sendChat(text)}
            onReaction={(emoji) => void sessionRef.current?.sendReaction(emoji)}
          />
        </aside>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JoinResponse, PeerInfo, RoomInfo } from "../../shared/protocol";
import { formatRoomCode } from "../../shared/protocol";
import { ApiError } from "../lib/api";
import { getClientId } from "../lib/clientid";
import { clearHostCredentials, navigate } from "../lib/navigation";
import { RoomSession, type SessionEventEnvelope, type SessionFatalReason } from "../lib/session";
import { HostBroadcaster, type PeerConnState } from "../lib/webrtc";
import { Chat, type ChatMessage } from "../components/Chat";

interface HostRoomProps {
  code: string;
  hostToken: string;
  hostName: string;
  onExit(): void;
}

interface Floater {
  id: number;
  emoji: string;
  left: number;
}

let floaterSeq = 0;

export function HostRoom({ code, hostToken, hostName, onExit }: HostRoomProps) {
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connStates, setConnStates] = useState<Record<string, PeerConnState>>({});
  const [fatal, setFatal] = useState<{ reason: SessionFatalReason; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [floaters, setFloaters] = useState<Floater[]>([]);

  // Panel keamanan
  const [pwModal, setPwModal] = useState(false);
  const [pwValue, setPwValue] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwNote, setPwNote] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [maxValue, setMaxValue] = useState(12);
  const [bans, setBans] = useState<{ clientId: string }[]>([]);
  const [confirmBan, setConfirmBan] = useState<PeerInfo | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const broadcasterRef = useRef<HostBroadcaster | null>(null);
  const prevRoomRef = useRef<RoomInfo | null>(null);
  const chatSeq = useRef(0);

  const inviteUrl = useMemo(() => `${window.location.origin}/r/${code}`, [code]);

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

  useEffect(() => {
    const session = new RoomSession(
      { code, name: hostName, clientId: getClientId(), hostToken },
      {
        onJoined(info: JoinResponse) {
          setRoom(info.room);
          prevRoomRef.current = info.room;
          setPeers(info.peers);
          setNameValue(info.room.name);
          setMaxValue(info.room.maxViewers);
          setChat(info.chatHistory.map((m, i) => ({ key: `h${i}`, name: m.name, text: m.text, self: false })));
        },
        onEvent(ev: SessionEventEnvelope) {
          broadcasterRef.current?.handleEvent(ev);
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
              if (peer.role === "viewer") addChat({ name: peer.name, text: "bergabung ke room", self: false, system: true });
              break;
            }
            case "peer-left": {
              const peerId = String(ev.data.peerId);
              const reason = String(ev.data.reason);
              setPeers((prev) => prev.filter((p) => p.peerId !== peerId));
              setConnStates((prev) => {
                const next = { ...prev };
                delete next[peerId];
                return next;
              });
              const label = reason === "kicked" ? "dikeluarkan (kick)" : reason === "banned" ? "di-ban" : reason === "timeout" ? "terputus" : "keluar";
              addChat({ name: peerId, text: label, self: false, system: true });
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
                      ? "🔑 Host mengaktifkan/memperbarui password room — peserta yang sudah bergabung tetap di dalam"
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
              setNameValue(updated.name);
              setMaxValue(updated.maxViewers);
              break;
            }
            case "room-closed":
              setFatal({ reason: "closed", message: "Room ditutup." });
              break;
          }
        },
        onStatus: setStatus,
        onFatal(reason, message) {
          setFatal({ reason, message: message ?? "Sesi berakhir." });
        },
        onRoomUpdate(updated, updatedPeers) {
          prevRoomRef.current = updated;
          setRoom(updated);
          setPeers(updatedPeers);
        },
      },
    );

    const broadcaster = new HostBroadcaster(
      session,
      (peerId, state) => setConnStates((prev) => ({ ...prev, [peerId]: state })),
      (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          if (stream) void videoRef.current.play().catch(() => undefined);
        }
      },
    );

    sessionRef.current = session;
    broadcasterRef.current = broadcaster;
    session.start().catch((e: unknown) => {
      setFatal({ reason: "session-lost", message: e instanceof ApiError ? e.message : "Gagal masuk room." });
    });

    const onUnload = () => session.leave();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      broadcaster.dispose();
      session.leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function toggleShare(): Promise<void> {
    const broadcaster = broadcasterRef.current;
    if (!broadcaster || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (broadcaster.sharing) await broadcaster.stopSharing();
      else await broadcaster.startSharing();
      setSharing(broadcaster.sharing);
    } catch (e) {
      if (e instanceof Error && e.name !== "NotAllowedError" && e.name !== "AbortError") {
        setError(`Gagal berbagi layar: ${e.message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      window.prompt("Salin tautan undangan:", inviteUrl);
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function hostCall(action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    const session = sessionRef.current;
    if (!session) return null;
    setError(null);
    try {
      return (await session.hostCall(action, params)) as Record<string, unknown>;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Aksi "${action}" gagal.`);
      return null;
    }
  }

  function flashNote(text: string): void {
    setPwNote(text);
    window.setTimeout(() => setPwNote((cur) => (cur === text ? null : cur)), 8000);
  }

  async function savePassword(): Promise<void> {
    const pw = pwValue.trim();
    if (pw.length < 4 || pw.length > 64) {
      setPwError("Password minimal 4 karakter, maksimal 64.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    const result = await hostCall("set-password", { password: pw });
    setPwBusy(false);
    if (result?.room) {
      setRoom(result.room as RoomInfo);
      setPwModal(false);
      setPwValue("");
      flashNote("🔑 Password diperbarui dan otomatis berlaku. Penonton yang SUDAH bergabung tidak dikeluarkan — password hanya diminta dari peserta yang masuk berikutnya.");
    } else if (result === null) {
      setPwError("Gagal menyimpan password. Coba lagi.");
    }
  }

  async function removePassword(): Promise<void> {
    setPwBusy(true);
    setPwError(null);
    const result = await hostCall("set-password", { password: null });
    setPwBusy(false);
    if (result?.room) {
      setRoom(result.room as RoomInfo);
      setPwModal(false);
      flashNote("🔓 Password dihapus. Siapa pun dengan kode/tautan undangan bisa masuk.");
    } else if (result === null) {
      setPwError("Gagal menghapus password. Coba lagi.");
    }
  }

  async function togglePublic(): Promise<void> {
    const next = !(room?.isPublic ?? false);
    const result = await hostCall("set-public", { public: next });
    if (result?.room) setRoom(result.room as RoomInfo);
  }

  async function kick(peer: PeerInfo): Promise<void> {
    const result = await hostCall("kick", { peerId: peer.peerId });
    if (result) {
      setPeers(result.peers as PeerInfo[]);
      setRoom(result.room as RoomInfo);
    }
  }

  async function ban(peer: PeerInfo): Promise<void> {
    setConfirmBan(null);
    const result = await hostCall("ban", { peerId: peer.peerId });
    if (result) {
      setPeers(result.peers as PeerInfo[]);
      setRoom(result.room as RoomInfo);
      setBans((prev) => [...prev, { clientId: "(baru)" }]);
    }
  }

  async function refreshBans(): Promise<void> {
    const result = await hostCall("list-bans");
    if (result?.bans) setBans(result.bans as { clientId: string }[]);
  }

  async function unban(clientId: string): Promise<void> {
    const result = await hostCall("unban", { clientId });
    if (result?.bans) setBans(result.bans as { clientId: string }[]);
  }

  async function closeRoom(): Promise<void> {
    setConfirmClose(false);
    await hostCall("close");
    clearHostCredentials(code);
    onExit();
  }

  function leaveAsHost(): void {
    clearHostCredentials(code);
    sessionRef.current?.leave();
    navigate("/");
  }

  const viewers = peers.filter((p) => p.role === "viewer");
  const hostPeer = peers.find((p) => p.role === "host");

  if (fatal) {
    return (
      <div className="app">
        <div className="join-center">
          <div className="card join-card" style={{ textAlign: "center" }}>
            <h3>Room berakhir</h3>
            <p className="muted">{fatal.message}</p>
            <button className="btn btn-primary mt" onClick={() => navigate("/")}>Kembali ke Beranda</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="room">
      <header className="room-header">
        <span className="room-title">👑 {room?.name ?? "Room"}</span>
        <span className="room-code" title="Kode room">{formatRoomCode(code)}</span>
        <span className={`badge ${status === "live" ? "live" : status === "reconnecting" ? "warn" : ""}`}>
          <span className="dot" />
          {status === "live" ? "Terhubung" : status === "reconnecting" ? "Menyambung ulang..." : "Menghubungkan..."}
        </span>
        {room?.passwordProtected && <span className="badge">🔒 Password</span>}
        {room?.isPublic && <span className="badge">🌐 Publik</span>}
        <div className="header-spacer" />
        <button className="btn btn-ghost btn-small" onClick={() => void copyInvite()}>
          {copied ? "✓ Tersalin" : "🔗 Salin Undangan"}
        </button>
        <button className="btn btn-ghost btn-small" onClick={leaveAsHost}>Keluar</button>
      </header>

      <div className="room-body">
        <div className="stage">
          <div className="video-wrap">
            <video ref={videoRef} autoPlay playsInline muted />
            {!sharing && (
              <div className="stage-overlay">
                <div className="big">Anda belum berbagi layar</div>
                <div>Tekan "Mulai Berbagi" lalu pilih layar/jendela/tab yang ingin dibagikan.</div>
                <button className="btn btn-primary" onClick={() => void toggleShare()} disabled={busy}>
                  🖥️ Mulai Berbagi
                </button>
              </div>
            )}
            {floaters.map((f) => (
              <span key={f.id} className="floater" style={{ left: `${f.left}%` }}>{f.emoji}</span>
            ))}
          </div>
          <div className="host-controls">
            {sharing ? (
              <button className="btn btn-danger" onClick={() => void toggleShare()} disabled={busy}>⏹ Berhenti Berbagi</button>
            ) : (
              <button className="btn btn-green" onClick={() => void toggleShare()} disabled={busy}>🖥️ Mulai Berbagi</button>
            )}
            <span className="muted">
              {viewers.length}/{room?.maxViewers ?? 12} penonton · {sharing ? "sedang berbagi" : "tidak berbagi"}
            </span>
            {error && <span className="error-box" style={{ margin: 0, padding: "6px 10px" }}>{error}</span>}
          </div>
        </div>

        <aside className="sidebar">
          <div className="sidebar-section">
            <h4>Peserta ({peers.length})</h4>
            {hostPeer && (
              <div className="peer-row">
                <span className="crown">👑</span>
                <div>
                  <div className="peer-name">{hostPeer.name} (Anda)</div>
                  <div className="peer-meta">Host</div>
                </div>
              </div>
            )}
            {viewers.length === 0 && <div className="muted">Belum ada penonton. Kirim undangan!</div>}
            {viewers.map((p) => (
              <div className="peer-row" key={p.peerId}>
                <span className={`conn-dot conn-${connStates[p.peerId] ?? "new"}`} title={connStates[p.peerId] ?? "menunggu"} />
                <div style={{ minWidth: 0 }}>
                  <div className="peer-name">{p.name}</div>
                  <div className="peer-meta">Penonton · {connStates[p.peerId] === "connected" ? "media tersambung" : "media belum tersambung"}</div>
                </div>
                <div className="peer-actions">
                  <button className="btn btn-ghost btn-small" onClick={() => void kick(p)} title="Keluarkan (masih bisa masuk lagi)">Kick</button>
                  <button className="btn btn-danger btn-small" onClick={() => setConfirmBan(p)} title="Keluarkan & larang masuk kembali">Ban</button>
                </div>
              </div>
            ))}
          </div>

          <div className="sidebar-section">
            <h4>Keamanan Room</h4>
            {pwNote && <div className="notice-box">{pwNote}</div>}
            <div className="row mt">
              <button
                className="btn btn-ghost btn-small"
                onClick={() => {
                  setPwValue("");
                  setPwError(null);
                  setPwModal(true);
                }}
              >
                🔑 {room?.passwordProtected ? "Ganti / Hapus Password" : "Set Password"}
              </button>
              {room?.passwordProtected ? <span className="badge">🔒 Aktif</span> : <span className="badge">Tanpa password</span>}
            </div>
            <div className="row mt">
              <button className="btn btn-ghost btn-small" onClick={() => void togglePublic()} disabled={busy}>
                {room?.isPublic ? "🔒 Buat Privat" : "🌐 Jadikan Publik"}
              </button>
              {room?.isPublic && <span className="badge live"><span className="dot" />Di daftar publik</span>}
            </div>
            <div className="row mt">
              <input
                style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                placeholder="Nama room"
                maxLength={40}
              />
              <button className="btn btn-ghost btn-small" onClick={() => void hostCall("rename", { name: nameValue.trim() })}>
                Ubah
              </button>
            </div>
            <div className="row mt">
              <select
                value={maxValue}
                onChange={(e) => setMaxValue(Number(e.target.value))}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
              >
                {[2, 4, 6, 8, 12, 16, 20].map((n) => <option key={n} value={n}>Maks {n} penonton</option>)}
              </select>
              <button className="btn btn-ghost btn-small" onClick={() => void hostCall("set-max-viewers", { maxViewers: maxValue })}>
                Terapkan
              </button>
            </div>
            <div className="row mt">
              <button className="btn btn-ghost btn-small" onClick={() => void refreshBans()}>🚫 Daftar Ban ({bans.length})</button>
              <div className="header-spacer" />
              <button className="btn btn-danger btn-small" onClick={() => setConfirmClose(true)}>Tutup Room</button>
            </div>
            {bans.length > 0 && (
              <div className="mt">
                {bans.map((b, i) => (
                  <div className="ban-item" key={`${b.clientId}-${i}`}>
                    <span className="mono">{b.clientId.slice(0, 16)}…</span>
                    {b.clientId !== "(baru)" && (
                      <button className="btn btn-ghost btn-small" onClick={() => void unban(b.clientId)}>Unban</button>
                    )}
                  </div>
                ))}
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Muat ulang daftar untuk melihat entri terbaru.</div>
              </div>
            )}
          </div>

          <Chat
            messages={chat}
            disabled={status !== "live" && status !== "reconnecting"}
            onSend={(text) => void sessionRef.current?.sendChat(text)}
            onReaction={(emoji) => void sessionRef.current?.sendReaction(emoji)}
          />
        </aside>
      </div>

      {confirmBan && (
        <div className="modal-backdrop" onClick={() => setConfirmBan(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Ban {confirmBan.name}?</h3>
            <p>
              Penonton ini akan dikeluarkan dan <strong>dilarang masuk kembali</strong> ke room ini
              (berdasarkan identitas browser &amp; jaringan). Anda bisa membatalkannya lewat Daftar Ban.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmBan(null)}>Batal</button>
              <button className="btn btn-danger" onClick={() => void ban(confirmBan)}>Ya, Ban</button>
            </div>
          </div>
        </div>
      )}

      {confirmClose && (
        <div className="modal-backdrop" onClick={() => setConfirmClose(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Tutup room?</h3>
            <p>Semua penonton akan dikeluarkan dan room tidak bisa dipakai lagi. Tindakan ini tidak bisa dibatalkan.</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmClose(false)}>Batal</button>
              <button className="btn btn-danger" onClick={() => void closeRoom()}>Tutup Room</button>
            </div>
          </div>
        </div>
      )}

      {pwModal && (
        <div className="modal-backdrop" onClick={() => setPwModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>🔑 Password Room</h3>
            <p>
              Status saat ini:{" "}
              {room?.passwordProtected
                ? "password AKTIF — peserta baru wajib memasukkan password."
                : "TANPA password — siapa pun yang tahu kode/tautan undangan bisa masuk."}
            </p>
            <div className="notice-box">
              Mengganti password berlaku <strong>otomatis &amp; langsung</strong> untuk semua orang,
              dan <strong>tidak mengeluarkan</strong> penonton yang sudah bergabung — password baru
              hanya diminta dari peserta yang masuk berikutnya.
            </div>
            <div className="field">
              <label htmlFor="pw-new">Password baru (4–64 karakter)</label>
              <input
                id="pw-new"
                type="password"
                value={pwValue}
                onChange={(e) => setPwValue(e.target.value)}
                placeholder="mis. nonton2026"
                maxLength={64}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            {pwError && <div className="error-box">{pwError}</div>}
            <div className="modal-actions">
              {room?.passwordProtected && (
                <button className="btn btn-ghost" onClick={() => void removePassword()} disabled={pwBusy}>
                  Hapus Password
                </button>
              )}
              <div className="header-spacer" />
              <button className="btn btn-ghost" onClick={() => setPwModal(false)} disabled={pwBusy}>
                Batal
              </button>
              <button className="btn btn-primary" onClick={() => void savePassword()} disabled={pwBusy || pwValue.trim().length < 4}>
                {pwBusy ? "Menyimpan..." : "Simpan Password"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

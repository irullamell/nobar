import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiCreateRoom, apiHealth, apiListPublicRooms, type HealthInfo } from "../lib/api";
import { getClientId } from "../lib/clientid";
import { loadDisplayName, navigate, saveDisplayName, saveHostCredentials } from "../lib/navigation";
import {
  DEFAULT_MAX_VIEWERS,
  ABS_MAX_VIEWERS,
  normalizeRoomCode,
  formatRoomCode,
  type RoomInfo,
} from "../../shared/protocol";

interface HomeProps {
  onNavigate: typeof navigate;
}

export function Home({ onNavigate }: HomeProps) {
  void onNavigate;
  const [displayName, setDisplayName] = useState(loadDisplayName);
  const [roomName, setRoomName] = useState("");
  const [password, setPassword] = useState("");
  const [maxViewers, setMaxViewers] = useState(DEFAULT_MAX_VIEWERS);
  const [isPublic, setIsPublic] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setHealth({ ok: false, storage: "missing", production: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) return setError("Isi nama Anda terlebih dahulu.");
    setError(null);
    setBusy("create");
    try {
      saveDisplayName(name);
      const result = await apiCreateRoom({
        name: roomName.trim() || `Room ${name}`,
        hostName: name,
        clientId: getClientId(),
        password: password.trim() || undefined,
        maxViewers,
        public: isPublic,
      });
      saveHostCredentials(result.code, { hostToken: result.hostToken, name });
      navigate(`/r/${result.code}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal membuat room. Coba lagi.");
    } finally {
      setBusy(null);
    }
  }

  function join(event: FormEvent): void {
    event.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (code.length !== 12) {
      setError("Kode room harus 12 karakter (contoh: ABCD-EFGH-JKMN).");
      return;
    }
    setError(null);
    saveDisplayName(displayName.trim());
    navigate(`/r/${code}`);
  }

  return (
    <div className="app">
      <main className="home">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="30" fill="#36564f" />
            <path d="M22 40c0-8 4-14 10-14s10 6 10 14" stroke="#f5c542" strokeWidth="4" fill="none" strokeLinecap="round" />
            <circle cx="32" cy="20" r="5" fill="#f5c542" />
          </svg>
          <div>
            <h1>Piik Lite</h1>
            <small>Screen sharing privat · 100% di Vercel</small>
          </div>
        </div>

        <div className="hero">
          <h2>Berbagi layar hanya dengan undangan 🎬</h2>
          <p>
            Buat room, kirim tautan undangannya, dan teman Anda menonton langsung di browser —
            tanpa instal apa pun. Room <strong>tidak bisa</strong> dimasuki orang asing: wajib kode
            undangan (dan password bila Anda aktifkan). Sebagai host, Anda bisa <strong>kick</strong> dan <strong>ban</strong> penonton.
          </p>
        </div>

        {health?.storage === "missing" && (
          <div className="error-box" style={{ marginBottom: 16 }}>
            ⚠️ <strong>Server belum dikonfigurasi.</strong> Redis tidak ditemukan, sehingga room akan
            selalu gagal (ROOM_NOT_FOUND). Tambahkan <span className="mono">UPSTASH_REDIS_REST_URL</span> dan{" "}
            <span className="mono">UPSTASH_REDIS_REST_TOKEN</span> di Vercel → <em>Settings → Environment
            Variables</em> (buat Redis gratis via Marketplace “Upstash Redis”), lalu <strong>deploy ulang</strong>.
          </div>
        )}
        {health?.storage === "memory" && (
          <div className="notice-box" style={{ marginBottom: 16 }}>
            🛠 Mode pengembangan: penyimpanan in-memory — semua room <strong>hilang saat server di-restart</strong>.
            Untuk produksi, pasang Redis (lihat README).
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="home-grid">
          <form className="card" onSubmit={create}>
            <h3>🎮 Buat Room (jadi Host)</h3>
            <div className="field">
              <label htmlFor="create-name">Nama Anda</label>
              <input id="create-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="mis. Budi" maxLength={40} required />
            </div>
            <div className="field">
              <label htmlFor="room-name">Nama room (opsional)</label>
              <input id="room-name" value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="mis. Nonton Bareng" maxLength={40} />
            </div>
            <div className="field">
              <label htmlFor="room-pass">Password room (opsional, min. 4 karakter)</label>
              <input id="room-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="kosongkan jika tidak perlu" maxLength={64} autoComplete="new-password" />
            </div>
            <div className="field">
              <label htmlFor="max-viewers">Maks penonton</label>
              <select id="max-viewers" value={maxViewers} onChange={(e) => setMaxViewers(Number(e.target.value))}>
                {[2, 4, 6, 8, 12, 16, 20].filter((n) => n <= ABS_MAX_VIEWERS).map((n) => (
                  <option key={n} value={n}>{n} penonton</option>
                ))}
              </select>
            </div>
            <label className="check-row" htmlFor="room-public">
              <input
                id="room-public"
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
              />
              <span>
                🌐 Jadikan room publik <span className="muted">(muncul di daftar room publik di bawah — siapa pun bisa melihat &amp; bergabung; default: privat/invite-only)</span>
              </span>
            </label>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy !== null}>
              {busy === "create" ? "Membuat..." : "Buat Room"}
            </button>
          </form>

          <form className="card" onSubmit={join}>
            <h3>🎟️ Gabung dengan Undangan</h3>
            <div className="field">
              <label htmlFor="join-name">Nama Anda</label>
              <input id="join-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="mis. Sari" maxLength={40} required />
            </div>
            <div className="field">
              <label htmlFor="join-code">Kode room dari undangan</label>
              <input
                id="join-code"
                value={joinCode.length > 12 ? formatRoomCode(joinCode.slice(0, 12)) : formatRoomCode(joinCode)}
                onChange={(e) => setJoinCode(normalizeRoomCode(e.target.value).slice(0, 12))}
                placeholder="ABCD-EFGH-JKMN"
                className="mono"
                required
              />
            </div>
            <p className="muted" style={{ marginTop: -2 }}>
              Anda juga bisa langsung membuka tautan undangan yang dikirim host —
              tidak ada daftar room publik, jadi hanya pemegang undangan yang bisa masuk.
            </p>
            <button className="btn btn-green btn-block" type="submit" disabled={busy !== null}>
              Gabung Room
            </button>
          </form>
        </div>

        <PublicRooms />

        <p className="footer-note">
          Media mengalir P2P (WebRTC) antar browser · Sinyal melalui Vercel Functions + Redis ·
          Kode undangan 12 karakter acak kriptografis · Host dapat kick &amp; ban penonton ·
          Room privat hanya bisa dimasuki lewat undangan.
        </p>
      </main>
    </div>
  );
}

// ===================== Daftar room publik =====================

function PublicRooms() {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiListPublicRooms();
      setRooms(result.rooms);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal memuat daftar room publik.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div className="card mt" style={{ marginTop: 18 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>🌐 Room Publik</h3>
        <div className="header-spacer" />
        <button className="btn btn-ghost btn-small" onClick={() => void load()} disabled={loading}>
          {loading ? "Memuat..." : "↻ Muat Ulang"}
        </button>
      </div>
      {error && <div className="error-box mt">{error}</div>}
      {!error && rooms && rooms.length === 0 && (
        <p className="muted mt">
          Belum ada room publik. Room secara bawaan bersifat privat — hanya muncul di sini bila host
          mengaktifkan "Jadikan room publik" (saat membuat room atau dari panel Keamanan di dalam room).
        </p>
      )}
      {rooms && rooms.length > 0 && (
        <div className="public-list mt">
          {rooms.map((room) => (
            <div className="public-room-row" key={room.code}>
              <div style={{ minWidth: 0 }}>
                <div className="peer-name">
                  {room.name}{" "}
                  {room.passwordProtected && <span title="Butuh password">🔒</span>}
                </div>
                <div className="peer-meta mono">
                  {formatRoomCode(room.code)} · {room.viewerCount}/{room.maxViewers} penonton ·{" "}
                  {room.hostOnline ? "host online" : "host offline"}
                </div>
              </div>
              <span className={`badge ${room.hostOnline ? "live" : "bad"}`}>
                <span className="dot" />
                {room.hostOnline ? "Live" : "Offline"}
              </span>
              <button className="btn btn-green btn-small" onClick={() => navigate(`/r/${room.code}`)}>
                Gabung
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Lapisan penyimpanan: Upstash Redis (produksinya di Vercel) dengan fallback
// in-memory untuk pengembangan lokal tanpa Redis.
// Hanya memakai subset perintah yang dibutuhkan logika room.

import { Redis } from "@upstash/redis";

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface Store {
  hset(key: string, fields: Record<string, string>): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<void>;
  set(key: string, value: string, exSeconds?: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<void>;
  sadd(key: string, ...members: string[]): Promise<void>;
  srem(key: string, ...members: string[]): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  xadd(key: string, fields: Record<string, string>): Promise<string>;
  /** Baca entri stream SETELAH id tertentu (eksklusif). null = dari awal. */
  xrangeAfter(key: string, afterId: string | null, count: number): Promise<StreamEntry[]>;
}

function env(name: string): string | undefined {
  return process.env[name] && process.env[name]!.length > 0 ? process.env[name] : undefined;
}

// ------------------------- Upstash (REST) -------------------------

class UpstashStore implements Store {
  constructor(private readonly redis: Redis) {}

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    await this.redis.hset(key, fields);
  }
  async hget(key: string, field: string): Promise<string | null> {
    return (await this.redis.hget<string>(key, field)) ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return (await this.redis.hgetall<Record<string, string>>(key)) ?? {};
  }
  async hdel(key: string, ...fields: string[]): Promise<void> {
    if (fields.length) await this.redis.hdel(key, ...fields);
  }
  async set(key: string, value: string, exSeconds?: number): Promise<void> {
    if (exSeconds) await this.redis.set(key, value, { ex: exSeconds });
    else await this.redis.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return (await this.redis.get<string>(key)) ?? null;
  }
  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys);
  }
  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length) await this.redis.sadd(key, members[0], ...members.slice(1));
  }
  async srem(key: string, ...members: string[]): Promise<void> {
    if (members.length) await this.redis.srem(key, ...members);
  }
  async smembers(key: string): Promise<string[]> {
    return await this.redis.smembers(key);
  }
  async sismember(key: string, member: string): Promise<boolean> {
    return (await this.redis.sismember(key, member)) === 1;
  }
  async incr(key: string): Promise<number> {
    return await this.redis.incr(key);
  }
  async expire(key: string, seconds: number): Promise<void> {
    await this.redis.expire(key, seconds);
  }
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    // @upstash/redis >= 1.34: xadd(key, id, entries, opts) dengan trim bawaan
    // agar stream room yang aktif tidak membengkak.
    const id = await this.redis.xadd(key, "*", fields, {
      trim: { type: "MAXLEN", threshold: 2000, comparison: "~" },
    });
    return String(id);
  }
  async xrangeAfter(key: string, afterId: string | null, count: number): Promise<StreamEntry[]> {
    const start = afterId ? `(${afterId}` : "-";
    const raw = await this.redis.xrange<Record<string, unknown>>(key, start, "+", count);
    const out: StreamEntry[] = [];
    for (const [id, fieldsRaw] of Object.entries(raw ?? {})) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fieldsRaw ?? {})) fields[k] = String(v);
      out.push({ id, fields });
    }
    out.sort((a, b) => compareStreamIds(a.id, b.id));
    return out;
  }
}

// ------------------------- In-memory (dev) -------------------------

interface MemEntry {
  value: unknown;
  expiresAt: number | null; // ms epoch
}

function compareStreamIds(a: string, b: string): number {
  const [am, as] = a.split("-").map((x) => parseInt(x, 10));
  const [bm, bs] = b.split("-").map((x) => parseInt(x, 10));
  if (am !== bm) return am - bm;
  return (as || 0) - (bs || 0);
}

class MemoryStore implements Store {
  private data = new Map<string, MemEntry>();
  private streams = new Map<string, StreamEntry[]>();
  private streamSeq = new Map<string, number>();

  private live(key: string): MemEntry | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }
  private put(key: string, value: unknown, exSeconds?: number): void {
    this.data.set(key, { value, expiresAt: exSeconds ? Date.now() + exSeconds * 1000 : null });
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    const entry = this.live(key);
    const hash = (entry?.value as Record<string, string> | undefined) ?? {};
    Object.assign(hash, fields);
    this.put(key, hash, entry?.expiresAt ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : undefined);
  }
  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.live(key)?.value as Record<string, string> | undefined;
    return hash?.[field] ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return (this.live(key)?.value as Record<string, string> | undefined) ?? {};
  }
  async hdel(key: string, ...fields: string[]): Promise<void> {
    const hash = this.live(key)?.value as Record<string, string> | undefined;
    if (!hash) return;
    for (const f of fields) delete hash[f];
  }
  async set(key: string, value: string, exSeconds?: number): Promise<void> {
    this.put(key, value, exSeconds);
  }
  async get(key: string): Promise<string | null> {
    return (this.live(key)?.value as string | undefined) ?? null;
  }
  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.data.delete(k);
      this.streams.delete(k);
    }
  }
  private setOf(key: string): Set<string> {
    const entry = this.live(key);
    if (entry) return entry.value as Set<string>;
    const s = new Set<string>();
    this.put(key, s);
    return s;
  }
  async sadd(key: string, ...members: string[]): Promise<void> {
    const s = this.setOf(key);
    for (const m of members) s.add(m);
  }
  async srem(key: string, ...members: string[]): Promise<void> {
    const s = this.setOf(key);
    for (const m of members) s.delete(m);
  }
  async smembers(key: string): Promise<string[]> {
    const entry = this.live(key);
    return entry ? Array.from(entry.value as Set<string>) : [];
  }
  async sismember(key: string, member: string): Promise<boolean> {
    const entry = this.live(key);
    return entry ? (entry.value as Set<string>).has(member) : false;
  }
  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = ((entry?.value as number | undefined) ?? 0) + 1;
    this.data.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
    return next;
  }
  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.live(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
    const stream = this.streams.get(key);
    if (stream) this.streamExpiry.set(key, Date.now() + seconds * 1000);
  }
  private streamExpiry = new Map<string, number>();
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const exp = this.streamExpiry.get(key);
    if (exp && exp < Date.now()) {
      this.streams.delete(key);
      this.streamExpiry.delete(key);
    }
    const list = this.streams.get(key) ?? [];
    const ms = Date.now();
    const seq = (this.streamSeq.get(key) ?? 0) + 1;
    this.streamSeq.set(key, seq);
    const id = `${ms}-${seq}`;
    list.push({ id, fields: { ...fields } });
    if (list.length > 2000) list.splice(0, list.length - 2000);
    this.streams.set(key, list);
    return id;
  }
  async xrangeAfter(key: string, afterId: string | null, count: number): Promise<StreamEntry[]> {
    const list = this.streams.get(key) ?? [];
    const startIdx = afterId
      ? list.findIndex((e) => compareStreamIds(e.id, afterId) > 0)
      : 0;
    if (startIdx === -1) return [];
    return list.slice(startIdx, startIdx + count);
  }
}

// ------------------------- Singleton -------------------------

let store: Store | null = null;

export function getStore(): Store {
  if (store) return store;
  const url = env("UPSTASH_REDIS_REST_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN");
  if (url && token) {
    store = new UpstashStore(new Redis({ url, token }));
    console.log("[store] memakai Upstash Redis");
  } else {
    store = new MemoryStore();
    console.warn("[store] UPSTASH_REDIS_REST_URL/TOKEN tidak ada - memakai penyimpanan in-memory (khusus dev, data hilang saat restart)");
  }
  return store;
}

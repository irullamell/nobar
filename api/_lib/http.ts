// Helper HTTP kecil untuk serverless functions (node req/res style).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StorageNotConfiguredError } from "./store.js";

export interface JsonResult {
  status: number;
  body: unknown;
}

/**
 * Bungkus hasil logika: ubah StorageNotConfiguredError menjadi 503 yang jelas
 * sehingga deploy tanpa Redis tidak terlihat seperti "room misterius hilang".
 */
export async function result(promise: Promise<JsonResult>): Promise<JsonResult> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) {
      return err(503, "STORAGE_NOT_CONFIGURED", e.message);
    }
    throw e;
  }
}

export function ok(body: unknown): JsonResult {
  return { status: 200, body };
}

export function err(status: number, code: string, message?: string): JsonResult {
  return { status, body: { error: code, message: message ?? code } };
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 32 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, result: JsonResult): void {
  const payload = JSON.stringify(result.body);
  res.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Perbandingan aman timing untuk string rahasia. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function str(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

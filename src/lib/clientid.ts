// clientId stabil per browser (localStorage) - dipakai untuk enforcement ban.
const KEY = "piik.clientId";

export function getClientId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
    /* mode privat; buat fallback di memori */
  }
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* abaikan */
  }
  return id;
}

// Router mini berbasis history API (tanpa dependensi).
import { useEffect, useState } from "react";

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export type Route = { view: "home" } | { view: "room"; code: string };

export function parseRoute(): Route {
  const m = window.location.pathname.match(/^\/r\/([A-Za-z0-9-]+)/);
  if (m) {
    const code = m[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
    return { view: "room", code };
  }
  return { view: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const update = () => setRoute(parseRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}

// ----- penyimpanan kredensial host (sessionStorage, per tab) -----

export interface HostCredentials {
  hostToken: string;
  name: string;
}

const hostKey = (code: string) => `piik.host.${code}`;

export function saveHostCredentials(code: string, creds: HostCredentials): void {
  try {
    sessionStorage.setItem(hostKey(code), JSON.stringify(creds));
  } catch {
    /* abaikan */
  }
}

export function loadHostCredentials(code: string): HostCredentials | null {
  try {
    const raw = sessionStorage.getItem(hostKey(code));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HostCredentials;
    return parsed.hostToken ? parsed : null;
  } catch {
    return null;
  }
}

export function clearHostCredentials(code: string): void {
  try {
    sessionStorage.removeItem(hostKey(code));
  } catch {
    /* abaikan */
  }
}

// ----- nama tampilan yang diingat -----

const NAME_KEY = "piik.displayName";

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* abaikan */
  }
}

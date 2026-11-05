import { readHostBootstrap } from "@areal/client";

export type BrowserHostAuthStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "authenticated" }
  | { state: "pairing"; requestId: string; fingerprint: string; expiresAt: number }
  | { state: "error"; reason: "expired" | "unavailable" };

type DeviceKey = { version: 1; privateKey: CryptoKey; publicKey: CryptoKey };
let status: BrowserHostAuthStatus = { state: "idle" };
const listeners = new Set<() => void>();
let resume: (() => void) | undefined;
let running: Promise<unknown> | undefined;

export const getBrowserHostAuthStatus = () => status;
export function subscribeBrowserHostAuth(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function resumeBrowserHostAuth() {
  resume?.();
}
function publish(next: BrowserHostAuthStatus) {
  status = next;
  for (const listener of listeners) listener();
}

function validKey(value: unknown): value is DeviceKey {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DeviceKey>;
  return (
    entry.version === 1 &&
    entry.privateKey instanceof CryptoKey &&
    entry.publicKey instanceof CryptoKey &&
    entry.privateKey.type === "private" &&
    !entry.privateKey.extractable &&
    entry.privateKey.algorithm.name === "ECDSA" &&
    (entry.privateKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
    entry.privateKey.usages.length === 1 &&
    entry.privateKey.usages[0] === "sign" &&
    entry.publicKey.type === "public" &&
    entry.publicKey.extractable &&
    entry.publicKey.algorithm.name === "ECDSA" &&
    (entry.publicKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256"
  );
}

async function deviceKey(): Promise<DeviceKey> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("areal-browser-device", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser key storage unavailable"));
    request.onblocked = () => reject(new Error("Browser key storage unavailable"));
  });
  try {
    const read = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("keys", "readonly");
      const request = transaction.objectStore("keys").get("device");
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("Browser key storage unavailable"));
    });
    if (read !== undefined) {
      if (!validKey(read)) throw new Error("Invalid browser device key");
      return read;
    }
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const generated: DeviceKey = { version: 1, ...keys };
    return await new Promise<DeviceKey>((resolve, reject) => {
      const transaction = database.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const request = store.get("device");
      let result = generated;
      request.onsuccess = () => {
        if (request.result === undefined) store.add(generated, "device");
        else if (validKey(request.result)) result = request.result;
        else transaction.abort();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("Browser key storage unavailable"));
    });
  } finally {
    database.close();
  }
}

function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function post(
  path: "/host/auth/challenge" | "/host/auth/ticket",
  body: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Browser authentication unavailable");
  return response.json();
}
function waitForApproval(expiresAt: number) {
  return new Promise<void>((resolve) => {
    const expiry = setTimeout(
      () => publish({ state: "error", reason: "expired" }),
      Math.max(0, expiresAt - Date.now()),
    );
    resume = () => {
      clearTimeout(expiry);
      resume = undefined;
      resolve();
    };
  });
}

async function bootstrap() {
  publish({ state: "connecting" });
  try {
    const origin = window.location.origin;
    const location = new URL(origin);
    if (
      location.protocol !== "http:" ||
      location.hostname !== "127.0.0.1" ||
      !location.port ||
      !window.isSecureContext
    ) {
      throw new Error("Browser authentication requires the Host origin");
    }
    const keys = await deviceKey();
    const publicKey = base64url(await crypto.subtle.exportKey("raw", keys.publicKey));
    for (;;) {
      publish({ state: "connecting" });
      const challenge = await post("/host/auth/challenge", { publicKey });
      if (
        !record(challenge) ||
        !Number.isSafeInteger(challenge.expiresAt) ||
        (challenge.expiresAt as number) <= Date.now()
      ) {
        throw new Error("Invalid browser authentication response");
      }
      if (challenge.state === "pending") {
        if (
          typeof challenge.requestId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            challenge.requestId,
          ) ||
          typeof challenge.fingerprint !== "string" ||
          !/^[0-9a-f]{64}$/.test(challenge.fingerprint) ||
          (challenge.expiresAt as number) > Date.now() + 120_000
        )
          throw new Error("Invalid browser pairing response");
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await crypto.subtle.exportKey("raw", keys.publicKey),
        );
        const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        if (fingerprint !== challenge.fingerprint)
          throw new Error("Browser device fingerprint mismatch");
        publish({
          state: "pairing",
          requestId: challenge.requestId,
          fingerprint: challenge.fingerprint,
          expiresAt: challenge.expiresAt as number,
        });
        await waitForApproval(challenge.expiresAt as number);
        continue;
      }
      if (
        challenge.state !== "challenge" ||
        typeof challenge.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) ||
        typeof challenge.hostId !== "string" ||
        !challenge.hostId ||
        challenge.hostId.length > 256 ||
        (challenge.expiresAt as number) > Date.now() + 30_000
      )
        throw new Error("Invalid browser challenge");
      const message = new TextEncoder().encode(
        `${challenge.hostId}\n${challenge.nonce}\n${origin}`,
      );
      const signature = base64url(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, message),
      );
      const result = readHostBootstrap(
        await post("/host/auth/ticket", { publicKey, nonce: challenge.nonce, signature }),
      );
      if (result.hostId !== challenge.hostId || result.origin !== origin)
        throw new Error("Host identity changed");
      publish({ state: "authenticated" });
      return result;
    }
  } catch {
    publish({ state: "error", reason: "unavailable" });
    throw new Error("Browser authentication unavailable");
  }
}

export function getBrowserHostBootstrap(): Promise<unknown> {
  if (!running)
    running = bootstrap().finally(() => {
      running = undefined;
    });
  return running;
}

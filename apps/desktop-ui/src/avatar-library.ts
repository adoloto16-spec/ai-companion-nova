import {
  DEFAULT_AVATAR_SETTINGS,
  classifyAvatarFileName,
  normalizeAvatarSettings,
  type AvatarFormat,
  type AvatarProfile,
  type AvatarSettings
} from "../../../modules/character/src/index";

const DB_NAME = "nova-avatar-library";
const DB_VERSION = 1;
const MAX_MODEL_BYTES = 300 * 1024 * 1024;

interface StoredAsset { id: string; name: string; blob: Blob; }
const STORE_PROFILES = "profiles";
const STORE_ASSETS = "assets";
const STORE_META = "meta";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Persistent avatar storage is unavailable in this WebView."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROFILES)) db.createObjectStore(STORE_PROFILES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local avatar storage."));
    request.onblocked = () => reject(new Error("Avatar storage upgrade is blocked by another Nova window."));
  });
}
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Avatar storage operation failed."));
  });
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Avatar storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Avatar storage transaction failed."));
  });
}
function id(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  return prefix + ":" + random;
}
function clone(profile: AvatarProfile): AvatarProfile {
  return { ...profile, settings: normalizeAvatarSettings(profile.settings) };
}

export async function listAvatarProfiles(): Promise<AvatarProfile[]> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_PROFILES, "readonly");
    const finished = done(tx);
    const profiles = await req<AvatarProfile[]>(tx.objectStore(STORE_PROFILES).getAll());
    await finished;
    return profiles.map(clone).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } finally { db.close(); }
}
export async function getActiveAvatarProfileId(): Promise<string | null> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_META, "readonly");
    const finished = done(tx);
    const value = await req<unknown>(tx.objectStore(STORE_META).get("activeProfileId"));
    await finished;
    return typeof value === "string" ? value : null;
  } finally { db.close(); }
}
export async function getAvatarAsset(assetId: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_ASSETS, "readonly");
    const finished = done(tx);
    const item = await req<StoredAsset | undefined>(tx.objectStore(STORE_ASSETS).get(assetId));
    await finished;
    return item?.blob;
  } finally { db.close(); }
}
export async function getActiveAvatarBundle(): Promise<{ profile: AvatarProfile; asset: Blob } | undefined> {
  const profiles = await listAvatarProfiles();
  if (!profiles.length) return undefined;
  const requested = await getActiveAvatarProfileId();
  const profile = profiles.find(item => item.id === requested) ?? profiles[0];
  if (!profile) return undefined;
  const asset = await getAvatarAsset(profile.assetId);
  return asset ? { profile, asset } : undefined;
}
export async function setActiveAvatarProfile(profileId: string): Promise<void> {
  if (!(await listAvatarProfiles()).some(profile => profile.id === profileId)) throw new Error("Avatar profile no longer exists.");
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_META, "readwrite");
    const finished = done(tx);
    tx.objectStore(STORE_META).put(profileId, "activeProfileId");
    await finished;
  } finally { db.close(); }
}
export async function addAvatarModel(file: File): Promise<AvatarProfile> {
  if (!file.size) throw new Error("The selected model file is empty.");
  if (file.size > MAX_MODEL_BYTES) throw new Error("Avatar model files must be 300 MiB or smaller.");
  const format: AvatarFormat = classifyAvatarFileName(file.name);
  const now = new Date().toISOString();
  const assetId = id("avatar-asset");
  const profile: AvatarProfile = {
    id: id("avatar-profile"),
    name: file.name.replace(/\.(vrm|glb)$/i, "").slice(0, 120) || "New avatar",
    format, assetId, settings: { ...DEFAULT_AVATAR_SETTINGS }, createdAt: now, updatedAt: now
  };
  const db = await openDatabase();
  try {
    const tx = db.transaction([STORE_PROFILES, STORE_ASSETS, STORE_META], "readwrite");
    const finished = done(tx);
    tx.objectStore(STORE_PROFILES).put(profile);
    tx.objectStore(STORE_ASSETS).put({ id: assetId, name: file.name, blob: file } satisfies StoredAsset);
    tx.objectStore(STORE_META).put(profile.id, "activeProfileId");
    await finished;
  } finally { db.close(); }
  return clone(profile);
}
export async function saveAvatarProfile(profile: AvatarProfile, settings: AvatarSettings = profile.settings, name = profile.name): Promise<AvatarProfile> {
  const safeName = name.trim().slice(0, 120);
  if (!safeName) throw new Error("Avatar name cannot be empty.");
  const updated = { ...profile, name: safeName, settings: normalizeAvatarSettings(settings), updatedAt: new Date().toISOString() };
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_PROFILES, "readwrite");
    const finished = done(tx);
    tx.objectStore(STORE_PROFILES).put(updated);
    await finished;
  } finally { db.close(); }
  return clone(updated);
}
export async function deleteAvatarProfile(profileId: string): Promise<void> {
  const profile = (await listAvatarProfiles()).find(item => item.id === profileId);
  if (!profile) return;
  const active = await getActiveAvatarProfileId();
  const db = await openDatabase();
  try {
    const tx = db.transaction([STORE_PROFILES, STORE_ASSETS, STORE_META], "readwrite");
    const finished = done(tx);
    tx.objectStore(STORE_PROFILES).delete(profileId);
    tx.objectStore(STORE_ASSETS).delete(profile.assetId);
    if (active === profileId) tx.objectStore(STORE_META).delete("activeProfileId");
    await finished;
  } finally { db.close(); }
}

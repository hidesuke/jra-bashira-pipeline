export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: Uint8Array, right: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(left, right);
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key.trim());
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY は 32 バイト（base64）である必要があります");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return `${bytesToBase64(iv)}.${bytesToBase64(cipher)}`;
}

export async function decryptJson<T>(key: CryptoKey, packed: string): Promise<T> {
  const [ivPart, dataPart] = packed.split(".");
  if (!ivPart || !dataPart) throw new Error("暗号化トークンの形式が不正です");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(dataPart),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

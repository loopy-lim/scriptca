/** Buffer helpers for the live demo panels. */

export function randomBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    // getRandomValues rejects views over 65536 bytes — fill in quota-sized chunks.
    const QUOTA = 65536;
    for (let off = 0; off < size; off += QUOTA) {
      crypto.getRandomValues(data.subarray(off, Math.min(size, off + QUOTA)));
    }
  } else {
    for (let i = 0; i < size; i++) data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

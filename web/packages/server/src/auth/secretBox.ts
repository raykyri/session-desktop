// AES-256-GCM under `SESSION_SECRET_KEY` (`01` S3), for values the server
// must read back but must not store readable: an open invite code, kept so
// its creator can copy the link again (04 §3.1, decision S3).
//
// The stored form is `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
// `context` is bound as additional data, so a value cannot be moved to
// another row or another kind of secret and still decrypt.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** The plaintext, or null for a value this key and context did not seal
 * (another key, a rotated key, a tampered value). */
export function open(key: Buffer, sealed: string, context: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

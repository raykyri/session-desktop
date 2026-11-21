// Authenticated encryption for secrets the server stores
// (`15-implementation-plan/03-agents-and-research.md` K4, `01` S3; ADR-23):
// AES-256-GCM under `SESSION_SECRET_KEY`, a fresh 96-bit nonce per seal.
//
// Every sealed value is bound to a context string (for an API key, its
// owner and provider) through the associated data, so a sealed value copied
// to another row does not open there. The sealed form is
// `v1.<base64url(nonce ‖ ciphertext ‖ tag)>`; the version names the key
// format so a later key rotation can tell old values apart.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  /** Encrypts `plaintext` bound to `context`. */
  seal(plaintext: string, context: string): string;
  /** Decrypts a value `seal` made with the same key and `context`. Throws
   * when the value was altered, made under another key or another
   * context. */
  open(sealed: string, context: string): string;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) {
    throw new SecretBoxError("the secret key must be 32 bytes");
  }
  return {
    seal(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const sealed = Buffer.concat([nonce, body, cipher.getAuthTag()]);
      return `${VERSION}.${sealed.toString("base64url")}`;
    },
    open(sealed, context) {
      const [version, encoded, extra] = sealed.split(".");
      if (version !== VERSION || encoded === undefined || extra !== undefined) {
        throw new SecretBoxError("not a sealed value");
      }
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.length < NONCE_BYTES + TAG_BYTES) {
        throw new SecretBoxError("not a sealed value");
      }
      const nonce = bytes.subarray(0, NONCE_BYTES);
      const tag = bytes.subarray(bytes.length - TAG_BYTES);
      const body = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretBoxError("the sealed value does not open with this key and context");
      }
    },
  };
}

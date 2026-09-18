// SHA-256 for `shared`, which must run unchanged in the server process and in
// the browser.
//
// Implemented using standard WebCrypto (`globalThis.crypto.subtle`) to support both browser and server runtime environments without Node-specific imports. The cost is that
// digesting is asynchronous; every caller in `shared` is therefore async too.

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += HEX[byte >> 4];
    hex += HEX[byte & 0x0f];
  }
  return hex;
}

/** Lowercase hex SHA-256 of `text` encoded as UTF-8. */
export async function sha256Hex(text: string): Promise<string> {
  // Read through `globalThis`: a bare `crypto?.subtle` throws a ReferenceError
  // rather than yielding `undefined` where the global is absent.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto is unavailable: sha256Hex requires globalThis.crypto.subtle");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

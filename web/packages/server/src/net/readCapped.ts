// Reads an upstream response body up to a specified byte limit.
//
// Standard methods like `response.text()` and `response.arrayBuffer()` buffer
// the entire response into memory before size validation. This reader checks
// the `content-length` header and streams the response up to `maxBytes`,
// cancelling the body stream if the limit is exceeded.

/** Error thrown when a response body exceeds the maximum byte limit. */
export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`the response is larger than ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export interface ReadCappedOptions {
  /** `reject` (the default) throws `ResponseTooLargeError` when the body
   * exceeds `maxBytes`; `truncate` retains the first `maxBytes` bytes. A declared
   * `content-length` exceeding `maxBytes` is rejected immediately prior to reading. */
  overflow?: "reject" | "truncate";
}

export interface CappedBody {
  bytes: Uint8Array;
  /** True when `overflow: "truncate"` truncated the body at `maxBytes`. */
  truncated: boolean;
}

/** Reads at most `maxBytes` of `response`'s body and cancels remaining bytes. */
export async function readCapped(
  response: Response,
  maxBytes: number,
  options: ReadCappedOptions = {},
): Promise<CappedBody> {
  const overflow = options.overflow ?? "reject";
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  const body = response.body;
  if (!body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as {
        done: boolean;
        value?: Uint8Array | undefined;
      };
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        if (overflow === "reject") {
          throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** `readCapped` decoded as UTF-8. */
export async function readCappedText(
  response: Response,
  maxBytes: number,
  options: ReadCappedOptions = {},
): Promise<string> {
  const { bytes } = await readCapped(response, maxBytes, options);
  return new TextDecoder().decode(bytes);
}

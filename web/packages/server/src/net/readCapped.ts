// Reading an upstream response body under a byte cap.
//
// `response.text()` and `response.arrayBuffer()` buffer the whole body before
// the caller can look at its size, so a cap checked afterwards bounds nothing:
// an upstream that sends 40 MB has had 40 MB read into memory by then. This
// reader stops at the cap and cancels the rest of the body. A
// `content-length` header is a claim; a body without one is unbounded until
// it is read, so both are checked.

/** The body is larger than the cap. */
export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`the response is larger than ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export interface ReadCappedOptions {
  /** `reject` (the default) throws `ResponseTooLargeError` once the body
   * passes the cap; `truncate` keeps the first `maxBytes` bytes. A declared
   * `content-length` over the cap is refused either way, before the body is
   * read. */
  overflow?: "reject" | "truncate";
}

export interface CappedBody {
  bytes: Uint8Array;
  /** True when `overflow: "truncate"` cut the body short. */
  truncated: boolean;
}

/** Reads at most `maxBytes` of `response`'s body, then cancels the rest. */
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

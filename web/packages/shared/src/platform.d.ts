// The platform globals `shared` is allowed to use.
//
// `shared` compiles with `lib: ["ES2022"]` and `types: []` so neither the DOM
// nor `@types/node` is in scope: a module that reaches for `document`,
// `window`, `process`, or `Buffer` fails to type-check. The few globals below
// are standardized in both runtimes and are declared here explicitly, so this
// file is the complete list of what `shared` assumes about its host.

interface SessionSubtleCrypto {
  digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
}

interface SessionCrypto {
  readonly subtle: SessionSubtleCrypto;
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

// `var` rather than `const`: only a `var` declaration in a global script also
// adds the name to `typeof globalThis`, and `util/sha256.ts` must read it as
// `globalThis.crypto` — a bare `crypto?.subtle` throws a ReferenceError, rather
// than yielding `undefined`, where the binding itself is absent.
// eslint-disable-next-line no-var -- `let`/`const` do not reach `globalThis`.
declare var crypto: SessionCrypto | undefined;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

interface URLSearchParams {
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): void;
  toString(): string;
  forEach(callback: (value: string, key: string) => void): void;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare const URLSearchParams: {
  new (init?: string | Record<string, string> | [string, string][]): URLSearchParams;
};

interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
}

declare const URL: {
  new (url: string, base?: string | URL): URL;
  parse(url: string, base?: string | URL): URL | null;
  canParse(url: string, base?: string | URL): boolean;
};

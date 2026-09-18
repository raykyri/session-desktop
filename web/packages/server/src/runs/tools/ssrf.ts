// The guard in front of `web_fetch` (`04-agent-runtime.md` §6).
//
// `web_fetch` takes a URL chosen by a language model, so it is a
// server-side request forgery primitive unless something stops it reaching
// the machine's own loopback interface, the Fly private network, or a cloud
// metadata endpoint. The rule is "public unicast addresses only", applied to
// every hop: the name is resolved, every address it resolves to is checked,
// and a redirect is re-checked before it is followed.
//
// A name that resolves differently between the check and the connection can
// still slip through (the classic DNS rebinding race). Closing that needs
// connecting by address with the hostname carried in SNI and `Host`, which
// `fetch` does not expose; the remaining exposure is one request whose
// response the model reads, with no credentials attached, which is the trade
// this tool is worth.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** `dns.lookup` with every address, which is what has to be checked: a name
 * with one public and one loopback record is a bypass if only the first is
 * examined. */
export const systemLookup: Lookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function inV4Range(octets: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < 4 && remaining > 0; index += 1) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((octets[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) {
      return false;
    }
    remaining -= take;
  }
  return true;
}

/** Everything IANA does not route on the public internet, plus the ranges
 * cloud providers put their metadata services on. */
const PRIVATE_V4: readonly [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, including 169.254.169.254
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, including 255.255.255.255
];

function expandV6(address: string): number[] | null {
  const zone = address.indexOf("%");
  const bare = zone === -1 ? address : address.slice(0, zone);
  const [head = "", tail] = bare.split("::");
  const parseGroups = (value: string): string[] => (value === "" ? [] : value.split(":"));
  const headGroups = parseGroups(head);
  const tailGroups = tail === undefined ? [] : parseGroups(tail);
  const groups = [...headGroups, ...tailGroups];
  // An embedded IPv4 tail (`::ffff:127.0.0.1`) counts as two groups.
  const last = groups.at(-1);
  let v4: number[] | null = null;
  if (last !== undefined && last.includes(".")) {
    v4 = ipv4Octets(last);
    if (!v4) {
      return null;
    }
    groups.pop();
    if (tail === undefined) {
      headGroups.pop();
    } else {
      tailGroups.pop();
    }
  }
  const explicit = groups.length + (v4 ? 2 : 0);
  if (tail === undefined && explicit !== 8) {
    return null;
  }
  const words: number[] = [];
  for (const group of headGroups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return null;
    }
    words.push(value);
  }
  const fill = 8 - explicit;
  if (tail !== undefined) {
    for (let index = 0; index < fill; index += 1) {
      words.push(0);
    }
  }
  for (const group of tailGroups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return null;
    }
    words.push(value);
  }
  if (v4) {
    words.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
  }
  return words.length === 8 ? words : null;
}

/** Whether `address` is anything other than a public unicast address. An
 * address this cannot parse is private: refusing an unparsable address is a
 * missed fetch, allowing one is the bug this module exists to prevent. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = ipv4Octets(address);
    return octets === null || PRIVATE_V4.some(([prefix, bits]) => inV4Range(octets, prefix, bits));
  }
  if (version !== 6) {
    return true;
  }
  const words = expandV6(address);
  if (!words) {
    return true;
  }
  const [first = 0, second = 0] = words;
  if (words.every((word) => word === 0)) {
    return true; // ::
  }
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) {
    return true; // ::1
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded v4.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    const embedded = [
      (words[6] ?? 0) >> 8,
      (words[6] ?? 0) & 0xff,
      (words[7] ?? 0) >> 8,
      (words[7] ?? 0) & 0xff,
    ];
    return PRIVATE_V4.some(([prefix, bits]) => inV4Range(embedded, prefix, bits));
  }
  if ((first & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }
  if ((first & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((first & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if (first === 0x2001 && second === 0x0db8) {
    return true; // documentation
  }
  if (first === 0x0064 && second === 0xff9b) {
    return true; // NAT64
  }
  return false;
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export interface UrlGuardOptions {
  lookup?: Lookup;
  /** Hosts allowed through unresolved, for the tests' loopback fixture
   * server. Never set in production. */
  allowHosts?: readonly string[];
}

/**
 * Validates one URL before it is requested. Throws {@link BlockedUrlError}
 * with copy the model can act on, since the refusal reaches it as a tool
 * result.
 */
export async function assertFetchableUrl(raw: string, options: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`${raw} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`${url.protocol.replace(":", "")} URLs cannot be fetched`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new BlockedUrlError("URLs with embedded credentials cannot be fetched");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (options.allowHosts?.includes(url.host) === true) {
    return url;
  }
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedUrlError(`${url.hostname} is not a public address`);
    }
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await (options.lookup ?? systemLookup)(hostname);
  } catch {
    throw new BlockedUrlError(`${url.hostname} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`${url.hostname} could not be resolved`);
  }
  for (const record of addresses) {
    if (isPrivateAddress(record.address)) {
      throw new BlockedUrlError(`${url.hostname} resolves to a private address`);
    }
  }
  return url;
}

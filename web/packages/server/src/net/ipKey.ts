// The address a per-IP limit counts (plan `04` Z1): the full address for
// IPv4 and the /64 prefix for IPv6, so one host cannot rotate through the
// addresses of its own prefix. An IPv4-mapped IPv6 address counts as its
// IPv4 address.

import { isIPv4, isIPv6 } from "node:net";

/** The eight 16-bit groups of an IPv6 address, or null. */
function hextets(address: string): number[] | null {
  let text = address;
  // A trailing dotted IPv4 part (`::ffff:1.2.3.4`) is two groups.
  const lastColon = text.lastIndexOf(":");
  const trailing = text.slice(lastColon + 1);
  if (isIPv4(trailing)) {
    const [a = 0, b = 0, c = 0, d = 0] = trailing.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const groups =
    halves.length === 2
      ? [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest]
      : [...head, ...rest];
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return null;
  return groups;
}

/** The limit key of a client address. Anything that is not an IP address
 * ("unknown" behind no proxy) is its own key. */
export function ipLimitKey(raw: string): string {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  value = value.replace(/%.*$/u, "");
  if (isIPv4(value)) return value;
  if (!isIPv6(value)) return value;
  const groups = hextets(value.toLowerCase());
  if (groups === null) return value;
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff ? groups : null;
  if (mapped) {
    const [high = 0, low = 0] = mapped.slice(6);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

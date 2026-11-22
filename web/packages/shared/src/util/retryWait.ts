// How long until a rate limit lets a request through again, in words, for
// "Try again in <time>." (`04` Z1): the server's limit messages and the
// client's sign-in errors, which read the wait from `Retry-After`.

/** `seconds` in words, rounded up: minutes below two hours ("1 minute",
 * "12 minutes"), hours above ("3 hours"). */
export function retryWaitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 120) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}

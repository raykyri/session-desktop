// Coarse "x ago" label for a session's last-modified time, shown as gray
// subordinate text under each session title.
export function formatRelativeTime(modifiedMs: number, now = Date.now()): string {
  const diffMs = now - modifiedMs;
  if (diffMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} wk ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} yr ago`;
}

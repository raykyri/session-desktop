// Relative-time labels for activity rows and toasts, ported from the desktop
// `transcriptSessions.ts` and `UserNotificationStack.tsx`. Client-only because
// they are presentation, not domain logic.

/** Feed and metadata age: "just now", "5 min ago", "3 hr ago", "2 days ago". */
export function formatRelativeTime(atMs: number, now = Date.now()): string {
  const diffMs = now - atMs;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 30) return `${Math.floor(days / 7)} wk ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  const years = Math.floor(days / 365);
  return `${years} yr ago`;
}

/** Compact age for overlay toasts: "now", "5s", "3m", "2h", "1d". */
export function formatShortRelativeTime(createdAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

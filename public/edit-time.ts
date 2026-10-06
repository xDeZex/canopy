// The clock is supplied by the caller so labels can be refreshed without a new server event.
export function formatEditTime(timestamp: unknown, now = Date.now()) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'No edit time';
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Formats an ISO commit date (as returned by GET /api/commits) as a short
// relative string ("3 hours ago") for the commit dropdown. Done client-side,
// independent of the server response's shape, so the label keeps reading
// correctly as time passes rather than baking a live-relative string into a
// cacheable response. `now` is injectable for deterministic tests.
const UNITS = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
];

export function formatRelativeTime(isoDate, now = new Date()) {
  const seconds = Math.round((now.getTime() - new Date(isoDate).getTime()) / 1000);

  if (seconds < 45) return 'just now'; // covers "just now" and future/skewed timestamps alike

  for (const [unit, unitSeconds] of UNITS) {
    const value = Math.floor(seconds / unitSeconds);
    if (value >= 1) return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
  }

  return 'just now';
}

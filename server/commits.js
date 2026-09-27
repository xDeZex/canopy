// Parses `git log`'s output (formatted with LOG_FORMAT below) into
// structured commits: sha, message (subject line), and an ISO commit date.
// Relative time ("3 hours ago") is a presentation concern and is derived
// client-side from the ISO date instead, since baking a live-relative
// string into a JSON response would go stale the moment it's cached.
//
// Field separator: ASCII unit separator (0x1f), which can't appear in a
// commit subject, so no escaping is needed. Git inserts a newline between
// commits automatically, with no trailing newline after the last one.

export const LOG_FORMAT = '%H%x1f%s%x1f%cI';

export function parseCommitLog(output) {
  const trimmed = output.replace(/\r?\n$/, '');
  if (!trimmed) return [];

  return trimmed.split('\n').map((line) => {
    const [sha, message, date] = line.split('\x1f');
    return { sha, message, date };
  });
}

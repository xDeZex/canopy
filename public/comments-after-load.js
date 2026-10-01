// The comments an incoming load should leave on display. A malformed or
// partial external write arrives as a warning with no threads; it must not
// erase the last valid conversation, and the next valid payload clears it.
export function commentsAfterLoad(previous, incoming) {
  if (!incoming?.warning) return incoming;
  return { ...incoming, threads: previous?.threads ?? [] };
}

// Pure mapping from a keydown to a Canopy action. Shortcuts are plain keys,
// so they only fire when nothing is being typed into and no modifier is held
// (leaving the browser's and Monaco's own Ctrl/Alt/Meta shortcuts alone).

// Monaco's hidden input is a textarea; it is read-only here, so it does not
// count as typing, while its find widget's input does.
export function isTypingTarget(target) {
  const tag = target?.tagName;
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return !target.readOnly;
  return Boolean(target?.isContentEditable);
}

// Key to action type, so a binding is one named entry rather than a branch.
const KEY_ACTIONS = {
  j: 'prev-change',
  l: 'next-change',
  s: 'prev-file',
  f: 'next-file',
  w: 'newer-commit',
  r: 'older-commit',
  c: 'add-comment',
  e: 'scroll-up',
  d: 'scroll-down',
  '?': 'toggle-help',
  Escape: 'close',
};

export function shortcutAction({ key, ctrlKey, metaKey, altKey, target }) {
  if (ctrlKey || metaKey || altKey || isTypingTarget(target)) return null;
  if (Object.hasOwn(KEY_ACTIONS, key)) return { type: KEY_ACTIONS[key] };
  if (/^[1-9]$/.test(key)) return { type: 'select-worktree', index: Number(key) - 1 };
  return null;
}

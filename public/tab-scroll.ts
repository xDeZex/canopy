// Pure computation of which scroll-edge fade affordances the worktree tab
// bar should show, given its current scroll geometry (#14: plain
// `overflow-x: auto` gives no visual hint that there's more to scroll to).
// Kept separate from the DOM `scroll`/`resize` listener wiring in main.js
// (thin glue, left to manual verification) so the edge-case math — rounding
// right at the very start/end of a scrollable container — has its own fast
// unit test.
export function computeTabScrollAffordance({ scrollLeft, scrollWidth, clientWidth }: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
  const isScrollable = scrollWidth > clientWidth + 1;
  if (!isScrollable) return { showLeft: false, showRight: false };

  const atStart = scrollLeft <= 1;
  const atEnd = scrollLeft + clientWidth >= scrollWidth - 1;

  return { showLeft: !atStart, showRight: !atEnd };
}

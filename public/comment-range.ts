// Pure mapping from a Monaco selection on the modified side to the inclusive,
// 1-based line range of a new thread. Returns null when no valid anchor exists.
export function rangeFromSelection(selection: unknown, lineCount: number) {
  if (typeof selection !== 'object' || selection === null) return null;
  const startLineNumber = 'startLineNumber' in selection ? selection.startLineNumber : undefined;
  const endLineNumber = 'endLineNumber' in selection ? selection.endLineNumber : undefined;
  const startColumn = 'startColumn' in selection ? selection.startColumn : undefined;
  const endColumn = 'endColumn' in selection ? selection.endColumn : undefined;
  if (typeof startLineNumber !== 'number' || typeof endLineNumber !== 'number'
    || ![startLineNumber, endLineNumber].every(Number.isSafeInteger)) return null;
  const first = Math.min(startLineNumber, endLineNumber);
  const last = Math.max(startLineNumber, endLineNumber);
  if (first < 1 || last > lineCount) return null;
  // A selection that ends at column 1 of a later line stops after the line before.
  const reversed = startLineNumber > endLineNumber;
  const lastColumn = reversed ? startColumn : endColumn;
  const endLine = last > first && lastColumn === 1 ? last - 1 : last;
  return { line: first, endLine };
}

// Where a new composer goes: the selected range when no line was clicked or
// the clicked line is inside it, else just the clicked line. Null when there
// is nothing to anchor to.
export function composerTarget(selection: unknown, lineCount: number, clickedLine: number | null = null) {
  const range = rangeFromSelection(selection, lineCount);
  if (clickedLine === null) return range;
  if (range && clickedLine >= range.line && clickedLine <= range.endLine) return range;
  return { line: clickedLine, endLine: clickedLine };
}

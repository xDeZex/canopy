// Flatten the file leaves in tree order, regardless of folder expansion state.
export function collectFiles(nodes) {
  const files = [];
  for (const node of nodes) {
    if (node.type === 'file') files.push(node);
    else files.push(...collectFiles(node.children));
  }
  return files;
}

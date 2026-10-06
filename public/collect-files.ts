// Flatten the file leaves in tree order, regardless of folder expansion state.
export interface FileLeaf { type: 'file'; path: string; status?: string; name?: string; oldPath?: string }
export interface DirectoryNode { type: 'dir'; path: string; name?: string; children: FileNode[] }
export type FileNode = FileLeaf | DirectoryNode;

export function collectFiles(nodes: readonly FileNode[]): FileLeaf[] {
  const files: FileLeaf[] = [];
  for (const node of nodes) {
    if (node.type === 'file') files.push(node);
    else files.push(...collectFiles(node.children));
  }
  return files;
}

// Only the spawn option consumed by these loading operations is modelled.
export interface GitOptions { maxBuffer?: number }
export type Git = (args: string[], cwd: string, options?: GitOptions) => Promise<string>;

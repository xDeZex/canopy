// Read stdout at the Git IO edge. Callers here do not need spawn options.
export type Git = (args: string[], cwd: string) => Promise<string>;

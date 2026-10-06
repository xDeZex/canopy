import type { Git } from '../../server/git-port.js';

export interface GitCall { args: string[]; cwd: string }
type Reply = string | Error;
type GitReplies = Readonly<Record<string, Reply>> | ((args: string[], cwd: string) => Reply | Promise<Reply>);

// An IO recorder, not a Git emulator. Unspecified commands fail closed so
// tests cannot silently mistake missing fake behavior for empty Git output.
export function fakeGit(replies: GitReplies) {
  const calls: GitCall[] = [];
  const runGit: Git = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const command = args.find((arg) => !arg.startsWith('--literal'));
    const reply = typeof replies === 'function' ? await replies(args, cwd)
      : command === undefined ? undefined : replies[command];
    if (reply === undefined) throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { runGit, calls };
}

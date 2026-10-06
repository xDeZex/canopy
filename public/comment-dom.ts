// The renderer uses native element operations, not a whole Document. The
// recursive port also lets tests retain their own inspectable element type.
export interface CommentNode<E> {
  className: string;
  textContent: string | null;
  type?: string;
  rows?: number;
  value?: string;
  disabled?: boolean;
  readOnly?: boolean;
  setAttribute(name: string, value: string): void;
  replaceChildren(...children: E[]): void;
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown): void;
  focus?(): void;
}

export interface CommentDocument<E> {
  createElement(tag: string): E;
  activeElement?: unknown;
}

export interface FocusElement {
  isConnected?: boolean;
  focus?(): void;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: 'forward' | 'backward' | 'none' | null;
  setSelectionRange?(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
}

export interface ReplyState { blocked: boolean; warning?: string | null }
export interface CommentMessage { id: string; author: string; text: string; created_at?: string }
interface Conversation {
  id: string;
  created_at?: string;
  resolved?: boolean;
  unavailable?: string | null;
  messages: CommentMessage[];
}
export type CommentThread = Conversation & (
  { file: string; line_range: { start: number; end: number }; side?: string }
  | { file?: never; line_range?: never; side?: never }
);
export interface Comments { threads: CommentThread[]; warning?: string | null }

export function hasFileAnchor(thread: CommentThread): thread is CommentThread & { file: string; line_range: { start: number; end: number } } {
  // Threads have already passed the comments loader's validation. Presence,
  // not truthiness, distinguishes a file anchor from a general conversation.
  return Object.hasOwn(thread, 'file');
}

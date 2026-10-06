import type { CommentDocument, CommentNode, CommentThread, FocusElement } from './comment-dom.js';

// Native elements and the simulated DOM share only the operations the owners use.
export interface ViewerNode<E> extends CommentNode<E>, FocusElement {
  contains(node: E): boolean;
  classList: { add(name: string): void; toggle(name: string, force?: boolean): void };
  getBoundingClientRect(): { top: number; height: number };
  addEventListener(name: string, listener: (event: { preventDefault(): void; stopPropagation?(): void }) => unknown): void;
}
export interface ViewerDocument<E> extends CommentDocument<E> { activeElement?: E | null; body?: E }
export interface Draft { line: number; endLine?: number; text: string; error?: string | null }
export interface CommentInput { line: number; endLine?: number; text: string }
export interface Composer {
  draft: Draft | null;
  onChange(next: Draft | null): void;
  save(input: CommentInput): Promise<unknown>;
}
export interface ViewerController {
  dispose(): void;
  updateThreads?(threads: CommentThread[]): void;
  revealThread?(id: string): unknown;
  nextChange?(): void;
  prevChange?(): void;
  addComment?(): void;
  scrollUp?(): void;
  scrollDown?(): void;
}
export interface Observer<E> { observe(node: E): void; disconnect(): void }
export type ObserverFactory<E> = new (callback: () => void) => Observer<E>;
export interface EditorOptions<E> {
  content?: string | null; language?: string; wrap?: boolean;
  document: ViewerDocument<E>; ResizeObserver?: ObserverFactory<E>;
  threads?: CommentThread[]; composer?: Composer | null;
  conversation?: (thread: CommentThread) => E & { updateThread?(thread: CommentThread): void };
}
export interface DiffOptions<E> extends Omit<EditorOptions<E>, 'content'> {
  original?: string | null; modified?: string | null; mode?: string; autoScroll?: boolean;
}

export function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
}

import type { CommentDocument, CommentNode } from './comment-dom.js';

// Controls create HTML elements, but queries/parents may return any Element.
// HTML-only properties stay optional rather than promising them on native Element.
export interface WorkspaceElement<E> extends CommentNode<E> {
  title?: string;
  hidden?: boolean;
  style?: { paddingLeft: string };
  offsetWidth?: number;
  scrollLeft?: number;
  scrollWidth?: number;
  clientWidth?: number;
  parentElement: E | null;
  children: ArrayLike<E> | Iterable<E>;
  isConnected: boolean;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
    toggle(name: string, force?: boolean): unknown;
  };
  append(...children: E[]): void;
  getAttribute(name: string): string | null;
  querySelector(selector: string): E | null;
  querySelectorAll(selector: string): ArrayLike<E> | Iterable<E>;
  addEventListener(name: string, listener: (event: { preventDefault(): void; target?: unknown }) => unknown, options?: { once?: boolean }): void;
}

export interface OutsideClick { composedPath(): unknown[] }
export interface WorkspaceDocument<E> extends CommentDocument<E> {
  addEventListener(name: 'click', listener: (event: OutsideClick) => void): void;
  removeEventListener(name: 'click', listener: (event: OutsideClick) => void): void;
}
export interface WorkspaceWindow { addEventListener(name: 'resize', listener: () => void): void }

// A missing queried control is a broken renderer invariant, not a nullable
// browser capability disguised by a non-null assertion.
export function requiredElement<E extends WorkspaceElement<E>>(root: E, selector: string): E {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing workspace control: ${selector}`);
  return element;
}

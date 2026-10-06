// Only the DOM surface used by the client's controls, so tests need no browser.
export interface FakeEvent {
  key?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean;
  button?: number; pointerId?: number; clientX?: number; defaultPrevented?: boolean;
  preventDefault(): void;
}
type Listener = (event: FakeEvent) => unknown;

export class Element {
  tag: string;
  children: Element[];
  className: string;
  dataset: Record<string, string>;
  style: Record<string, string> & { width: string };
  listeners: Map<string, Listener>;
  events: Record<string, (event?: FakeEvent) => unknown> = {};
  textContent = '';
  type = '';
  value = '';
  rows = 0;
  disabled = false;
  readOnly = false;
  parentElement: Element | null = null;
  isRoot = false;
  ownerDocument?: FakeDocument;
  focused = false;
  clientWidth = 0;
  offsetWidth = 0;
  declare role?: string;
  declare 'aria-label'?: string;
  declare 'aria-expanded'?: string;
  declare 'aria-valuenow'?: string;
  declare 'aria-valuemin'?: string;
  declare 'aria-valuemax'?: string;

  constructor(tag: string) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = { width: '' };
    this.listeners = new Map();
  }

  get classList(): { contains(name: string): boolean; add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): void } {
    const tokens = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (name) => tokens().includes(name),
      add: (name) => { this.className = [...new Set([...tokens(), name])].join(' '); },
      remove: (name) => { this.className = tokens().filter((token) => token !== name).join(' '); },
      toggle: (name, force) => {
        if (force ?? !tokens().includes(name)) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }

  append(...children: Element[]) {
    for (const child of children) {
      if (child.tag === 'fragment') this.append(...child.children);
      else {
        child.parentElement = this;
        this.children.push(child);
      }
    }
  }

  replaceChildren(...children: Element[]) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    this.append(...children);
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  get isConnected(): boolean {
    return this.isRoot || Boolean(this.parentElement?.isConnected);
  }

  querySelectorAll(selector: string): Element[] {
    const name = selector.slice(1);
    return this.children.flatMap((child) => [
      ...(child.classList.contains(name) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(event: string, listener: Listener) {
    this.listeners.set(event, listener);
    this.events[event] = (fields = { preventDefault() {} }) => listener(fields);
  }
  removeEventListener(event: string, listener: Listener) {
    if (this.listeners.get(event) === listener) {
      this.listeners.delete(event);
      delete this.events[event];
    }
  }
  click() { return this.events.click?.(); }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setAttribute(name: string, value: string) {
    Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
  }
}

export class FakeDocument {
  activeElement: Element | null = null;
  body = new Element('body');
  constructor() { this.body.isRoot = true; this.body.ownerDocument = this; }
  createElement(tag: string) {
    const node = new Element(tag);
    node.ownerDocument = this;
    return node;
  }
}

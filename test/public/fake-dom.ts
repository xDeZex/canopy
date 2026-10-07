// Only the DOM surface used by the client's controls, so tests need no browser.
export interface FakeEvent {
  key?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean;
  button?: number; pointerId?: number; clientX?: number; defaultPrevented?: boolean;
  preventDefault(): void;
  target?: unknown;
  stopPropagation?(): void;
}
type Listener = (event: FakeEvent) => unknown;

export class Element {
  tag: string;
  children: Element[];
  className: string;
  dataset: Record<string, string>;
  style: Record<string, string> & { width: string; paddingLeft: string };
  listeners: Map<string, Listener>;
  events: Record<string, (event?: Partial<FakeEvent>) => unknown> = {};
  textContent = '';
  type = '';
  value = '';
  rows = 0;
  disabled = false;
  readOnly = false;
  hidden = false;
  title = '';
  scrollLeft = 0;
  scrollWidth = 0;
  parentElement: Element | null = null;
  isRoot = false;
  ownerDocument?: FakeDocument;
  focused = false;
  focusCalls = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection: 'forward' | 'backward' | 'none' | null = null;
  getBoundingClientRect = () => ({ top: 0, height: 0 });
  get tagName() { return this.tag; }
  get parentNode() { return this.parentElement; }
  clientWidth = 0;
  offsetWidth = 0;
  declare role?: string;
  declare tabindex?: string;
  declare 'aria-label'?: string;
  declare 'aria-pressed'?: string;
  declare 'aria-selected'?: string;
  declare 'aria-expanded'?: string;
  declare 'aria-valuenow'?: string;
  declare 'aria-valuemin'?: string;
  declare 'aria-valuemax'?: string;

  constructor(tag: string) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = { width: '', paddingLeft: '' };
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
        child.remove();
        child.parentElement = this;
        this.children.push(child);
      }
    }
  }

  replaceChildren(...children: Element[]) {
    [...this.children].forEach((child) => child.remove());
    this.children = [];
    this.append(...children);
  }

  appendChild(child: Element) { this.append(child); return child; }
  remove() {
    if (this.isConnected && this.contains(this.ownerDocument?.activeElement) && this.ownerDocument) this.ownerDocument.activeElement = this.ownerDocument.body;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  setSelectionRange(start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none') {
    this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
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

  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  require(selector: string): Element {
    const element = this.querySelector(selector);
    if (!element) throw new Error(`Missing fake control: ${selector}`);
    return element;
  }
  addEventListener(event: string, listener: Listener, options?: { once?: boolean }) {
    this.listeners.set(event, listener);
    this.events[event] = (fields = {}) => {
      if (options?.once) this.removeEventListener(event, listener);
      return listener({ preventDefault() {}, stopPropagation() {}, target: this, ...fields });
    };
  }
  removeEventListener(event: string, listener: Listener) {
    if (this.listeners.get(event) === listener) {
      this.listeners.delete(event);
      delete this.events[event];
    }
  }
  click() { return this.events.click?.(); }
  focus() {
    this.focusCalls++; this.focused = true;
    if (this.ownerDocument && (!this.ownerDocument.requireConnectedFocus || this.isConnected)) this.ownerDocument.activeElement = this;
  }
  setAttribute(name: string, value: string) {
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
  }
  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] ?? null;
    const value: unknown = Object.getOwnPropertyDescriptor(this, name)?.value;
    return typeof value === 'string' ? value : null;
  }
}

export class FakeDocument {
  activeElement: Element | null = null;
  body = new Element('body');
  // Older control tests inspect focus requests in detached trees. Lifecycle
  // tests opt into connected-only focus to simulate native reparenting/blur.
  constructor(private rect = { top: 0, height: 0 }, public requireConnectedFocus = false) { this.body.isRoot = true; this.body.ownerDocument = this; }
  createElement(tag: string) {
    const node = new Element(tag);
    node.ownerDocument = this;
    node.getBoundingClientRect = () => ({ ...this.rect });
    return node;
  }
}

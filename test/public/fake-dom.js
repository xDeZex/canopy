// Only the DOM surface used by the client's controls, so tests need no browser.
export class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
  }

  get classList() {
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

  append(...children) {
    for (const child of children) {
      if (child.tag === 'fragment') this.append(...child.children);
      else {
        child.parentElement = this;
        this.children.push(child);
      }
    }
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    this.append(...children);
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  get isConnected() {
    return this.isRoot || Boolean(this.parentElement?.isConnected);
  }

  querySelectorAll(selector) {
    const name = selector.slice(1);
    return this.children.flatMap((child) => [
      ...(child.classList.contains(name) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  removeEventListener(event, listener) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
  }
  click() { this.listeners.get('click')?.(); }
  setAttribute(name, value) { this[name] = value; }
}

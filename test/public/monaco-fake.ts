import assert from 'node:assert/strict';
import type { LoaderWindow, ViewZone, TextModel } from '../../public/monaco-port.js';
import { Element } from './fake-dom.js';

// The AMD loader is browser IO. Install its narrow fake without claiming it is
// a Window; the real owners continue to read the same global CDN boundary.
export function setLoaderWindow(window: LoaderWindow) {
  Object.defineProperty(globalThis, 'window', { value: window, writable: true, configurable: true });
}
export type FakeZone = ViewZone & { domNode: Element };
export function fakeZone(zone: ViewZone): asserts zone is FakeZone {
  assert.ok(zone.domNode instanceof Element, 'the mounting IO must receive this fixture\'s elements');
}
export function present<T>(value: T | null | undefined): T { assert.ok(value != null); return value; }

// A guarded consumed model, not a complete ITextModel. Missing capabilities
// fail when exercised instead of claiming that disposal alone is a text model.
export function fakeModel(port: Partial<TextModel>): TextModel {
  const missing = () => { throw new Error('Unconfigured fake text-model capability'); };
  return {
    getLineCount: port.getLineCount?.bind(port) ?? missing,
    getLineMaxColumn: port.getLineMaxColumn?.bind(port) ?? missing,
    dispose: port.dispose?.bind(port) ?? missing,
  };
}

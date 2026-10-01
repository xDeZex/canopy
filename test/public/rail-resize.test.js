import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeRailWidth, createRailResizer } from '../../public/rail-resize.js';
import { Element } from './fake-dom.js';

test('rail widths default to 220px and leave room for the viewer, even in narrow layouts', () => {
  assert.deepEqual(computeRailWidth(undefined, 1000), { width: 220, min: 160, max: 560 });
  assert.deepEqual(computeRailWidth(90, 1000), { width: 160, min: 160, max: 560 });
  assert.deepEqual(computeRailWidth(900, 700), { width: 380, min: 160, max: 380 });
  assert.deepEqual(computeRailWidth(220, 240), { width: 120, min: 120, max: 120 });
  assert.deepEqual(computeRailWidth(220, 0), { width: 0, min: 0, max: 0 });
  assert.deepEqual(computeRailWidth(NaN, 1000), { width: 220, min: 160, max: 560 });
});

class ResizeElement extends Element {
  focus() { this.focused = true; }
  setPointerCapture(id) { this.capturedPointer = id; }
  hasPointerCapture(id) { return this.capturedPointer === id; }
  releasePointerCapture(id) {
    if (this.hasPointerCapture(id)) this.capturedPointer = null;
  }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  emit(type, fields = {}) {
    const event = { preventDefault() { this.defaultPrevented = true; }, ...fields };
    this.listeners.get(type)?.(event);
    return event;
  }
}

function setup(storage) {
  const bodyEl = new ResizeElement('div');
  const railEl = new ResizeElement('nav');
  const dividerEl = new ResizeElement('div');
  const window = new ResizeElement('window');
  bodyEl.clientWidth = 1006;
  dividerEl.offsetWidth = 6;
  const resizer = createRailResizer({ bodyEl, railEl, dividerEl, window, storage });
  return { bodyEl, railEl, dividerEl, window, resizer };
}

test('the separator exposes current width and arrow keys resize within its accessible limits', () => {
  const { railEl, dividerEl } = setup();
  assert.equal(railEl.style.width, '220px');
  assert.equal(dividerEl['aria-valuenow'], '220');
  assert.equal(dividerEl['aria-valuemin'], '160');
  assert.equal(dividerEl['aria-valuemax'], '560');
  assert.equal(dividerEl.emit('keydown', { key: 'ArrowRight' }).defaultPrevented, true);
  assert.equal(railEl.style.width, '230px');
  dividerEl.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(railEl.style.width, '220px');
  for (let i = 0; i < 10; i++) dividerEl.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(railEl.style.width, '160px');
  assert.equal(dividerEl['aria-valuenow'], '160');
  assert.equal(dividerEl.emit('keydown', { key: 'Tab' }).defaultPrevented, undefined);
  assert.equal(dividerEl.emit('keydown', { key: 'ArrowRight', ctrlKey: true }).defaultPrevented, undefined);
  assert.equal(railEl.style.width, '160px');
});

test('dragging the divider captures only the initiating left pointer and ends on pointerup', () => {
  const { bodyEl, railEl, dividerEl, window } = setup();
  dividerEl.emit('pointerdown', { button: 2, pointerId: 1, clientX: 222 });
  window.emit('pointermove', { pointerId: 1, clientX: 400 });
  assert.equal(railEl.style.width, '220px');
  const start = dividerEl.emit('pointerdown', { button: 0, pointerId: 2, clientX: 222 });
  assert.equal(start.defaultPrevented, true);
  assert.equal(dividerEl.focused, true);
  assert.equal(dividerEl.capturedPointer, 2);
  assert.equal(bodyEl.classList.contains('is-resizing'), true);
  dividerEl.emit('pointerdown', { button: 0, pointerId: 3, clientX: 300 });
  window.emit('pointermove', { pointerId: 3, clientX: 400 });
  window.emit('pointerup', { pointerId: 3 });
  assert.equal(railEl.style.width, '220px');
  window.emit('pointermove', { pointerId: 2, clientX: 302 });
  assert.equal(railEl.style.width, '300px');
  assert.equal(dividerEl['aria-valuenow'], '300');
  window.emit('pointermove', { pointerId: 2, clientX: 2000 });
  assert.equal(railEl.style.width, '560px');
  window.emit('pointermove', { pointerId: 2, clientX: 302 });
  window.emit('pointerup', { pointerId: 2 });
  assert.equal(dividerEl.capturedPointer, null);
  assert.equal(bodyEl.classList.contains('is-resizing'), false);
  window.emit('pointermove', { pointerId: 2, clientX: 100 });
  assert.equal(railEl.style.width, '300px');
});

test('cancel, lost capture, window blur, and disposal stop drags and clean up their listeners', () => {
  for (const ending of ['pointercancel', 'lostpointercapture', 'blur', 'dispose']) {
    const { bodyEl, railEl, dividerEl, window, resizer } = setup();
    dividerEl.emit('pointerdown', { button: 0, pointerId: 7, clientX: 220 });
    window.emit('pointermove', { pointerId: 7, clientX: 260 });
    window.emit('pointercancel', { pointerId: 8 });
    dividerEl.emit('lostpointercapture', { pointerId: 8 });
    assert.equal(bodyEl.classList.contains('is-resizing'), true);
    if (ending === 'dispose') resizer.dispose();
    else if (ending === 'lostpointercapture') dividerEl.emit(ending, { pointerId: 7 });
    else window.emit(ending, { pointerId: 7 });
    assert.equal(bodyEl.classList.contains('is-resizing'), false, ending);
    assert.equal(dividerEl.capturedPointer, null, ending);
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'blur']) {
      assert.equal(window.listeners.has(type), false, `${ending}: ${type}`);
    }
    window.emit('pointermove', { pointerId: 7, clientX: 500 });
    assert.equal(railEl.style.width, '260px', ending);
    resizer.dispose();
    assert.equal(dividerEl.listeners.size, 0);
    dividerEl.emit('keydown', { key: 'ArrowRight' });
    dividerEl.emit('pointerdown', { button: 0, pointerId: 9, clientX: 260 });
    assert.equal(railEl.style.width, '260px');
    assert.equal(bodyEl.classList.contains('is-resizing'), false);
  }
});

test('saved width survives reload and temporary viewport clamping without writes during dragging', () => {
  const values = new Map([['canopy:rail-width', '400']]);
  const writes = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push([key, value]); },
  };
  const { bodyEl, railEl, dividerEl, window, resizer } = setup(storage);
  assert.equal(railEl.style.width, '400px');
  bodyEl.clientWidth = 306;
  window.emit('resize');
  assert.equal(railEl.style.width, '150px');
  assert.equal(dividerEl['aria-valuemin'], '150');
  assert.equal(dividerEl['aria-valuemax'], '150');
  bodyEl.clientWidth = 1006;
  window.emit('resize');
  assert.equal(railEl.style.width, '400px');
  assert.deepEqual(writes, []);
  dividerEl.emit('pointerdown', { button: 0, pointerId: 2, clientX: 400 });
  window.emit('pointermove', { pointerId: 2, clientX: 450 });
  assert.deepEqual(writes, []);
  window.emit('pointerup', { pointerId: 2 });
  assert.deepEqual(writes, [['canopy:rail-width', '450']]);
  dividerEl.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(setup(storage).railEl.style.width, '440px');
  resizer.dispose();
  assert.equal(window.listeners.size, 0);
  bodyEl.clientWidth = 306;
  window.emit('resize');
  assert.equal(railEl.style.width, '440px');
});

test('window drag listeners still work when pointer capture is unavailable', () => {
  const { bodyEl, railEl, dividerEl, window } = setup();
  dividerEl.setPointerCapture = () => { throw new Error('pointer no longer active'); };
  dividerEl.emit('pointerdown', { button: 0, pointerId: 5, clientX: 220 });
  window.emit('pointermove', { pointerId: 5, clientX: 320 });
  assert.equal(railEl.style.width, '320px');
  window.emit('pointerup', { pointerId: 5 });
  assert.equal(bodyEl.classList.contains('is-resizing'), false);
});

test('invalid saved widths and blocked storage do not prevent resizing', () => {
  for (const saved of [null, '', 'garbage', 'Infinity', '-12', '0']) {
    assert.equal(setup({ getItem: () => saved }).railEl.style.width, '220px');
  }
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  const { railEl, dividerEl } = setup(blocked);
  dividerEl.emit('keydown', { key: 'ArrowRight' });
  assert.equal(railEl.style.width, '230px');
  const failedWrite = setup({ getItem: () => '300', setItem: blocked.setItem });
  failedWrite.dividerEl.emit('keydown', { key: 'ArrowRight' });
  failedWrite.dividerEl.emit('keydown', { key: 'ArrowRight' });
  assert.equal(failedWrite.railEl.style.width, '320px');
});

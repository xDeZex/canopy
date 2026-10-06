// Reserve 320px for the viewer when possible, or half the available space
// on small screens. The rail's normal minimum yields to that reservation.
import type { PreferenceStorage } from './preference-storage.js';

export function computeRailWidth(requestedWidth: number | undefined, availableWidth: number) {
  const available = Math.max(0, availableWidth);
  const max = Math.max(0, Math.floor(Math.min(560, available - Math.min(320, available / 2))));
  const min = Math.min(160, max);
  const requested = typeof requestedWidth === 'number' && Number.isFinite(requestedWidth) ? requestedWidth : 220;
  return { width: Math.round(Math.max(min, Math.min(max, requested))), min, max };
}

const STORAGE_KEY = 'canopy:rail-width';

export interface ResizeEvent {
  key?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean;
  button?: number; pointerId?: number; clientX?: number;
  preventDefault(): void;
}
export type ResizeListener = (event: ResizeEvent) => void;
export interface ResizeEvents {
  addEventListener(type: string, listener: ResizeListener): void;
  removeEventListener(type: string, listener: ResizeListener): void;
}
export interface RailResizerOptions {
  bodyEl: { clientWidth: number; classList: { add(name: string): void; remove(name: string): void } };
  railEl: { style: { width: string } };
  dividerEl: ResizeEvents & {
    offsetWidth: number; setAttribute(name: string, value: string): void; focus(): void;
    setPointerCapture(id: number): void; hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void;
  };
  window: ResizeEvents;
  storage?: PreferenceStorage | null;
}

export function createRailResizer({ bodyEl, railEl, dividerEl, window, storage }: RailResizerOptions) {
  let preferredWidth = 220;
  try {
    const saved = Number(storage?.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) preferredWidth = saved;
  } catch {
    // Blocked storage leaves the width as an in-memory preference.
    storage = null;
  }
  let width = 220;
  let drag: { pointerId: number; clientX: number; width: number } | null = null;

  function saveWidth() {
    try {
      storage?.setItem?.(STORAGE_KEY, String(preferredWidth));
    } catch {
      storage = null;
    }
  }

  function applyWidth() {
    const limits = computeRailWidth(preferredWidth, bodyEl.clientWidth - dividerEl.offsetWidth);
    width = limits.width;
    railEl.style.width = `${width}px`;
    dividerEl.setAttribute('aria-valuemin', String(limits.min));
    dividerEl.setAttribute('aria-valuemax', String(limits.max));
    dividerEl.setAttribute('aria-valuenow', String(width));
    dividerEl.setAttribute('aria-valuetext', `${width} pixels`);
  }

  function onKeyDown(event: ResizeEvent) {
    if (drag) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    preferredWidth = width + (event.key === 'ArrowRight' ? 10 : -10);
    applyWidth();
    preferredWidth = width;
    saveWidth();
  }

  function onPointerMove(event: ResizeEvent) {
    if (!drag || event.pointerId !== drag.pointerId || typeof event.clientX !== 'number') return;
    event.preventDefault();
    preferredWidth = drag.width + event.clientX - drag.clientX;
    applyWidth();
    preferredWidth = width;
  }

  function endDrag(event?: ResizeEvent) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const { pointerId } = drag;
    drag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    window.removeEventListener('blur', onBlur);
    dividerEl.removeEventListener('lostpointercapture', endDrag);
    bodyEl.classList.remove('is-resizing');
    if (dividerEl.hasPointerCapture(pointerId)) dividerEl.releasePointerCapture(pointerId);
    saveWidth();
  }

  function onBlur() {
    endDrag();
  }

  function onPointerDown(event: ResizeEvent) {
    if (event.button !== 0 || drag || typeof event.pointerId !== 'number' || typeof event.clientX !== 'number') return;
    event.preventDefault();
    dividerEl.focus();
    drag = { pointerId: event.pointerId, clientX: event.clientX, width };
    try {
      dividerEl.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still finish the drag if capture cannot be acquired.
    }
    bodyEl.classList.add('is-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', onBlur);
    dividerEl.addEventListener('lostpointercapture', endDrag);
  }

  applyWidth();
  dividerEl.addEventListener('keydown', onKeyDown);
  dividerEl.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', applyWidth);

  return {
    dispose() {
      endDrag();
      dividerEl.removeEventListener('keydown', onKeyDown);
      dividerEl.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', applyWidth);
    },
  };
}

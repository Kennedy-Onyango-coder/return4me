import { describe, expect, it, vi } from 'vitest';
import { trapModalFocus } from '../modalFocus';

// Minimal DOM doubles keep these keyboard-behavior tests in the existing Node environment.
function fixture(activeIndex: number, shiftKey = false, empty = false) {
  const controls = [0, 1, 2].map(() => ({
    tabIndex: 0, matches: () => false, closest: () => null,
    getClientRects: () => [1], focus: vi.fn(),
  }));
  const dialog = {
    querySelectorAll: () => empty ? [] : controls,
    ownerDocument: { activeElement: controls[activeIndex] }, focus: vi.fn(),
  };
  const event = { key: 'Tab', shiftKey, preventDefault: vi.fn() };
  trapModalFocus(event as unknown as KeyboardEvent, dialog as unknown as HTMLElement);
  return { controls, dialog, event };
}

describe('modal keyboard focus', () => {
  it('wraps Tab from last to first', () => {
    const { controls, event } = fixture(2);
    expect(controls[0].focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it('wraps Shift+Tab from first to last', () => {
    expect(fixture(0, true).controls[2].focus).toHaveBeenCalledOnce();
  });
  it('allows native navigation between controls', () => {
    expect(fixture(1).event.preventDefault).not.toHaveBeenCalled();
  });
  it('recovers focus that escaped the dialog', () => {
    expect(fixture(-1).controls[0].focus).toHaveBeenCalledOnce();
    expect(fixture(-1, true).controls[2].focus).toHaveBeenCalledOnce();
  });
  it('focuses the dialog when no controls are available', () => {
    expect(fixture(-1, false, true).dialog.focus).toHaveBeenCalledOnce();
  });
});
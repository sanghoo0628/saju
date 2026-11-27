import { describe, expect, it, vi } from 'vitest';
import { handleComposerKeyDown } from '../src/composer-keyboard.ts';

function key(overrides: Partial<Parameters<typeof handleComposerKeyDown>[0]> = {}) {
  return { key: 'Enter', shiftKey: false,
    nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: vi.fn(), ...overrides };
}

describe('chat composer Enter behavior', () => {
  it('submits an ordinary Enter once and prevents an extra newline', () => {
    const event = key(), send = vi.fn();
    handleComposerKeyDown(event, send);
    expect(send).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('preserves Shift+Enter as a newline without submitting', () => {
    const event = key({ shiftKey: true }), send = vi.fn();
    handleComposerKeyDown(event, send);
    expect(send).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['composition still active', { isComposing: true, keyCode: 13 }],
    ['compositionend already fired', { isComposing: false, keyCode: 229 }],
  ] as const)('commits Korean text without sending when %s, then accepts the next ordinary Enter', (_name, nativeEvent) => {
    const confirm = key({ nativeEvent }), send = vi.fn();
    handleComposerKeyDown(confirm, send);
    expect(send).not.toHaveBeenCalled();
    expect(confirm.preventDefault).not.toHaveBeenCalled();
    const submit = key();
    handleComposerKeyDown(submit, send);
    expect(send).toHaveBeenCalledOnce();
    expect(submit.preventDefault).toHaveBeenCalledOnce();
  });

  it('does not capture typing, IME Process keys or navigation', () => {
    const send = vi.fn();
    for (const value of ['가', 'Process', 'ArrowLeft', 'Escape']) {
      const event = key({ key: value });
      handleComposerKeyDown(event, send);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
  });
});

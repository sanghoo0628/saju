interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault(): void;
}

/** Preserve IME confirmation and Shift+Enter; only an ordinary Enter submits. */
export function handleComposerKeyDown(event: ComposerKeyEvent, send: () => void): void {
  // compositionend can precede the confirming keydown, leaving isComposing false.
  // keyCode is deprecated but 229 remains necessary for this IME boundary case:
  // https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event#keydown_events_with_ime
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing
    || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  send();
}

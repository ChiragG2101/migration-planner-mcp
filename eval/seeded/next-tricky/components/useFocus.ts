import type { MutableRefObject } from 'react';

export function focusRef(ref: MutableRefObject<HTMLElement | null>): void {
  ref.current?.focus();
}

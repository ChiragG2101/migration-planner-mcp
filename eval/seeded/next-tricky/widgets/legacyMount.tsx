import { findDOMNode, hydrate, render, unmountComponentAtNode } from './dom';
import { LegacyForm } from '../components/LegacyForm';

export function mountAll(el: HTMLElement) {
  render(<LegacyForm />, el);
}

export function hydrateAll(el: HTMLElement) {
  hydrate(<LegacyForm />, el);
}

export function unmountAll(el: HTMLElement) {
  unmountComponentAtNode(el);
}

export function nodeOf(instance: unknown) {
  return findDOMNode(instance as never);
}

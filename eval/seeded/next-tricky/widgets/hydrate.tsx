import { findDOMNode, hydrate, unmountComponentAtNode } from 'react-dom';
import { LegacyForm } from '../components/LegacyForm';

export function hydrateLegacyForm(el: HTMLElement) {
  hydrate(<LegacyForm />, el);
}

export function unmountLegacyForm(el: HTMLElement) {
  unmountComponentAtNode(el);
}

export function legacyFormNode(instance: unknown) {
  return findDOMNode(instance as never);
}

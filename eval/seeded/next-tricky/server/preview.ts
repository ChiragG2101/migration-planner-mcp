import { draftMode } from 'next/headers';

export function isPreview(): boolean {
  return draftMode().isEnabled;
}

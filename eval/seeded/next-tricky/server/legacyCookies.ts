import { cookies } from 'next/dist/client/components/headers';

export function readTheme(): string {
  return cookies().get('theme')?.value ?? 'light';
}

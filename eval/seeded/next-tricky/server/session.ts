import { cookies } from 'next/headers';

export function getSession(): string | undefined {
  return cookies().get('session')?.value;
}

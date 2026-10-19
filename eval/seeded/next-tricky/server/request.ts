import { headers } from 'next/headers';

export function userAgent(): string {
  return headers().get('user-agent') ?? 'unknown';
}

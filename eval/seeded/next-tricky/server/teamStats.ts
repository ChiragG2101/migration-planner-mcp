import { unstable_cacheLife } from '@/server/cache';

export async function teamStats() {
  'use cache';
  unstable_cacheLife('minutes');
  return { members: 0 };
}

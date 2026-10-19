import { unstable_cacheLife as cacheLife } from 'next/cache';

export async function cachedStats() {
  'use cache';
  cacheLife('hours');
  return { visits: 0 };
}

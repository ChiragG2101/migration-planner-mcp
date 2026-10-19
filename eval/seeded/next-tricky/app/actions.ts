'use server';

import { revalidateTag } from '@/server/cache';

export async function refreshTeam(team: string) {
  revalidateTag(`team-${team}`);
}

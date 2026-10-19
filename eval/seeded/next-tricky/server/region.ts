import { unstable_rootParams } from './nextServer';

export async function currentRegion(): Promise<string> {
  const { region } = await unstable_rootParams();
  return region ?? 'eu';
}

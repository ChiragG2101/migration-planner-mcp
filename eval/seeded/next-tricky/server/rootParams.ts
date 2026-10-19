import { unstable_rootParams } from 'next/server';

export async function currentLocale(): Promise<string> {
  const { locale } = await unstable_rootParams();
  return locale ?? 'en';
}

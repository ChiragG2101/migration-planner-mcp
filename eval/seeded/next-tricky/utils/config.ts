import getConfig from 'next/config';

export function apiUrl(): string {
  return getConfig().publicRuntimeConfig.apiUrl;
}

function cookies(): Record<string, string> {
  return Object.fromEntries(document.cookie.split('; ').map((c) => c.split('=')));
}

export const clientCookies = () => cookies();

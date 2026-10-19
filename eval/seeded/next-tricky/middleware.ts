import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const country = request.geo?.country ?? 'US';
  const ip = request.ip ?? 'unknown';
  const res = NextResponse.rewrite(new URL(`/${country.toLowerCase()}`, request.url));
  res.headers.set('x-client-ip', ip);
  return res;
}

export const config = { matcher: '/' };

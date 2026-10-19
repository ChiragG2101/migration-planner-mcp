import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const country = request.geo?.country ?? 'US';
  return NextResponse.rewrite(new URL(`/${country.toLowerCase()}`, request.url));
}

export const config = { matcher: '/' };

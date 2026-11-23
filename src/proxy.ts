import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabasePublicConfig } from '@/lib/env/public';

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  response.headers.set('Cache-Control', 'private, no-store');
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return response;
  const { url, key } = getSupabasePublicConfig();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([name, value]) => response.headers.set(name, value));
        response.headers.set('Cache-Control', 'private, no-store');
      },
    },
  });
  // Refresh only. Every protected handler independently verifies with getUser().
  try { await supabase.auth.getClaims(); } catch { /* Authentication fails closed in handlers. */ }
  return response;
}

export const config = {
  // Groble callbacks authenticate raw bytes by signature in C; never require a user session.
  matcher: ['/((?!api/webhooks(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};

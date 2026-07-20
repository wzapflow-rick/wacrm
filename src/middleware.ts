import { getSessionCookie } from 'better-auth/cookies'
import { NextResponse, type NextRequest } from 'next/server'

// Optimistic auth gate. We only check for the PRESENCE of a valid Better Auth
// session cookie here — no database call — which keeps the middleware fast and
// Edge-safe. Full session validation (and per-account scoping) happens in the
// route handlers / server components via auth.api.getSession(). This mirrors
// Better Auth's recommended middleware pattern.
export async function middleware(request: NextRequest) {
  const hasSession = Boolean(getSessionCookie(request))
  const { pathname, searchParams } = request.nextUrl

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is present we send the signed-in user to
  // /join/<token> so they can accept the invitation in one click.
  if (
    hasSession &&
    (pathname === '/login' ||
      pathname === '/signup' ||
      pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone()
    const inviteToken = searchParams.get('invite')
    if (inviteToken && (pathname === '/login' || pathname === '/signup')) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated.
  const protectedPaths = [
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
  ]
  if (!hasSession && protectedPaths.some((path) => pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // API routes that need auth (not webhooks).
  if (
    !hasSession &&
    pathname.startsWith('/api/whatsapp/') &&
    !pathname.includes('/webhook')
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

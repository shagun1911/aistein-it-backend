/**
 * Normalize public backend / frontend URLs for OAuth redirects.
 * BACKEND_URL must be the API origin only (no /api/v1 suffix).
 */

function trim(value: string | undefined): string {
  return (value || '').trim();
}

export function normalizePublicBackendBase(raw: string): string {
  let base = trim(raw).replace(/\/+$/, '');
  if (base.endsWith('/api/v1')) {
    base = base.slice(0, -'/api/v1'.length);
  }
  return base;
}

export function getPublicBackendBaseFromEnv(): string {
  const raw =
    trim(process.env.BACKEND_URL) ||
    trim(process.env.PUBLIC_API_URL) ||
    '';
  if (!raw) return '';
  return normalizePublicBackendBase(raw);
}

export function getMetaLeadsOAuthRedirectUri(backendUrl?: string): string {
  const override = trim(process.env.META_LEADS_OAUTH_REDIRECT_URI);
  if (override) return override;

  const base = normalizePublicBackendBase(backendUrl || getPublicBackendBaseFromEnv());
  if (!base) {
    throw new Error('BACKEND_URL or PUBLIC_API_URL is required for Meta Leads OAuth');
  }
  return `${base}/api/v1/social-integrations/meta-leads/oauth/callback`;
}

function normalizeOrigin(value: string): string | null {
  const trimmed = trim(value);
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
}

/** Origins allowed for OAuth return redirects (Aistein + Synervo + extras). */
export function collectAllowedFrontendOrigins(): string[] {
  const origins = new Set<string>();
  const envKeys = [
    'FRONTEND_URL',
    'SYNERVO_FRONTEND_URL',
    'CANDEX_FRONTEND_URL',
    'ALLOWED_FRONTEND_ORIGINS',
  ];

  for (const key of envKeys) {
    const raw = trim(process.env[key]);
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const origin = normalizeOrigin(part);
      if (origin) origins.add(origin);
    }
  }

  return [...origins];
}

/**
 * Pick where to send the user after Meta OAuth (Settings → Socials).
 * Uses the initiating app's origin when it is on the allowlist.
 */
export function resolveOAuthReturnBase(requestedOrigin?: string): string {
  const allowed = collectAllowedFrontendOrigins();
  const fallback =
    normalizeOrigin(trim(process.env.FRONTEND_URL)) ||
    allowed[0] ||
    'http://localhost:3000';

  const requested = normalizeOrigin(requestedOrigin || '');
  if (!requested) return fallback;

  if (allowed.length === 0 || allowed.includes(requested)) {
    return requested;
  }

  console.warn(
    `[OAuth] returnOrigin ${requested} not in allowlist; using ${fallback}. ` +
      `Set SYNERVO_FRONTEND_URL or ALLOWED_FRONTEND_ORIGINS on the backend.`
  );
  return fallback;
}

export function oauthSocialsReturnUrl(returnBase: string): string {
  return `${returnBase.replace(/\/+$/, '')}/settings/socials`;
}

export function appendSocialsQuery(
  returnUrl: string,
  params: Record<string, string>
): string {
  const url = new URL(returnUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Prefer redirect URL stored in OAuth state; validate origin against allowlist. */
export function resolveOAuthStateReturnUrl(stateRedirectUrl?: string): string {
  const fallback = oauthSocialsReturnUrl(resolveOAuthReturnBase());
  if (!stateRedirectUrl) return fallback;

  try {
    const parsed = new URL(stateRedirectUrl);
    const allowed = collectAllowedFrontendOrigins();
    if (allowed.length === 0 || allowed.includes(parsed.origin)) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    console.warn(
      `[OAuth] state redirect origin ${parsed.origin} not allowed; using ${fallback}`
    );
  } catch {
    console.warn('[OAuth] Invalid state.redirectUrl; using fallback');
  }
  return fallback;
}

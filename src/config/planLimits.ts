/**
 * PLAN LIMITS - Single Source of Truth
 * 
 * These limits define what each plan tier allows.
 * Used by webhook to activate plans and by middleware to enforce limits.
 */
export const PLAN_LIMITS = {
  free: {
    conversations: 20,
    minutes: 20,
    automations: 5,
  },
  setup: {
    conversations: 3500,
    minutes: 1500,
    automations: 75,
  },
  mileva: {
    conversations: 1000,
    minutes: 500,
    automations: 25,
  },
  nobel: {
    conversations: 2500,
    minutes: 1000,
    automations: 50,
  },
  pro: {
    conversations: 5000,
    minutes: 2000,
    automations: 100,
  },
} as const;

/**
 * Get plan limits for a plan key
 */
export function getPlanLimits(planKey: string): { conversations: number; minutes: number; automations: number } | null {
  const normalizedKey = planKey.toLowerCase().trim();
  
  // Handle plan slug variations
  if (normalizedKey === 'mileva-pack' || normalizedKey === 'mileva') {
    return PLAN_LIMITS.mileva;
  }
  if (normalizedKey === 'nobel-pack' || normalizedKey === 'nobel') {
    return PLAN_LIMITS.nobel;
  }
  if (normalizedKey === 'aistein-pro-pack' || normalizedKey === 'aistein-pro' || normalizedKey === 'pro') {
    return PLAN_LIMITS.pro;
  }
  if (normalizedKey === 'set-up' || normalizedKey === 'setup') {
    return PLAN_LIMITS.setup;
  }
  if (normalizedKey === 'free') {
    return PLAN_LIMITS.free;
  }
  
  // Try direct lookup
  return PLAN_LIMITS[normalizedKey as keyof typeof PLAN_LIMITS] || null;
}

/**
 * Limits as stored on Plan.features (and used by usageTracker / profile checks).
 * When planId is missing or features are incomplete, falls back to PLAN_LIMITS via org.plan slug (default free).
 */
export function getEffectiveFeatureLimits(
  org: { plan?: string } | null | undefined,
  planDoc: any | null | undefined
): { chatConversations: number; callMinutes: number; automations: number } {
  const slug = (org?.plan || 'free').toString().toLowerCase().trim();
  const lim = getPlanLimits(slug) || getPlanLimits('free')!;
  const f = planDoc?.features;

  const pick = (v: unknown, fallback: number) =>
    typeof v === 'number' ? v : fallback;

  return {
    chatConversations: pick(f?.chatConversations, lim.conversations),
    callMinutes: pick(f?.callMinutes, lim.minutes),
    automations: pick(f?.automations, lim.automations)
  };
}


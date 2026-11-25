import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Result of claiming one billed provider call for today (Asia/Seoul). */
export type ProviderCallClaim = "ok" | "user_limit" | "total_limit";
export type ClaimProviderCall = (userId: string) => Promise<ProviderCallClaim>;

export interface FortuneQuotaLimits {
  /** Per-user billed calls per Korean calendar day. */
  userLimit: number;
  /** Whole-project billed calls per Korean calendar day. */
  totalLimit: number;
}

/**
 * Atomic daily claim backed by public.claim_fortune_provider_call (service_role only).
 * Called right before a billed HRUM request; cache hits never reach it. A claimed call is
 * never refunded, so provider failures and timeouts still count (team decision 2026-11-25).
 * Any DB error throws: callers must fail closed and skip the provider call.
 */
export function createSupabaseFortuneQuota(getClient: () => SupabaseClient, limits: FortuneQuotaLimits): ClaimProviderCall {
  for (const value of [limits.userLimit, limits.totalLimit]) {
    if (!Number.isInteger(value) || value < 1) throw new Error("Fortune quota limits must be positive integers.");
  }
  return async (userId) => {
    const { data, error } = await getClient().rpc("claim_fortune_provider_call", {
      p_user: userId, p_user_limit: limits.userLimit, p_total_limit: limits.totalLimit,
    });
    if (error) throw new Error("Fortune quota is unavailable.");
    if (data === "ok" || data === "user_limit" || data === "total_limit") return data;
    throw new Error("Fortune quota returned an unexpected value.");
  };
}

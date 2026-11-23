/** Confirmed product policy from the user's 2026-11-16 change. */
export const PRODUCT_POLICY = {
  version: "target-chat-v1",
  recommendationCount: 3,
  profileViewingPriceKrw: 0,
  conversationPricePerRecipientKrw: 500,
  existingConversationRequiresRepayment: false,
  recipientAcceptancePriceKrw: 0,
  recipientReplyPriceKrw: 0,
  requiresRecipientAcceptance: true,
} as const;

export type UserId = string; // Supabase auth.users.id (UUID); never an email.
export type MatchingModelId = "legacy_demo_v1" | "saju_hybrid_v0_1";

/** This is readiness metadata, not a completed scoring implementation. B owns it. */
export type MatchingReadiness =
  | { status: "ready"; modelId: MatchingModelId; version: string }
  | {
      status: "not_ready";
      modelId: MatchingModelId;
      reasons: readonly string[];
    };

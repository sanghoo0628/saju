/** P1/P2 boundary only; no provider or booking is enabled by these types. */
export interface SharedActivityConstraints {
  conversationId: string;
  startsAt: string;
  timezone: string;
  durationMinutes: number;
  participants: readonly [
    { userId: string; maxBudgetKrw: number; maxTravelMinutes: number },
    { userId: string; maxBudgetKrw: number; maxTravelMinutes: number },
  ];
  // Affiliate commission is intentionally not a recommendation input.
}

export type BookingReadiness =
  | { status: "disabled" }
  | { status: "external_link"; url: string; confirmation: "unverified" }
  | { status: "manual_request"; confirmation: "pending" };

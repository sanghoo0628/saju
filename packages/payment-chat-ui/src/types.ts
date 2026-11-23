/** Minimal public fields accepted by the payment/chat UI. B's ProfileCard is structurally compatible. */
export interface ChatProfile {
  userId: string;
  nickname: string;
  major: string | null;
  /** Presentation only; no score, date of birth, email or class year is required. */
  tone?: "rose" | "sage" | "sand";
}

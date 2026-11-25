import "server-only";
import { MATCHING_STORAGE_CONSENT_VERSION, type FortuneInput } from "./schema";
import type { MatchingFortuneInput, ReadyMatchingFortuneInput } from "./matching-input";

/**
 * Result of the optional matching storage step, returned next to the fortune result.
 * - stored: B saved the input/analysis.
 * - not_consented: the user did not opt in; nothing was sent to B.
 * - skipped: (3-pillar analysis only) the analysis was not ready, so nothing was saved.
 * - calendar_unsupported: matching birth dates are solar-only for now; lunar input is not stored.
 * - locked: a fixed matching score already exists and the date differs; the DB keeps the first date.
 * - unavailable: matching storage is not configured on this server.
 * - failed: B rejected or could not save it. The fortune result is still returned.
 */
export type MatchingStorageStatus = "stored" | "not_consented" | "skipped" | "calendar_unsupported" | "locked" | "unavailable" | "failed";
export interface MatchingStorageOutcome { status: MatchingStorageStatus }

/** Only the fields B needs for the fixed score. Birth time, sex option and calculation options stay out. */
export interface BirthInputForStorage {
  birthDate: string;
  calendar: "solar" | "lunar";
  isLeapMonth: boolean;
  timezone: string;
}

/** The two B MatchingService methods A calls; injected so routes and tests share one code path. */
export interface FortuneStorageRecorder {
  recordBirthInput(userId: string, input: BirthInputForStorage): Promise<void>;
  recordMatchingAnalysis(userId: string, dto: ReadyMatchingFortuneInput): Promise<void>;
}

export function toBirthInputForStorage(input: FortuneInput): BirthInputForStorage {
  return { birthDate: input.birthDate, calendar: input.calendar, isLeapMonth: input.isLeapMonth, timezone: input.timezone };
}

async function record(
  consented: boolean,
  ready: boolean | "calendar_unsupported",
  getRecorder: () => FortuneStorageRecorder,
  write: (recorder: FortuneStorageRecorder) => Promise<void>,
): Promise<MatchingStorageOutcome> {
  if (!consented) return { status: "not_consented" };
  if (ready === "calendar_unsupported") return { status: "calendar_unsupported" };
  if (!ready) return { status: "skipped" };
  let recorder: FortuneStorageRecorder;
  try { recorder = getRecorder(); } catch { return { status: "unavailable" }; }
  // Do not log raw errors: they can contain birth input.
  try { await write(recorder); return { status: "stored" }; } catch (error) {
    // B maps the DB trigger (20261125000400) to MatchingError("BIRTH_INPUT_LOCKED"). Same-date re-saves still succeed.
    return { status: (error as { code?: unknown } | null)?.code === "BIRTH_INPUT_LOCKED" ? "locked" : "failed" };
  }
}

/**
 * After POST /api/fortune: save the matching birth input whenever the user consented and the
 * date passed solar validation (fortuneInputSchema). It does NOT depend on the fortune result,
 * so a missing or failing provider still lets the user continue to profile and recommendations.
 * Nothing from the fortune result (pillars, elements, interpretation) is stored here.
 */
export function storeBirthInputIfConsented(
  userId: string, input: FortuneInput, getRecorder: () => FortuneStorageRecorder,
): Promise<MatchingStorageOutcome> {
  return record(
    input.matchingStorageConsent === MATCHING_STORAGE_CONSENT_VERSION,
    // MVP: solar only. Lunar/leap input waits for verified conversion (team decision 2026-11-25).
    input.calendar === "solar" && !input.isLeapMonth ? true : "calendar_unsupported",
    getRecorder,
    (recorder) => recorder.recordBirthInput(userId, toBirthInputForStorage(input)),
  );
}

/** After POST /api/fortune/matching-basis: save the three-pillar analysis only when ready and consented. */
export function storeMatchingAnalysisIfConsented(
  userId: string, input: FortuneInput, result: MatchingFortuneInput, getRecorder: () => FortuneStorageRecorder,
): Promise<MatchingStorageOutcome> {
  return record(
    input.matchingStorageConsent === MATCHING_STORAGE_CONSENT_VERSION,
    result.status === "ready",
    getRecorder,
    (recorder) => recorder.recordMatchingAnalysis(userId, result as ReadyMatchingFortuneInput),
  );
}

import "server-only";
import { getMatchingService } from "@/server/matching-runtime";
import type { FortuneStorageRecorder } from "./storage";

/** Connects A's storage step to B's MatchingService. Throws when matching is not configured. */
export function getFortuneStorageRecorder(): FortuneStorageRecorder {
  const service = getMatchingService();
  return {
    recordBirthInput: (userId, input) => service.recordBirthInput(userId, input),
    recordMatchingAnalysis: (userId, dto) => service.recordMatchingAnalysis(userId, dto),
  };
}

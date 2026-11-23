import { z } from "zod";

const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Must equal B's BIRTH_STORAGE_CONSENT_VERSION (src/server/matching-service.ts); a test enforces it. */
export const MATCHING_STORAGE_CONSENT_VERSION = "matching_birth_storage_v1" as const;

export const fortuneInputSchema = z
  .object({
    birthDate: z.string().regex(dateParts, "생년월일을 YYYY-MM-DD 형식으로 입력해 주세요."),
    birthTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "출생 시간을 확인해 주세요.").nullable(),
    calendar: z.enum(["solar", "lunar"]),
    isLeapMonth: z.boolean(),
    timezone: z.string().min(1).max(80).refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "올바른 출생 지역 시간대를 입력해 주세요."),
    // An engine option only; never use this as a dating preference.
    providerSex: z.enum(["male", "female", "unspecified"]).default("unspecified"),
    calculationOptions: z.object({
      dayBoundary: z.enum(["provider_default", "civil_midnight", "late_zi"]),
      timeCorrection: z.enum(["provider_default", "none"]),
    }).strict().default({ dayBoundary: "provider_default", timeCorrection: "provider_default" }),
    consent: z.literal(true, { error: "사주 입력 처리에 동의해 주세요." }),
    externalProviderConsent: z.literal('hrum_birth_data_v1').optional(),
    // Opt-in storage of birth date/calendar/leap month/timezone for B's matching. Never the birth time.
    matchingStorageConsent: z.literal(MATCHING_STORAGE_CONSENT_VERSION).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const match = dateParts.exec(input.birthDate);
    if (!match) return;
    // Fixed positions are safe after the complete date format matched.
    const year = Number(input.birthDate.slice(0, 4));
    const month = Number(input.birthDate.slice(5, 7));
    const day = Number(input.birthDate.slice(8, 10));
    const currentYear = new Date().getUTCFullYear();
    if (year < 1900 || year > currentYear || month < 1 || month > 12 || day < 1) {
      context.addIssue({ code: "custom", path: ["birthDate"], message: "생년월일 범위를 확인해 주세요." });
      return;
    }
    if (input.calendar === "solar") {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getTime() > Date.now()) {
        context.addIssue({ code: "custom", path: ["birthDate"], message: "존재하는 과거 날짜를 입력해 주세요." });
      }
      if (input.isLeapMonth) {
        context.addIssue({ code: "custom", path: ["isLeapMonth"], message: "윤달은 음력에만 적용됩니다." });
      }
    } else if (day > 30) {
      context.addIssue({ code: "custom", path: ["birthDate"], message: "음력 날짜는 1~30일 범위로 입력해 주세요." });
    }
    // A real provider must validate lunar leap months and perform conversion.
    // Never validate a lunar date by silently interpreting it as Gregorian.
  });

export type FortuneInput = z.infer<typeof fortuneInputSchema>;
export type FortuneInputRequest = z.input<typeof fortuneInputSchema>;

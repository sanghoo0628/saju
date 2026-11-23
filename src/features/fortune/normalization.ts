import { z } from "zod";

export const stemCodes = ["gap", "eul", "byeong", "jeong", "mu", "gi", "gyeong", "sin", "im", "gye"] as const;
export const branchCodes = ["ja", "chuk", "in", "myo", "jin", "sa", "o", "mi", "sin", "yu", "sul", "hae"] as const;
export const elementCodes = ['wood', 'fire', 'earth', 'metal', 'water'] as const;
export const elementSchema = z.enum(elementCodes);
export type ElementCode = z.infer<typeof elementSchema>;

const basisSchema = z.enum(["three_pillars", "four_pillars"]);
const pillarSchema = z.object({ stem: z.enum(stemCodes), branch: z.enum(branchCodes) }).strict();
const analysisMetadata = {
  basis: basisSchema,
  method: z.string().min(1).max(160),
};
const elementValuesSchema = z.object({
  wood: z.number().nonnegative(), fire: z.number().nonnegative(),
  earth: z.number().nonnegative(), metal: z.number().nonnegative(), water: z.number().nonnegative(),
}).strict();
const elementStateSchema = z.object({
  count: z.number().nonnegative(),
  // Provider has no exhaustive documented enum. Preserve as opaque context, never scores.
  state: z.string().min(1).max(80), effect: z.string().min(1).max(80),
}).strict();

export const yongshinSchema = z.object({
  ...analysisMetadata,
  selectionMethod: z.enum(['dominance', 'climate', 'balancing', 'mediation', 'remedy', 'unmapped']),
  providerMethod: z.string().min(1).max(80),
  primary: elementSchema,
  secondary: z.array(elementSchema).max(5),
  roles: z.object({
    yongshin: elementSchema.nullable(), huishin: elementSchema.nullable(),
    gishin: elementSchema.nullable(), gushin: elementSchema.nullable(), hanshin: elementSchema.nullable(),
  }).strict().nullable(),
  balancingPrimary: elementSchema.nullable(),
  climatePrimary: elementSchema.nullable(),
  reasoning: z.array(z.string().max(2000)).max(30),
  elementStates: z.object({ wood: elementStateSchema, fire: elementStateSchema, earth: elementStateSchema, metal: elementStateSchema, water: elementStateSchema }).strict().nullable(),
}).strict();

export const strengthSchema = z.object({
  ...analysisMetadata,
  dayMaster: z.enum(stemCodes),
  score: z.number().min(-100).max(100),
  result: z.enum(['strong', 'weak', 'balanced', 'unmapped']),
  providerResult: z.string().min(1).max(80),
  level: z.string().min(1).max(80),
  breakdown: z.object({ season: z.number(), support: z.number(), control: z.number(), hidden: z.number(), root: z.number() }).strict().nullable(),
  root: z.object({ rooted: z.boolean(), score: z.number() }).strict().nullable(),
}).strict();

// This is our adapter output contract, not an invented external provider schema.
export const normalizedChartSchema = z.object({
  chartBasis: basisSchema,
  calculation: z.object({
    profileId: z.string().min(1).max(160),
    dayBoundary: z.enum(['zi_hour_start', 'civil_midnight', 'mock']),
    timeCorrection: z.enum(['none', 'mock']),
    timezone: z.string().min(1).max(80),
  }).strict(),
  chart: z.object({
    year: pillarSchema,
    month: pillarSchema,
    day: pillarSchema,
    hour: pillarSchema.nullable(),
  }).strict(),
  analysis: z.object({
    elementBalance: z.object({
      ...analysisMetadata,
      values: elementValuesSchema,
      unit: z.literal('surface_character_count'),
    }).strict().nullable(),
    yongshin: yongshinSchema.nullable(),
    strength: strengthSchema.nullable(),
  }).strict(),
  interpretation: z.object({
    title: z.string().min(1).max(160),
    paragraphs: z.array(z.string().max(2000)).max(12),
  }).strict(),
  limitations: z.array(z.string().max(500)).max(20),
}).strict().superRefine((result, context) => {
  if ((result.chartBasis === "three_pillars") !== (result.chart.hour === null)) {
    context.addIssue({ code: "custom", path: ["chart", "hour"], message: "원국 기준과 시주가 일치하지 않습니다." });
  }
  for (const [field, analysis] of Object.entries(result.analysis)) {
    if (analysis && analysis.basis !== result.chartBasis) {
      context.addIssue({ code: "custom", path: ["analysis", field], message: "원국과 파생지표 기준이 다릅니다." });
    }
  }
  if (result.analysis.strength && result.analysis.strength.dayMaster !== result.chart.day.stem) {
    context.addIssue({ code: 'custom', path: ['analysis', 'strength', 'dayMaster'], message: '강약 분석의 일간이 원국과 다릅니다.' });
  }
  if (result.analysis.yongshin?.roles?.yongshin && result.analysis.yongshin.roles.yongshin !== result.analysis.yongshin.primary) {
    context.addIssue({ code: 'custom', path: ['analysis', 'yongshin'], message: '최종 용신과 역할 값이 다릅니다.' });
  }
  if (result.analysis.elementBalance) {
    const total = Object.values(result.analysis.elementBalance.values).reduce((a,b) => a+b, 0);
    if (total !== (result.chartBasis === 'three_pillars' ? 6 : 8)) context.addIssue({code:'custom', path:['analysis','elementBalance'], message:'오행 표면 글자 수 기준이 다릅니다.'});
  }
});

export type NormalizedChart = z.infer<typeof normalizedChartSchema>;

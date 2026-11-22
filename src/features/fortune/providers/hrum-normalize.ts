import "server-only";
import { z } from "zod";
import { normalizedChartSchema, type NormalizedChart } from "../normalization";
import type { FortuneInput } from "../schema";

const stemMap = { 갑: "gap", 을: "eul", 병: "byeong", 정: "jeong", 무: "mu", 기: "gi", 경: "gyeong", 신: "sin", 임: "im", 계: "gye" } as const;
const branchMap = { 자: "ja", 축: "chuk", 인: "in", 묘: "myo", 진: "jin", 사: "sa", 오: "o", 미: "mi", 신: "sin", 유: "yu", 술: "sul", 해: "hae" } as const;
const elementMap = { 목: "wood", 화: "fire", 토: "earth", 금: "metal", 수: "water" } as const;
const stemSchema = z.enum(["갑", "을", "병", "정", "무", "기", "경", "신", "임", "계"]);
const branchSchema = z.enum(["자", "축", "인", "묘", "진", "사", "오", "미", "신", "유", "술", "해"]);
const elementSchema = z.enum(["목", "화", "토", "금", "수"]);
const optionalElementSchema = elementSchema.nullish();
const labelSchema = z.string().min(1).max(80);
const countSchema = z.number().int().min(0).max(8);
const pillarSchema = z.object({ stem: stemSchema, branch: branchSchema });
const elementStateSchema = z.object({ count: countSchema, state: labelSchema, effect: labelSchema });

// All objects intentionally strip unknown properties. Only the documented fields below are retained.
const responseSchema = z.object({
  success: z.literal(true),
  warnings: z.array(z.unknown()).max(0).optional(),
  data: z.object({
    warnings: z.array(z.unknown()).max(0).optional(),
    wonkuk: z.object({ year: pillarSchema, month: pillarSchema, day: pillarSchema, hour: pillarSchema.nullable() }),
    birthHour: z.object({
      known: z.boolean(),
      basis: z.enum(["three_pillars", "four_pillars"]).optional(),
      hourPillar: z.unknown().optional(),
    }).optional(),
    ohaengBalance: z.object({ 목: countSchema, 화: countSchema, 토: countSchema, 금: countSchema, 수: countSchema }),
    yongshin: optionalElementSchema,
    eokbuYongshin: optionalElementSchema,
    johuYongshin: optionalElementSchema,
    yongshinDetail: z.object({
      method: labelSchema,
      primary: elementSchema,
      secondary: z.array(elementSchema).max(5),
      reasoning: z.array(z.string().max(2000)).max(30),
      shin: z.object({
        yongshin: optionalElementSchema, huishin: optionalElementSchema, gishin: optionalElementSchema,
        gushin: optionalElementSchema, hanshin: optionalElementSchema,
      }).nullish(),
      element_states: z.object({ 목: elementStateSchema, 화: elementStateSchema, 토: elementStateSchema, 금: elementStateSchema, 수: elementStateSchema }).nullish(),
    }).nullish(),
    strength: z.object({
      dayMaster: stemSchema,
      score: z.number().min(-100).max(100),
      result: labelSchema,
      level: labelSchema,
      breakdown: z.object({ season: z.number(), support: z.number(), control: z.number(), hidden: z.number(), root: z.number() }).nullish(),
      root: z.object({ rooted: z.boolean(), rootScore: z.number() }).nullish(),
    }).nullish(),
    // This adapter never supplies coordinates or country. An unexpected correction changes the contract.
    trueSolarTime: z.null().optional(),
  }),
});

const methodMap: Record<string, NonNullable<NormalizedChart["analysis"]["yongshin"]>["selectionMethod"]> = {
  전왕: "dominance", 조후: "climate", 억부: "balancing", 통관: "mediation", 병약: "remedy",
};
const strengthResultMap: Record<string, NonNullable<NormalizedChart["analysis"]["strength"]>["result"]> = {
  신강: "strong", 신약: "weak", 중화: "balanced",
};

function pillar(value: z.infer<typeof pillarSchema>) {
  return { stem: stemMap[value.stem], branch: branchMap[value.branch] };
}
function element(value: z.infer<typeof optionalElementSchema>) {
  return value == null ? null : elementMap[value];
}
function elements<T>(values: { 목: T; 화: T; 토: T; 금: T; 수: T }) {
  return { wood: values.목, fire: values.화, earth: values.토, metal: values.금, water: values.수 };
}

/** Normalizes a single provider calculation; it never derives missing metrics or compatibility scores. */
export function normalizeHrumResponse(payload: unknown, input: FortuneInput): NormalizedChart {
  const { data } = responseSchema.parse(payload);
  const basis = input.birthTime === null ? "three_pillars" : "four_pillars";
  if (basis === "three_pillars") {
    if (data.wonkuk.hour !== null || data.birthHour?.known !== false || data.birthHour.basis !== "three_pillars" || data.birthHour.hourPillar !== null) {
      throw new Error("Invalid provider basis");
    }
  } else if (data.wonkuk.hour === null || data.birthHour?.known === false || data.birthHour?.basis === "three_pillars") {
    throw new Error("Invalid provider basis");
  }
  const detail = data.yongshinDetail;
  if (detail && data.yongshin && detail.primary !== data.yongshin) throw new Error("Invalid provider yongshin");
  if (detail?.element_states) {
    for (const code of ["목", "화", "토", "금", "수"] as const) {
      if (detail.element_states[code].count !== data.ohaengBalance[code]) throw new Error("Invalid provider element count");
    }
  }
  const yongshin: NormalizedChart["analysis"]["yongshin"] = detail ? {
    basis, method: "hrum_five_methods_v1",
    selectionMethod: Object.hasOwn(methodMap, detail.method) ? (methodMap[detail.method] ?? "unmapped") : "unmapped", providerMethod: detail.method,
    primary: elementMap[detail.primary], secondary: detail.secondary.map((value) => elementMap[value]),
    roles: detail.shin ? {
      yongshin: element(detail.shin.yongshin), huishin: element(detail.shin.huishin), gishin: element(detail.shin.gishin),
      gushin: element(detail.shin.gushin), hanshin: element(detail.shin.hanshin),
    } : null,
    balancingPrimary: element(data.eokbuYongshin), climatePrimary: element(data.johuYongshin),
    reasoning: detail.reasoning, elementStates: detail.element_states ? elements(detail.element_states) : null,
  } : null;
  const strength: NormalizedChart["analysis"]["strength"] = data.strength ? {
    basis, method: "hrum_strength_v1",
    dayMaster: stemMap[data.strength.dayMaster], score: data.strength.score,
    result: Object.hasOwn(strengthResultMap, data.strength.result) ? (strengthResultMap[data.strength.result] ?? "unmapped") : "unmapped", providerResult: data.strength.result, level: data.strength.level,
    breakdown: data.strength.breakdown ?? null,
    root: data.strength.root ? { rooted: data.strength.root.rooted, score: data.strength.root.rootScore } : null,
  } : null;
  const civilMidnight = input.calculationOptions.dayBoundary === "civil_midnight";
  const limitations = [
    "외부 공급자의 사주 해석이며 궁합·사용자 매칭 점수는 계산하지 않았습니다.",
    "HRUM 만세력 엔진 버전은 응답에 공개되지 않습니다. adapter 버전은 엔진 버전이 아닙니다.",
    "위치·국가를 전송하지 않아 진태양시 보정을 적용하지 않았습니다.",
    ...(basis === "three_pillars" ? ["출생 시간 미상: 3주(6글자) 기준입니다. 시주를 임의로 채우지 않았습니다."] : ["4주 상세 결과입니다. 공통 3주 매칭에 재사용할 수 없습니다."]),
    ...(!yongshin ? ["공급자가 구조화된 용신 분석을 제공하지 않았습니다."] : []),
    ...(!strength ? ["공급자가 강약 분석을 제공하지 않았습니다."] : []),
    ...(yongshin?.selectionMethod === "unmapped" ? ["공급자의 용신 선정 방법이 등록되지 않아 매칭 입력으로 사용할 수 없습니다."] : []),
    ...(strength?.result === "unmapped" ? ["공급자의 강약 분류가 등록되지 않아 매칭 입력으로 사용할 수 없습니다."] : []),
  ];
  return normalizedChartSchema.parse({
    chartBasis: basis,
    calculation: {
      profileId: civilMidnight ? "hrum_no_location_yajasi_v1" : "hrum_no_location_traditional_v1",
      dayBoundary: civilMidnight ? "civil_midnight" : "zi_hour_start",
      timeCorrection: "none", timezone: input.timezone,
    },
    chart: { year: pillar(data.wonkuk.year), month: pillar(data.wonkuk.month), day: pillar(data.wonkuk.day), hour: data.wonkuk.hour ? pillar(data.wonkuk.hour) : null },
    analysis: { elementBalance: { basis, method: "hrum_surface_counts_v1", unit: "surface_character_count", values: elements(data.ohaengBalance) }, yongshin, strength },
    interpretation: {
      title: "HRUM 사주 계산 결과",
      paragraphs: [
        `${basis === "three_pillars" ? "3주(6글자)" : "4주(8글자)"} 원국의 일간은 ${data.wonkuk.day.stem}입니다.`,
        ...(detail ? [`공급자가 선정한 용신은 ${detail.primary}이며 선정 방법은 ${detail.method}입니다.`] : []),
        ...(data.strength ? [`공급자 강약 분류는 ${data.strength.result}(${data.strength.level}), 원점수는 ${data.strength.score}입니다.`] : []),
      ],
    },
    limitations,
  });
}

/**
 * 거리순 추천 규칙 (개발 계획 2장).
 *
 * - 두 사람의 거리 = abs(내 점수 + 상대 점수)
 * - 추천 순위 = 거리 오름차순 → 동점이면 user_id 오름차순 (고정된 동점 기준)
 * - 상위 3명 선택
 *
 * ⚠️ 실제 무료 추천 저장은 DB 함수 public.get_or_create_match_results() 가
 *    같은 규칙으로 트랜잭션 안에서 선정한다 (supabase/migrations/..._matching_functions.sql).
 *    이 파일은 규칙의 기준 구현이며, 두 구현의 정렬 기준을 반드시 같이 바꿔야 한다.
 *    (tests/db/matching.db.test.ts 가 두 구현의 결과를 비교한다)
 *    (uuid 정렬: Postgres 는 바이트 순, JS 는 소문자 hex 문자열 순 → 결과 동일)
 */

export const MATCH_COUNT = 3;

export interface Candidate {
  userId: string;
  score: number;
}

export interface RankedCandidate extends Candidate {
  rank: number;
  distance: number;
}

export function matchDistance(myScore: number, otherScore: number): number {
  return Math.abs(myScore + otherScore);
}

export function compareCandidates(
  a: { distance: number; userId: string },
  b: { distance: number; userId: string },
): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  const ua = a.userId.toLowerCase();
  const ub = b.userId.toLowerCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/**
 * 후보 목록에서 추천 순위를 매긴다.
 * 후보 필터(본인·비활성·비공개·차단 제외)는 호출 전에 적용되어 있어야 한다.
 * 방어적으로 본인과 중복 userId 는 여기서도 제외한다.
 */
export function rankCandidates(
  myUserId: string,
  myScore: number,
  candidates: readonly Candidate[],
  limit: number = MATCH_COUNT,
): RankedCandidate[] {
  const seen = new Set<string>();
  const scored: Omit<RankedCandidate, "rank">[] = [];
  for (const c of candidates) {
    const id = c.userId.toLowerCase();
    if (id === myUserId.toLowerCase() || seen.has(id)) continue;
    seen.add(id);
    scored.push({ ...c, distance: matchDistance(myScore, c.score) });
  }
  scored.sort(compareCandidates);
  return scored.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));
}

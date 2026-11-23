/**
 * Docker·Supabase CLI 없이 마이그레이션과 RLS 를 검증하기 위한 테스트 환경.
 * PGlite(WASM Postgres) 위에 Supabase 의 auth/storage 스키마와 역할을 최소한으로 흉내 낸 뒤
 * supabase/migrations/*.sql 을 순서대로 적용한다.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "supabase", "migrations");

export const SUPABASE_STUB = /* sql */ `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Supabase 기본값: public 스키마 객체에 anon/authenticated/service_role 전체 권한
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    owner uuid
  );
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

  create publication supabase_realtime;
`;

export type Tx = Transaction;

export interface TestDb {
  db: PGlite;
  /** 로그인 사용자(authenticated) 또는 비로그인(anon) 으로 실행. 끝나면 롤백되지 않고 커밋된다. */
  asUser<T>(uid: string | null, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** 서버(service_role) 로 실행 */
  asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    } catch (e) {
      throw new Error(`마이그레이션 실패: ${f}\n${(e as Error).message}`);
    }
  }

  return {
    db,
    asUser: (uid, fn) =>
      db.transaction(async (tx) => {
        await tx.exec(`set local role ${uid ? "authenticated" : "anon"}`);
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ""]);
        return fn(tx);
      }),
    asService: (fn) =>
      db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        return fn(tx);
      }),
  };
}

/** 정렬 순서를 통제하기 위한 고정 uuid */
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface SeedUser {
  id: string;
  score?: number | null; // null 이면 사주 결과 없음
  track?: "humanities" | "science";
  isPublic?: boolean;
  isActive?: boolean; // false 이면 status = 'deleted' (탈퇴)
  photoPath?: string | null;
}

/** 슈퍼유저로 직접 시드 (RLS 무시) */
export async function seedUsers(db: Pick<PGlite, "query">, users: SeedUser[]): Promise<void> {
  for (const u of users) {
    const score = u.score === undefined ? 1000 : u.score;
    const track = u.track ?? (score !== null && score < 0 ? "science" : "humanities");
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [u.id, `${u.id}@korea.ac.kr`]);
    const active = u.isActive ?? true;
    await db.query(
      `insert into public.profiles (id, nickname, track, is_public, status, deleted_at, photo_path)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [u.id, `user-${u.id.slice(-4)}`, track, u.isPublic ?? true, active ? "active" : "deleted",
        active ? null : new Date(), u.photoPath ?? null],
    );
    if (score !== null) {
      await db.query(
        `insert into public.fortune_results (user_id, base_number, score, score_version, fortune, program_version)
         values ($1, $2, $3, 1, '{"summary":"test"}', 'mock-1')`,
        [u.id, Math.abs(score), score],
      );
      await db.query(`insert into public.private_birth_data (user_id, birth_date) values ($1, '2003-05-17')`, [u.id]);
    }
  }
}

export interface Recommendation {
  id: string;
  target_id: string;
  rank: number;
  distance: number;
}

/** 서버가 GET /api/match-results 에서 하는 일 */
export async function recommend(t: TestDb, user: string): Promise<Recommendation[]> {
  const r = await t.asService((q) =>
    q.query<Recommendation>(`select id, target_id, rank, distance from public.get_or_create_match_results($1)`, [user]),
  );
  return r.rows;
}

/** C 의 createOrder 가 하는 일 (추천 결과 → 상대 1명 주문) */
export async function createOrder(
  t: TestDb,
  buyer: string,
  rec: Pick<Recommendation, "id" | "target_id">,
  status: "pending" | "fulfilled" = "pending",
): Promise<{ id: string; reference: string }> {
  const r = await t.asService((q) =>
    q.query<{ id: string; reference: string }>(
      `insert into public.orders (buyer_id, target_id, match_result_id, status)
       values ($1, $2, $3, $4) returning id, reference`,
      [buyer, rec.target_id, rec.id, status],
    ),
  );
  return r.rows[0]!;
}

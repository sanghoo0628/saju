import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { getServerEnv } from '@/lib/env/server';
import { assertSameOrigin, json, readJson } from '@/lib/http/api';
import { parseUpdateProfile } from '@/server/matching-service';
import { getMatchingService, matchingApiHandler } from '@/server/matching-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  return matchingApiHandler(async () => {
    const { user } = await requireVerifiedSchoolUser();
    return json(await getMatchingService().myProfile(user.id));
  });
}
export async function PUT(request: Request) {
  return matchingApiHandler(async () => {
    assertSameOrigin(request, getServerEnv().NEXT_PUBLIC_APP_URL);
    const { user } = await requireVerifiedSchoolUser();
    const input = parseUpdateProfile(await readJson(request), user.id);
    return json(await getMatchingService().updateProfile(user.id, input));
  });
}

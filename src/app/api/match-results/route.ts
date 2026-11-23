import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { json } from '@/lib/http/api';
import { getMatchingService, matchingApiHandler } from '@/server/matching-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  return matchingApiHandler(async () => {
    const { user } = await requireVerifiedSchoolUser();
    return json(await getMatchingService().matchResults(user.id));
  });
}

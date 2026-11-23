import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { readVerifiedUser } from './identity';

export async function getCurrentUserId(): Promise<string | null> {
  // Missing/invalid configuration deliberately throws; route boundary translates to 503.
  const supabase = await createClient();
  const user = await readVerifiedUser(supabase.auth);
  return user?.id ?? null;
}

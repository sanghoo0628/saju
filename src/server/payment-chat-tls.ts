import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import { ConfigurationError } from '@/lib/env/schema';

export function paymentChatTls(connectionString: string, caPath?: string): PoolConfig['ssl'] {
  const host = new URL(connectionString).hostname.toLowerCase();
  const supabase = host.endsWith('.pooler.supabase.com') || host.endsWith('.supabase.co');
  if (supabase && !caPath) throw new ConfigurationError(['DATABASE_SSL_CA_PATH']);
  return { rejectUnauthorized: true, ...(caPath ? { ca: readFileSync(caPath, 'utf8') } : {}) };
}

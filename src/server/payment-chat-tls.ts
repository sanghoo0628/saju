import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import type { PoolConfig } from 'pg';
import { ConfigurationError } from '@/lib/env/schema';

export function paymentChatTls(connectionString: string, caPath?: string, caPem?: string): PoolConfig['ssl'] {
  const host = new URL(connectionString).hostname.toLowerCase();
  const supabase = host.endsWith('.pooler.supabase.com') || host.endsWith('.supabase.co');
  if (caPem?.trim()) {
    const ca = caPem.replace(/\\n/g, '\n').trim();
    try { if (!new X509Certificate(ca).ca) throw new Error(); }
    catch { throw new ConfigurationError(['DATABASE_SSL_CA_PEM']); }
    return { rejectUnauthorized: true, ca };
  }
  if (supabase && !caPath) throw new ConfigurationError(['DATABASE_SSL_CA_PATH/DATABASE_SSL_CA_PEM']);
  return { rejectUnauthorized: true, ...(caPath ? { ca: readFileSync(caPath, 'utf8') } : {}) };
}

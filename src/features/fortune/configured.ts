import 'server-only';
import { randomBytes } from 'node:crypto';
import { getServerEnv } from '@/lib/env/server';
import { createHrumFortuneProvider } from './providers/hrum';
import { createMockFortuneProvider } from './providers/mock';
import { createUnconfiguredFortuneProvider } from './providers/unconfigured';
import { MemoryFortuneCache } from './cache';
import type { FortuneProvider } from './types';

const processSecret = randomBytes(32).toString('hex');
const cache = new MemoryFortuneCache();
const mock = createMockFortuneProvider();
const unconfigured = createUnconfiguredFortuneProvider();
let hrum: { key: string; provider: FortuneProvider } | undefined;

export function getFortunePublicConfiguration() {
  const env = getServerEnv();
  return {
    provider: env.SAJU_PROVIDER,
    configured: env.SAJU_PROVIDER === 'mock' || (env.SAJU_PROVIDER === 'hrum' && !!env.SAJU_API_KEY && !!env.SAJU_FINGERPRINT_SECRET),
  };
}

// Provider/cache singletons contain no auth session. Cache keys include verified owner UUID.
export function getFortuneServiceOptions(userId: string) {
  const env = getServerEnv();
  let provider = unconfigured;
  if (env.APP_ENV !== 'production' && env.SAJU_PROVIDER === 'mock') provider = mock;
  else if (env.SAJU_PROVIDER === 'hrum' && env.SAJU_API_KEY && env.SAJU_FINGERPRINT_SECRET) {
    if (!hrum || hrum.key !== env.SAJU_API_KEY) hrum = { key: env.SAJU_API_KEY, provider: createHrumFortuneProvider({apiKey:env.SAJU_API_KEY}) };
    provider = hrum.provider;
  }
  return {userId, provider, cache, fingerprintSecret:env.SAJU_FINGERPRINT_SECRET ?? processSecret};
}

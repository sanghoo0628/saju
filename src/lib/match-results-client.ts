import type { MatchResultsResponse } from '@/contracts/matching';
import { createBrowserRequest } from '../../packages/payment-chat/src/client';

/** Free recommendations use the same deadline/cancellation as payment and chat reads. */
export function loadMatchResults(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  options: Parameters<typeof createBrowserRequest>[1] = {},
): Promise<MatchResultsResponse> {
  return createBrowserRequest(fetcher, options)<MatchResultsResponse>('/api/match-results', undefined, signal);
}

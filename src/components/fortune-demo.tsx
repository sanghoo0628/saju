'use client';

import { useEffect, useState } from 'react';
import type { FortuneResult } from '@/features/fortune/types';
import { FortuneResultView } from './fortune-result';

export function FortuneDemo() {
  const [result, setResult] = useState<FortuneResult | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/fortune/demo', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => { if (!response.ok) throw new Error('Unavailable'); return response.json() as Promise<FortuneResult>; })
      .then(setResult)
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [retry]);
  if (error) return <div className="feedback error" role="alert"><p>샘플을 불러오지 못했어요.</p><button type="button" className="button secondary" onClick={() => { setError(false); setRetry((value) => value + 1); }}>다시 시도하기</button></div>;
  if (!result) return <p className="loading-state" role="status"><span className="loading-dot" />샘플을 불러오고 있어요.</p>;
  return <FortuneResultView result={result} />;
}

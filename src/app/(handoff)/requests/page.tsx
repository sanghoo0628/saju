import { CampusChatPage } from '@/components/campus-chat-page';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ request?: string | string[] }> }) {
  const { request } = await searchParams;
  const initialRequestId = typeof request === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(request) ? request : undefined;
  return <CampusChatPage view="requests" initialRequestId={initialRequestId} />;
}

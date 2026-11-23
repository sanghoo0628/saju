import { CampusChatPage } from '@/components/campus-chat-page';
export const dynamic = 'force-dynamic';
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  const { room } = await searchParams;
  return <CampusChatPage view="chat" initialRoomId={typeof room === 'string' ? room : undefined} />;
}

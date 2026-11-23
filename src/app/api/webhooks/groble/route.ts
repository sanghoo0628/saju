import { handlePaymentChatRequest } from '@/server/payment-chat-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = handlePaymentChatRequest;

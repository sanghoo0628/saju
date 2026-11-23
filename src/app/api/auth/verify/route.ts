import { handleOtp } from '@/lib/auth/otp';
export async function POST(request: Request) { return handleOtp(request, 'verify'); }

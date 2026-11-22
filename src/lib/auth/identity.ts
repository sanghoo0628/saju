import { z } from 'zod';

export interface VerifiedUser {
  id: string;
  email?: string;
  email_confirmed_at?: string;
  is_anonymous?: boolean;
}
export interface UserAuthReader {
  getUser(): Promise<{ data: { user: VerifiedUser | null }; error: unknown }>;
}

// Input must come from the Auth server, never a body/header/user_metadata claim.
export async function readVerifiedUser(auth: UserAuthReader): Promise<VerifiedUser | null> {
  try {
    const { data, error } = await auth.getUser();
    if (error || !data.user || data.user.is_anonymous || !z.uuid().safeParse(data.user.id).success) return null;
    return data.user;
  } catch { return null; }
}

export function getSchoolVerification(user: VerifiedUser, allowedDomainText: string) {
  const domains = allowedDomainText.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length) return { status: 'not_configured' as const };
  if (!user.email_confirmed_at) return { status: 'email_unverified' as const };
  if (!user.email || !isAllowedSchoolEmail(user.email, domains)) return { status: 'domain_not_allowed' as const };
  return { status: 'verified' as const };
}

export function isAllowedSchoolEmail(email: string, domains: string[]) {
  const parsed = z.email().safeParse(email);
  if (!parsed.success) return false;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  // Exact domains only. student.example.edu.evil and implicit subdomains are rejected.
  return domains.some(d => d.trim().toLowerCase() === domain);
}

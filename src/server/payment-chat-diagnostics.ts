/** Log only explicit diagnostic identifiers; never messages, URLs, payloads or arbitrary properties. */
const NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ConfigurationError', 'DatabaseError']);
const CODES = new Set([
  '23505', '23503', '23514', '23502', '42501', '40001', '40P01', '57014', '55P03', '53300', '08006',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENOENT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
]);

export function logPaymentChatError(
  phase: 'runtime' | 'request',
  error: unknown,
  write: (entry: { event: string; phase: string; name: string; code: string }) => void = console.error,
) {
  let name = 'UnknownError', code = 'UNREPORTED';
  try {
    if (error && typeof error === 'object') {
      const value = error as { name?: unknown; code?: unknown };
      const constructorName = Object.getPrototypeOf(error)?.constructor?.name;
      if (typeof constructorName === 'string' && NAMES.has(constructorName)) name = constructorName;
      else if (typeof value.name === 'string' && NAMES.has(value.name)) name = value.name;
      if (typeof value.code === 'string' && CODES.has(value.code)) code = value.code;
      else if (name === 'ConfigurationError') code = 'CONFIGURATION_ERROR';
    }
  } catch { /* Defensive against throwing property accessors. */ }
  try { write({ event: 'payment_chat_unexpected_error', phase, name, code }); } catch { /* Logging cannot break requests. */ }
}

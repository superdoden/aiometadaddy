import { timingSafeEqual } from 'crypto';

const { hasPermission } = require('../authSession');

/** The same test the dashboard's admin routes apply: the admin permission, or the admin key. */
export function isDashboardAdmin(req: any): boolean {
  try {
    if (hasPermission(req, 'admin')) return true;
  } catch {
    // No session support on this request; fall through to the key.
  }
  const adminKey = process.env.ADMIN_KEY;
  const supplied = req?.headers?.['x-admin-key'];
  if (!adminKey || typeof supplied !== 'string') return false;
  const a = Buffer.from(adminKey);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

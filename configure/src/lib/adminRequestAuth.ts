/**
 * Jellyfin admin (fork): while the dashboard edits a configuration, requests the
 * configuration page would sign with its password carry the admin key instead.
 * Signed in through the identity provider, the session cookie already does.
 */
let adminKey: string | null = null;

export function setRequestAdminKey(key: string | null): void {
  adminKey = key;
}

export function adminAuthHeaders(): Record<string, string> {
  return adminKey ? { 'x-admin-key': adminKey } : {};
}

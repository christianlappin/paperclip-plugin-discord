/**
 * Company-scoped secret reference handling (Paperclip >= 2026.720.0).
 *
 * Paperclip's plugin secret model (upstream #5429 / #6057 / #9557) requires
 * config secret refs to be the shared object shape
 * `{ type: "secret_ref", secretId, version? }` and resolution to carry an
 * active companyId. Bare secret-UUID strings are rejected by the host at
 * config-save time (HTTP 422) and at resolve time.
 *
 * Legacy configs saved by plugin <= 0.9.x store bare UUID strings. Those rows
 * remain in the database after a host upgrade, so we normalize them to the
 * object shape at resolve time for a graceful migration. The binding row the
 * host requires (`company_secret_bindings`) is only created when config is
 * re-saved through the API/UI — resolution of a normalized legacy ref fails
 * with `binding_missing` until then, and the health message says so.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SecretRefBinding = {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
};

/** Object ref, or a legacy bare-UUID string from a pre-1.0 config row. */
export type SecretRefConfig = SecretRefBinding | string;

export function isSecretRefBinding(value: unknown): value is SecretRefBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.type === "secret_ref" && typeof v.secretId === "string" && UUID_RE.test(v.secretId);
}

export function isLegacyUuidRef(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * Normalize a configured secret ref to the object shape the host requires.
 * Returns null when the value is neither an object ref nor a legacy UUID.
 */
export function normalizeSecretRef(value: unknown): SecretRefBinding | null {
  if (isSecretRefBinding(value)) return value;
  if (isLegacyUuidRef(value)) {
    return { type: "secret_ref", secretId: value.trim(), version: "latest" };
  }
  return null;
}

/** True when a config value is present enough to attempt resolution. */
export function hasSecretRef(value: unknown): boolean {
  return normalizeSecretRef(value) !== null;
}

/**
 * A companyId usable for secret resolution must be a real company UUID —
 * the host rejects non-UUID values, and resolveCompanyId()'s legacy
 * "default" fallback would fail the binding lookup with a confusing error.
 */
export function isResolvableCompanyId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Lazy company-ID resolver — avoids startup-time API calls that can crash
 * worker activation. The resolved value is cached after the first successful call.
 *
 * Multi-company fix: check `company_default` instance state (written by
 * `/clip connect`) before falling back to list-based resolution. The
 * connected company is NOT cached so that `/clip connect` changes take effect
 * immediately without restarting the plugin.
 */
let _cachedCompanyId: string | null = null;

export async function resolveCompanyId(ctx: PluginContext): Promise<string> {
  // Check if a guild-level default was set via /clip connect — always re-read
  // so that switching companies works without a plugin restart.
  try {
    const connected = (await ctx.state.get({ scopeKind: "instance", stateKey: "company_default" })) as { companyId?: string } | null | undefined;
    if (connected?.companyId) {
      return connected.companyId;
    }
  } catch {
    // state API unavailable at this call site — fall through to list-based resolution
  }

  if (_cachedCompanyId) return _cachedCompanyId;
  try {
    const companies = await ctx.companies.list({ limit: 1 });
    if (companies.length > 0) {
      _cachedCompanyId = companies[0].id;
      return _cachedCompanyId;
    }
  } catch (err) {
    ctx.logger.warn("Failed to resolve company ID, falling back to 'default'", { error: String(err) });
  }
  return "default";
}

/** Reset cached company ID (for testing). */
export function _resetCompanyIdCache(): void {
  _cachedCompanyId = null;
}

const COMPANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when the id is a real company UUID rather than the legacy "default"
 * sentinel. On Paperclip >= 2026.720.0 company-scoped host calls (state,
 * secrets) reject anything that is not the invocation's actual company.
 */
export function isRealCompanyId(id: string | null | undefined): id is string {
  return !!id && COMPANY_UUID_RE.test(id);
}

/**
 * Company id usable for secret resolution (Paperclip >= 2026.720.0): must be
 * a real company UUID. Returns null instead of the legacy "default" fallback
 * so callers surface a clear health message rather than a confusing
 * binding_missing error from the host.
 */
export async function resolveCompanyIdForSecrets(ctx: PluginContext): Promise<string | null> {
  const id = await resolveCompanyId(ctx);
  return isRealCompanyId(id) ? id : null;
}

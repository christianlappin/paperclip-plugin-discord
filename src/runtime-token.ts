import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";
import {
  isResolvableCompanyId,
  normalizeSecretRef,
} from "./secret-ref.js";

export type DiscordRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-discord/issues/61";

export const SECRET_REF_INVALID_MESSAGE =
  "discordBotTokenRef is not a valid secret reference — expected { type: \"secret_ref\", secretId } or a legacy secret UUID";
export const COMPANY_SCOPE_MISSING_MESSAGE =
  "No company scope available for secret resolution — the host denied or could not derive an active company";
export const BINDING_MISSING_MESSAGE =
  "Secret is not bound to this plugin for the active company — re-save the plugin config so the host creates the secret binding";

/**
 * Resolve a configured secret ref with company scope (Paperclip >= 2026.720.0).
 * Returns undefined on failure and reports health instead of throwing, so
 * activation survives and operators can read the cause. See issue #61.
 */
export async function resolveCompanyScopedSecret(
  ctx: PluginContext,
  configuredRef: unknown,
  opts: {
    companyId: string | null;
    configPath: string;
    setHealth?: (health: DiscordRuntimeHealth) => void;
  },
): Promise<string | undefined> {
  const setHealth = opts.setHealth ?? (() => {});
  const ref = normalizeSecretRef(configuredRef);
  if (!ref) {
    setHealth({
      status: "degraded",
      message: SECRET_REF_INVALID_MESSAGE,
      details: { configPath: opts.configPath, reference: SECRET_RESOLUTION_ISSUE_URL },
    });
    ctx.logger.error("Discord plugin secret ref is invalid", {
      configPath: opts.configPath,
    });
    return undefined;
  }

  if (!isResolvableCompanyId(opts.companyId)) {
    setHealth({
      status: "degraded",
      message: COMPANY_SCOPE_MISSING_MESSAGE,
      details: { configPath: opts.configPath, reference: SECRET_RESOLUTION_ISSUE_URL },
    });
    ctx.logger.error("Discord plugin has no resolvable companyId for secret resolution", {
      configPath: opts.configPath,
    });
    return undefined;
  }

  try {
    // SDK >= 2026.720.0: options carry company scope + config path.
    const value = await ctx.secrets.resolve(ref, {
      companyId: opts.companyId,
      configPath: opts.configPath,
    });
    setHealth({ status: "ok" });
    return value;
  } catch (err) {
    const error = String(err);
    const bindingMissing = /binding_missing|not bound/i.test(error);
    setHealth({
      status: "degraded",
      message: bindingMissing ? BINDING_MISSING_MESSAGE : `Secret resolution failed: ${error}`,
      details: {
        configPath: opts.configPath,
        companyId: opts.companyId,
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    });
    ctx.logger.error("Discord plugin cannot resolve secret; dependent features are disabled", {
      error,
      configPath: opts.configPath,
      reference: SECRET_RESOLUTION_ISSUE_URL,
    });
    return undefined;
  }
}

/** Startup bot-token resolution — thin wrapper kept for worker readability. */
export async function resolveStartupDiscordBotToken(
  ctx: PluginContext,
  tokenRef: unknown,
  companyId: string | null,
  setHealth: (health: DiscordRuntimeHealth) => void,
): Promise<string | undefined> {
  return resolveCompanyScopedSecret(ctx, tokenRef, {
    companyId,
    configPath: "discordBotTokenRef",
    setHealth,
  });
}

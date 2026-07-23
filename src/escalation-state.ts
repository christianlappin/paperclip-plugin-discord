import type { PluginContext } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationRecord {
  escalationId: string;
  companyId: string;
  agentName: string;
  reason: string;
  confidenceScore?: number;
  agentReasoning?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  suggestedReply?: string;
  channelId: string;
  messageId: string;
  status: "pending" | "resolved" | "timed_out";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

// ---------------------------------------------------------------------------
// State helpers — strictly company-scoped (Paperclip >= 2026.720.0)
//
// The 720 host rejects company-scoped state access for any company other than
// the one the current invocation is scoped to, so scope "default" is never
// accessible from a company-scoped invocation. Callers must pass the real
// company UUID (see resolveCompanyId in company-resolver.ts).
// ---------------------------------------------------------------------------

export async function getEscalation(
  ctx: PluginContext,
  escalationId: string,
  escalationCompanyId: string,
): Promise<EscalationRecord | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: escalationCompanyId,
    stateKey: `escalation_${escalationId}`,
  });
  return (raw as EscalationRecord) ?? null;
}

export async function saveEscalation(ctx: PluginContext, record: EscalationRecord): Promise<void> {
  if (!record.companyId) {
    throw new Error(
      `Cannot save escalation ${record.escalationId}: record.companyId is required for company-scoped state`,
    );
  }
  await ctx.state.set(
    { scopeKind: "company", scopeId: record.companyId, stateKey: `escalation_${record.escalationId}` },
    record,
  );
}

export async function trackPendingEscalation(
  ctx: PluginContext,
  escalationId: string,
  escalationCompanyId: string,
): Promise<void> {
  const key = "escalation_pending_ids";
  const raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
  const ids = (raw as string[]) ?? [];
  if (!ids.includes(escalationId)) {
    ids.push(escalationId);
    await ctx.state.set(
      { scopeKind: "company", scopeId: escalationCompanyId, stateKey: key },
      ids,
    );
  }
}

export async function untrackPendingEscalation(
  ctx: PluginContext,
  escalationId: string,
  escalationCompanyId: string,
): Promise<void> {
  const key = "escalation_pending_ids";
  const raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
  const ids = (raw as string[]) ?? [];
  const filtered = ids.filter((id) => id !== escalationId);
  await ctx.state.set(
    { scopeKind: "company", scopeId: escalationCompanyId, stateKey: key },
    filtered,
  );
}

/** Pending escalation IDs for the invocation's company scope. */
export async function collectPendingEscalationIds(
  ctx: PluginContext,
  companyId: string,
): Promise<string[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "escalation_pending_ids",
  });
  return (raw as string[]) ?? [];
}

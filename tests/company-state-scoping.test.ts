import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getThreadSessions,
  handleAcpOutput,
  type AgentSessionEntry,
  type TransportKind,
} from "../src/session-registry.js";
import {
  type EscalationRecord,
  getEscalation,
  saveEscalation,
  trackPendingEscalation,
  untrackPendingEscalation,
  collectPendingEscalationIds,
} from "../src/escalation-state.js";

// ---------------------------------------------------------------------------
// Scope-aware state mock
// ---------------------------------------------------------------------------

/** Keys like "company:comp-1:sessions_thread-1" */
function scopedKey(scopeId: string, stateKey: string): string {
  return `company:${scopeId}:${stateKey}`;
}

const stateStore = new Map<string, unknown>();

function makeScopedCtx(overrides: Record<string, unknown> = {}) {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "sess-new" }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn().mockImplementation(({ scopeId, stateKey }: { scopeId: string; stateKey: string }) => {
        return Promise.resolve(stateStore.get(scopedKey(scopeId, stateKey)) ?? null);
      }),
      set: vi.fn().mockImplementation(({ scopeId, stateKey }: { scopeId: string; stateKey: string }, value: unknown) => {
        if (value === null) {
          stateStore.delete(scopedKey(scopeId, stateKey));
        } else {
          stateStore.set(scopedKey(scopeId, stateKey), value);
        }
        return Promise.resolve(undefined);
      }),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "thread-1" }),
        text: () => Promise.resolve(""),
      }),
    },
    events: { emit: vi.fn(), on: vi.fn() },
    ...overrides,
  } as any;
}

function makeSession(overrides: Partial<AgentSessionEntry> = {}): AgentSessionEntry {
  return {
    sessionId: "sess-1",
    agentId: "agent-1",
    agentName: "CodeBot",
    agentDisplayName: "CodeBot",
    companyId: "comp-1",
    transport: "native" as TransportKind,
    spawnedAt: "2026-03-15T12:00:00Z",
    status: "running",
    lastActivityAt: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

function makeEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    escalationId: "esc-1",
    companyId: "comp-1",
    agentName: "SupportBot",
    reason: "Customer needs human help",
    channelId: "ch-1",
    messageId: "msg-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Simulates Paperclip >= 2026.720.0 host enforcement: any company-scoped
 * state access for a company other than the invocation's throws.
 */
function makeStrictCtx(invocationCompanyId: string) {
  const base = makeScopedCtx();
  const guard = (op: string, ref: { scopeKind?: string; scopeId: string }) => {
    if ((ref.scopeKind ?? "company") === "company" && ref.scopeId !== invocationCompanyId) {
      throw new Error(
        `Plugin "test" is not allowed to perform "${op}": requested company "${ref.scopeId}" ` +
          `but the current invocation is scoped to company "${invocationCompanyId}"`,
      );
    }
  };
  const innerGet = base.state.get;
  const innerSet = base.state.set;
  base.state.get = vi.fn().mockImplementation((ref: any) => {
    guard("state.get", ref);
    return innerGet(ref);
  });
  base.state.set = vi.fn().mockImplementation((ref: any, value: unknown) => {
    guard("state.set", ref);
    return innerSet(ref, value);
  });
  return base;
}

/** Number of state.get/state.set calls that touched the legacy "default" scope. */
function defaultScopeCalls(ctx: any): number {
  return [...ctx.state.get.mock.calls, ...ctx.state.set.mock.calls].filter(
    (c: any[]) => c[0]?.scopeId === "default",
  ).length;
}

// ---------------------------------------------------------------------------
// Tests: company-aware state scoping
// ---------------------------------------------------------------------------

describe("company-aware state scoping", () => {
  let ctx: ReturnType<typeof makeScopedCtx>;

  beforeEach(() => {
    ctx = makeScopedCtx();
  });

  describe("getThreadSessions", () => {
    it("reads from company-scoped key when companyId is provided", async () => {
      const threadId = "thread-1";
      const sessions = [makeSession()];
      stateStore.set(scopedKey("comp-1", `sessions_${threadId}`), { sessions });

      const result = await getThreadSessions(ctx, threadId, "comp-1");
      expect(result).toHaveLength(1);
      expect(result[0].agentName).toBe("CodeBot");
    });

    it("falls back to 'default' scope when company-scoped read returns null", async () => {
      const threadId = "thread-1";
      const sessions = [makeSession({ companyId: "default" })];
      // Only stored under "default" scope (legacy data)
      stateStore.set(scopedKey("default", `sessions_${threadId}`), { sessions });

      const result = await getThreadSessions(ctx, threadId, "comp-1");
      expect(result).toHaveLength(1);
      expect(result[0].companyId).toBe("default");
    });

    it("returns empty array when neither scope has data", async () => {
      const result = await getThreadSessions(ctx, "thread-nonexistent", "comp-1");
      expect(result).toEqual([]);
    });

    it("reads from 'default' scope when companyId is omitted", async () => {
      const threadId = "thread-1";
      const sessions = [makeSession({ companyId: "default" })];
      stateStore.set(scopedKey("default", `sessions_${threadId}`), { sessions });

      const result = await getThreadSessions(ctx, threadId);
      expect(result).toHaveLength(1);
    });

    it("prefers company-scoped data over legacy default-scoped data", async () => {
      const threadId = "thread-1";
      const legacySessions = [makeSession({ companyId: "default", agentName: "LegacyBot" })];
      const companySessions = [makeSession({ companyId: "comp-1", agentName: "NewBot" })];

      stateStore.set(scopedKey("default", `sessions_${threadId}`), { sessions: legacySessions });
      stateStore.set(scopedKey("comp-1", `sessions_${threadId}`), { sessions: companySessions });

      const result = await getThreadSessions(ctx, threadId, "comp-1");
      expect(result).toHaveLength(1);
      expect(result[0].agentName).toBe("NewBot");
    });
  });

  describe("handleAcpOutput with companyId", () => {
    it("writes session state under company scope when companyId is provided", async () => {
      const event = {
        sessionId: "sess-acp-1",
        threadId: "thread-1",
        agentName: "AcpBot",
        output: "Hello",
        companyId: "comp-1",
      };

      await handleAcpOutput(ctx, "bot-token", event);

      // Should have written under company scope
      const stored = stateStore.get(scopedKey("comp-1", "sessions_thread-1")) as { sessions: AgentSessionEntry[] };
      expect(stored).toBeDefined();
      expect(stored.sessions).toHaveLength(1);
      expect(stored.sessions[0].agentName).toBe("AcpBot");
      expect(stored.sessions[0].companyId).toBe("comp-1");
    });

    it("uses 'default' scope when companyId is not provided", async () => {
      const event = {
        sessionId: "sess-acp-2",
        threadId: "thread-2",
        agentName: "AcpBot",
        output: "Hello",
      };

      await handleAcpOutput(ctx, "bot-token", event);

      const stored = stateStore.get(scopedKey("default", "sessions_thread-2")) as { sessions: AgentSessionEntry[] };
      expect(stored).toBeDefined();
      expect(stored.sessions).toHaveLength(1);
      expect(stored.sessions[0].companyId).toBe("default");
    });
  });

  describe("multi-company isolation", () => {
    it("keeps sessions from different companies separate", async () => {
      const threadId = "shared-thread";
      const sessionsA = [makeSession({ sessionId: "sess-a", companyId: "company-a", agentName: "BotA" })];
      const sessionsB = [makeSession({ sessionId: "sess-b", companyId: "company-b", agentName: "BotB" })];

      stateStore.set(scopedKey("company-a", `sessions_${threadId}`), { sessions: sessionsA });
      stateStore.set(scopedKey("company-b", `sessions_${threadId}`), { sessions: sessionsB });

      const resultA = await getThreadSessions(ctx, threadId, "company-a");
      const resultB = await getThreadSessions(ctx, threadId, "company-b");

      expect(resultA).toHaveLength(1);
      expect(resultA[0].agentName).toBe("BotA");
      expect(resultB).toHaveLength(1);
      expect(resultB[0].agentName).toBe("BotB");
    });
  });

  // =========================================================================
  // Escalation state scoping
  // =========================================================================

  describe("getEscalation", () => {
    it("reads from company-scoped key when companyId is provided", async () => {
      const record = makeEscalation();
      stateStore.set(scopedKey("comp-1", "escalation_esc-1"), record);

      const result = await getEscalation(ctx, "esc-1", "comp-1");
      expect(result).toEqual(record);
    });

    it("does not fall back to the legacy 'default' scope", async () => {
      // Legacy record exists only under "default" — must NOT be returned,
      // and the "default" scope must never be touched (720 host rejects it).
      stateStore.set(scopedKey("default", "escalation_esc-1"), makeEscalation({ companyId: "default" }));

      const result = await getEscalation(ctx, "esc-1", "comp-1");
      expect(result).toBeNull();
      expect(ctx.state.get).toHaveBeenCalledTimes(1);
      expect(defaultScopeCalls(ctx)).toBe(0);
    });

    it("returns null when the company scope has no record", async () => {
      const result = await getEscalation(ctx, "esc-nonexistent", "comp-1");
      expect(result).toBeNull();
    });

    it("succeeds under 720-style company-scope enforcement", async () => {
      const strictCtx = makeStrictCtx("comp-1");
      const record = makeEscalation();
      stateStore.set(scopedKey("comp-1", "escalation_esc-1"), record);

      const result = await getEscalation(strictCtx, "esc-1", "comp-1");
      expect(result).toEqual(record);
    });
  });

  describe("saveEscalation", () => {
    it("writes under company scope when companyId is present", async () => {
      const record = makeEscalation({ companyId: "comp-1" });

      await saveEscalation(ctx, record);

      const stored = stateStore.get(scopedKey("comp-1", "escalation_esc-1"));
      expect(stored).toEqual(record);
      // Should NOT exist under "default" scope
      expect(stateStore.get(scopedKey("default", "escalation_esc-1"))).toBeUndefined();
    });

    it("throws when companyId is empty instead of writing to 'default'", async () => {
      const record = makeEscalation({ companyId: "" });

      await expect(saveEscalation(ctx, record)).rejects.toThrow(/companyId is required/);
      expect(ctx.state.set).not.toHaveBeenCalled();
    });
  });

  describe("trackPendingEscalation", () => {
    it("adds escalation id to company-scoped pending list", async () => {
      await trackPendingEscalation(ctx, "esc-1", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });

    it("does not duplicate escalation ids", async () => {
      await trackPendingEscalation(ctx, "esc-1", "comp-1");
      await trackPendingEscalation(ctx, "esc-1", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });

    it("appends to existing pending list", async () => {
      await trackPendingEscalation(ctx, "esc-1", "comp-1");
      await trackPendingEscalation(ctx, "esc-2", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1", "esc-2"]);
    });

    it("never reads the legacy 'default' scope", async () => {
      // Legacy data exists under "default" scope — must be ignored entirely.
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-legacy"]);

      await trackPendingEscalation(ctx, "esc-new", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-new"]);
      expect(defaultScopeCalls(ctx)).toBe(0);
    });
  });

  describe("untrackPendingEscalation", () => {
    it("removes escalation id from company-scoped pending list", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1", "esc-2"]);

      await untrackPendingEscalation(ctx, "esc-1", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-2"]);
    });

    it("handles removal of non-existent id gracefully", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1"]);

      await untrackPendingEscalation(ctx, "esc-nonexistent", "comp-1");

      const stored = stateStore.get(scopedKey("comp-1", "escalation_pending_ids")) as string[];
      expect(stored).toEqual(["esc-1"]);
    });

    it("ignores the legacy 'default'-scoped list", async () => {
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-1", "esc-2"]);

      await untrackPendingEscalation(ctx, "esc-1", "comp-1");

      // Legacy list untouched; company scope gets an empty list.
      expect(stateStore.get(scopedKey("default", "escalation_pending_ids"))).toEqual(["esc-1", "esc-2"]);
      expect(stateStore.get(scopedKey("comp-1", "escalation_pending_ids"))).toEqual([]);
      expect(defaultScopeCalls(ctx)).toBe(0);
    });
  });

  describe("collectPendingEscalationIds", () => {
    it("reads only the given company scope, never 'default'", async () => {
      stateStore.set(scopedKey("comp-1", "escalation_pending_ids"), ["esc-1", "esc-2"]);
      stateStore.set(scopedKey("default", "escalation_pending_ids"), ["esc-legacy"]);

      const ids = await collectPendingEscalationIds(ctx, "comp-1");
      expect(ids).toEqual(["esc-1", "esc-2"]);
      expect(ctx.state.get).toHaveBeenCalledTimes(1);
      expect(defaultScopeCalls(ctx)).toBe(0);
    });

    it("returns empty array when no pending ids exist", async () => {
      const ids = await collectPendingEscalationIds(ctx, "comp-1");
      expect(ids).toEqual([]);
    });

    it("supports the full pending lifecycle under 720-style enforcement", async () => {
      const strictCtx = makeStrictCtx("comp-1");
      const record = makeEscalation({ companyId: "comp-1" });

      await saveEscalation(strictCtx, record);
      await trackPendingEscalation(strictCtx, record.escalationId, "comp-1");

      expect(await collectPendingEscalationIds(strictCtx, "comp-1")).toEqual(["esc-1"]);
      expect(await getEscalation(strictCtx, "esc-1", "comp-1")).toEqual(record);

      await untrackPendingEscalation(strictCtx, "esc-1", "comp-1");
      expect(await collectPendingEscalationIds(strictCtx, "comp-1")).toEqual([]);
    });
  });

  describe("escalation multi-company isolation", () => {
    it("keeps escalation records from different companies separate", async () => {
      const recordA = makeEscalation({ escalationId: "esc-a", companyId: "company-a", agentName: "BotA" });
      const recordB = makeEscalation({ escalationId: "esc-b", companyId: "company-b", agentName: "BotB" });

      await saveEscalation(ctx, recordA);
      await saveEscalation(ctx, recordB);

      const resultA = await getEscalation(ctx, "esc-a", "company-a");
      const resultB = await getEscalation(ctx, "esc-b", "company-b");

      expect(resultA!.agentName).toBe("BotA");
      expect(resultB!.agentName).toBe("BotB");

      // Cross-company reads should not find the other company's records
      const crossRead = await getEscalation(ctx, "esc-a", "company-b");
      expect(crossRead).toBeNull();
    });

    it("keeps pending lists from different companies separate", async () => {
      await trackPendingEscalation(ctx, "esc-a", "company-a");
      await trackPendingEscalation(ctx, "esc-b", "company-b");

      const idsA = stateStore.get(scopedKey("company-a", "escalation_pending_ids")) as string[];
      const idsB = stateStore.get(scopedKey("company-b", "escalation_pending_ids")) as string[];

      expect(idsA).toEqual(["esc-a"]);
      expect(idsB).toEqual(["esc-b"]);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import manifest from "../src/manifest.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

// ---------------------------------------------------------------------------
// The bug: job handlers were registered inside config-conditional blocks,
// so when a feature flag was off the runtime had no handler for the job key
// declared in the manifest — causing a crash at runtime.
//
// These tests verify that every jobKey in the manifest receives a registered
// handler regardless of the config values passed to setup().
// ---------------------------------------------------------------------------

// Capture the setup function from definePlugin by mocking the SDK.
// vi.hoisted ensures the variable exists before the mock factory runs.
const { capturedSetups } = vi.hoisted(() => {
  const capturedSetups: Array<(ctx: any) => Promise<void>> = [];
  return { capturedSetups };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedSetups.push(def.setup);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

// Now import the worker — the mock intercepts definePlugin.
// This must be a static import so vitest hoists the mock before it.
import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

/**
 * Build a minimal PluginContext stub that records job registrations.
 */
function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const registeredJobs = new Map<string, Function>();

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: false,
    notifyOnIssueDone: false,
    notifyOnApprovalCreated: false,
    notifyOnAgentError: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: "http://localhost:3100",
    intelligenceRetentionDays: 30,
    escalationChannelId: "",
    enableEscalations: false,
    escalationTimeoutMinutes: 30,
    maxAgentsPerThread: 5,
    enableMediaPipeline: false,
    mediaChannelIds: [],
    enableCustomCommands: false,
    enableProactiveSuggestions: false,
    proactiveScanIntervalMinutes: 15,
    enableCommands: false,
    enableInbound: false,
    topicRouting: false,
    digestMode: "off",
    dailyDigestTime: "09:00",
    bidailySecondTime: "17:00",
    tridailyTimes: "07:00,13:00,19:00",
    ...configOverrides,
  };

  const ctx = {
    config: { get: vi.fn().mockResolvedValue(defaultConfig) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    jobs: {
      register: vi.fn().mockImplementation((key: string, handler: Function) => {
        registeredJobs.set(key, handler);
      }),
    },
    tools: {
      register: vi.fn(),
    },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { subscribe: vi.fn(), emit: vi.fn(), on: vi.fn() },
    companies: { list: vi.fn().mockResolvedValue([{ id: "3741f9e1-0e05-4ac3-ac19-19117dd6824b", name: "Test Co" }]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: {
      fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    },
  } as any;

  return { ctx, registeredJobs };
}

/** Extract just the jobKeys from the manifest. */
const manifestJobKeys = manifest.jobs!.map((j) => j.jobKey);

async function runSetup(configOverrides: Record<string, unknown> = {}) {
  const { ctx, registeredJobs } = buildPluginContext(configOverrides);
  await getSetup()(ctx);
  return { ctx, registeredJobs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("job handler registration vs manifest", () => {
  it("manifest declares expected job keys", () => {
    expect(manifestJobKeys).toEqual(
      expect.arrayContaining([
        "discord-intelligence-scan",
        "check-escalation-timeouts",
        "check-watches",
        "discord-daily-digest",
      ]),
    );
  });

  it("registers ALL manifest job handlers when all features are DISABLED", async () => {
    const { registeredJobs } = await runSetup({
      enableProactiveSuggestions: false,
      enableIntelligence: false,
      intelligenceChannelIds: [],
      digestMode: "off",
      enableEscalations: false,
    });

    for (const jobKey of manifestJobKeys) {
      expect(registeredJobs.has(jobKey), `Missing handler for job "${jobKey}"`).toBe(true);
    }
  });

  it("registers ALL manifest job handlers when all features are ENABLED", async () => {
    const { registeredJobs } = await runSetup({
      enableProactiveSuggestions: true,
      enableIntelligence: true,
      intelligenceChannelIds: ["ch-intel"],
      digestMode: "daily",
      enableEscalations: true,
    });

    for (const jobKey of manifestJobKeys) {
      expect(registeredJobs.has(jobKey), `Missing handler for job "${jobKey}"`).toBe(true);
    }
  });

  it("check-watches handler early-returns when proactive suggestions disabled", async () => {
    const { registeredJobs, ctx } = await runSetup({
      enableProactiveSuggestions: false,
    });

    const handler = registeredJobs.get("check-watches")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("proactive suggestions disabled"),
    );
  });

  it("discord-daily-digest handler early-returns when digest mode is off", async () => {
    const { registeredJobs, ctx } = await runSetup({
      digestMode: "off",
    });

    const handler = registeredJobs.get("discord-daily-digest")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("digest mode is off"),
    );
  });

  it("logs at debug level (not info) when digest mode is off", async () => {
    const { ctx } = await runSetup({ digestMode: "off" });

    // The info log should NOT contain "Daily digest job registered"
    const infoMessages = ctx.logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoMessages).not.toContainEqual(
      expect.stringContaining("Daily digest job registered"),
    );

    // Instead, the debug log should contain the registration message
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Daily digest job registered"),
      expect.objectContaining({ mode: "off" }),
    );
  });

  it("logs at info level when digest mode is active", async () => {
    const { ctx } = await runSetup({ digestMode: "daily" });

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Daily digest job registered",
      expect.objectContaining({ mode: "daily" }),
    );
  });

  it("discord-intelligence-scan handler early-returns when intelligence disabled", async () => {
    const { registeredJobs, ctx } = await runSetup({
      enableIntelligence: false,
      intelligenceChannelIds: [],
    });

    const handler = registeredJobs.get("discord-intelligence-scan")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("intelligence disabled"),
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: Paperclip >= 2026.720.0 rejects company-scoped state access for
// any company other than the invocation's. The check-escalation-timeouts job
// used to read scope "default" as a backward-compat fallback, which failed
// every 5-minute tick with:
//   'not allowed to perform "state.get": requested company "default" but the
//    current invocation is scoped to company "<uuid>"'
// ---------------------------------------------------------------------------

describe("check-escalation-timeouts under 720 company-scope enforcement", () => {
  const REAL_CID = "3741f9e1-0e05-4ac3-ac19-19117dd6824b";

  beforeEach(() => {
    _resetCompanyIdCache();
  });

  /** State mock that enforces the invocation's company scope like the 720 host. */
  function buildEnforcedState(invocationCompanyId: string) {
    const store = new Map<string, unknown>();
    const keyOf = (ref: { scopeKind: string; scopeId?: string; stateKey: string }) =>
      `${ref.scopeKind}:${ref.scopeId ?? ""}:${ref.stateKey}`;
    const guard = (op: string, ref: { scopeKind: string; scopeId?: string }) => {
      if (ref.scopeKind === "company" && ref.scopeId !== invocationCompanyId) {
        throw new Error(
          `Plugin "test" is not allowed to perform "${op}": requested company "${ref.scopeId}" ` +
            `but the current invocation is scoped to company "${invocationCompanyId}"`,
        );
      }
    };
    return {
      store,
      keyOf,
      state: {
        get: vi.fn().mockImplementation((ref: any) => {
          guard("state.get", ref);
          return Promise.resolve(store.get(keyOf(ref)) ?? null);
        }),
        set: vi.fn().mockImplementation((ref: any, value: unknown) => {
          guard("state.set", ref);
          store.set(keyOf(ref), value);
          return Promise.resolve(undefined);
        }),
      },
    };
  }

  it("completes a tick and times out stale escalations without touching scope 'default'", async () => {
    const enforced = buildEnforcedState(REAL_CID);
    const { ctx, registeredJobs } = buildPluginContext();
    ctx.state = enforced.state;

    // A pending escalation created 2h ago (timeout is 30 min).
    const staleRecord = {
      escalationId: "esc-stale",
      companyId: REAL_CID,
      agentName: "SupportBot",
      reason: "needs a human",
      channelId: "ch-1",
      messageId: "msg-1",
      status: "pending",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    enforced.store.set(
      enforced.keyOf({ scopeKind: "company", scopeId: REAL_CID, stateKey: "escalation_pending_ids" }),
      ["esc-stale"],
    );
    enforced.store.set(
      enforced.keyOf({ scopeKind: "company", scopeId: REAL_CID, stateKey: "escalation_esc-stale" }),
      staleRecord,
    );

    await getSetup()(ctx);
    const handler = registeredJobs.get("check-escalation-timeouts")!;

    // Before the fix this rejected with the host's scope-enforcement error.
    await expect(handler()).resolves.toBeUndefined();

    const updated = enforced.store.get(
      enforced.keyOf({ scopeKind: "company", scopeId: REAL_CID, stateKey: "escalation_esc-stale" }),
    ) as { status: string };
    expect(updated.status).toBe("timed_out");
    expect(
      enforced.store.get(
        enforced.keyOf({ scopeKind: "company", scopeId: REAL_CID, stateKey: "escalation_pending_ids" }),
      ),
    ).toEqual([]);
  });

  it("skips the tick instead of failing when no real company id can be resolved", async () => {
    const { ctx, registeredJobs } = buildPluginContext();
    await getSetup()(ctx);
    const handler = registeredJobs.get("check-escalation-timeouts")!;

    // Simulate "no company resolvable" at job time (after a normal setup).
    _resetCompanyIdCache();
    ctx.companies.list = vi.fn().mockResolvedValue([]);
    (ctx.state.get as any).mockClear();

    await expect(handler()).resolves.toBeUndefined();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Skipping escalation timeout check"),
      expect.anything(),
    );
    const companyScopedCalls = (ctx.state.get as any).mock.calls.filter(
      (c: any[]) => c[0]?.scopeKind === "company",
    );
    expect(companyScopedCalls).toEqual([]);
  });
});

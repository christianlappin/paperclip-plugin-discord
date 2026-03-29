import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  initiateHandoff,
  handleHandoffButton,
  type HandoffRecord,
} from "../src/session-registry.js";

// ---------------------------------------------------------------------------
// State store (simulates plugin state persistence)
// ---------------------------------------------------------------------------

const stateStore = new Map<string, unknown>();

// Track Discord API calls for assertions
let discordFetchCalls: Array<{ url: string; init: RequestInit }> = [];

function makeCtx(overrides: Record<string, unknown> = {}) {
  stateStore.clear();
  discordFetchCalls = [];
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([
        { id: "agent-from-id", name: "EngineerBot" },
        { id: "agent-to-id", name: "ReviewBot" },
      ]),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "sess-handoff" }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
        return Promise.resolve(stateStore.get(stateKey) ?? null);
      }),
      set: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }, value: unknown) => {
        stateStore.set(stateKey, value);
        return Promise.resolve(undefined);
      }),
    },
    http: {
      fetch: vi.fn().mockImplementation((url: string, init: RequestInit) => {
        discordFetchCalls.push({ url, init });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "discord-msg-123" }),
          text: () => Promise.resolve(""),
        });
      }),
    },
    events: { emit: vi.fn(), on: vi.fn() },
    ...overrides,
  } as any;
}

const TOKEN = "test-bot-token";

// ---------------------------------------------------------------------------
// initiateHandoff
// ---------------------------------------------------------------------------

describe("initiateHandoff", () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("posts a yellow embed with Approve and Reject buttons to Discord", async () => {
    const result = await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Need code review for PR #42",
      "The PR changes the auth middleware",
    );

    expect(result.status).toBe("pending");
    expect(result.handoffId).toMatch(/^hoff_/);

    // Should have called Discord API to post the message
    expect(discordFetchCalls.length).toBeGreaterThanOrEqual(1);
    const postCall = discordFetchCalls.find((c) => c.url.includes("/messages"));
    expect(postCall).toBeDefined();

    const body = JSON.parse(postCall!.init.body as string);

    // Embed checks
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toContain("Handoff Request");
    expect(body.embeds[0].title).toContain("EngineerBot");
    expect(body.embeds[0].title).toContain("ReviewBot");
    expect(body.embeds[0].color).toBe(0xfee75c); // COLORS.YELLOW

    // Fields
    const fields = body.embeds[0].fields;
    expect(fields.find((f: any) => f.name === "From")?.value).toBe("EngineerBot");
    expect(fields.find((f: any) => f.name === "To")?.value).toBe("ReviewBot");
    expect(fields.find((f: any) => f.name === "Context")?.value).toBe(
      "The PR changes the auth middleware",
    );

    // Button components
    expect(body.components).toHaveLength(1);
    const buttons = body.components[0].components;
    expect(buttons).toHaveLength(2);

    const approveBtn = buttons.find((b: any) => b.label === "Approve Handoff");
    const rejectBtn = buttons.find((b: any) => b.label === "Reject Handoff");
    expect(approveBtn).toBeDefined();
    expect(rejectBtn).toBeDefined();
    expect(approveBtn.custom_id).toContain("handoff_approve_");
    expect(rejectBtn.custom_id).toContain("handoff_reject_");
    expect(approveBtn.style).toBe(3); // green
    expect(rejectBtn.style).toBe(4); // red
  });

  it("persists a pending HandoffRecord in plugin state", async () => {
    const result = await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Need code review",
    );

    const stored = stateStore.get(`handoff_${result.handoffId}`) as HandoffRecord;
    expect(stored).toBeDefined();
    expect(stored.status).toBe("pending");
    expect(stored.fromAgent).toBe("EngineerBot");
    expect(stored.toAgent).toBe("ReviewBot");
    expect(stored.threadId).toBe("thread-abc");
    expect(stored.companyId).toBe("company-1");
    expect(stored.reason).toBe("Need code review");
    expect(stored.createdAt).toBeTruthy();
  });

  it("resolves toAgentId via ctx.agents.list", async () => {
    await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Need review",
    );

    expect(ctx.agents.list).toHaveBeenCalled();
    const stored = stateStore.get(
      [...stateStore.keys()].find((k) => k.startsWith("handoff_"))!,
    ) as HandoffRecord;
    expect(stored.toAgentId).toBe("agent-to-id");
  });

  it("omits Context field when no context provided", async () => {
    await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Simple handoff",
    );

    const postCall = discordFetchCalls.find((c) => c.url.includes("/messages"));
    const body = JSON.parse(postCall!.init.body as string);
    const contextField = body.embeds[0].fields.find((f: any) => f.name === "Context");
    expect(contextField).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleHandoffButton — approve
// ---------------------------------------------------------------------------

describe("handleHandoffButton — approve", () => {
  let ctx: ReturnType<typeof makeCtx>;
  let handoffId: string;

  beforeEach(async () => {
    ctx = makeCtx();
    const result = await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Need code review",
      "Auth middleware context",
    );
    handoffId = result.handoffId;
    // Reset mocks after initiation so we only track button-handler calls
    discordFetchCalls = [];
  });

  it("returns a type-7 message update with green embed and no buttons", async () => {
    const response = (await handleHandoffButton(
      ctx,
      TOKEN,
      `handoff_approve_${handoffId}`,
      "alice",
    )) as any;

    expect(response.type).toBe(7);
    expect(response.data.embeds[0].title).toContain("Handoff Approved");
    expect(response.data.embeds[0].color).toBe(0x57f287); // COLORS.GREEN
    expect(response.data.embeds[0].description).toContain("alice");
    expect(response.data.embeds[0].description).toContain("ReviewBot");
    expect(response.data.components).toEqual([]);
  });

  it("updates the HandoffRecord to approved with resolver info", async () => {
    await handleHandoffButton(ctx, TOKEN, `handoff_approve_${handoffId}`, "alice");

    const stored = stateStore.get(`handoff_${handoffId}`) as HandoffRecord;
    expect(stored.status).toBe("approved");
    expect(stored.resolvedBy).toBe("discord:alice");
    expect(stored.resolvedAt).toBeTruthy();
  });

  it("spawns the target agent in the thread with handoff context", async () => {
    await handleHandoffButton(ctx, TOKEN, `handoff_approve_${handoffId}`, "alice");

    // spawnAgentInThread calls ctx.agents.list to resolve agent, then sessions.create
    expect(ctx.agents.sessions.create).toHaveBeenCalled();
    const createCall = ctx.agents.sessions.create.mock.calls.find(
      (c: any[]) => c[0] === "agent-to-id",
    );
    expect(createCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handleHandoffButton — reject
// ---------------------------------------------------------------------------

describe("handleHandoffButton — reject", () => {
  let ctx: ReturnType<typeof makeCtx>;
  let handoffId: string;

  beforeEach(async () => {
    ctx = makeCtx();
    const result = await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Need code review",
    );
    handoffId = result.handoffId;
    discordFetchCalls = [];
  });

  it("returns a type-7 message update with red embed", async () => {
    const response = (await handleHandoffButton(
      ctx,
      TOKEN,
      `handoff_reject_${handoffId}`,
      "bob",
    )) as any;

    expect(response.type).toBe(7);
    expect(response.data.embeds[0].title).toContain("Handoff Rejected");
    expect(response.data.embeds[0].color).toBe(0xed4245); // COLORS.RED
    expect(response.data.embeds[0].description).toContain("bob");
    expect(response.data.embeds[0].description).toContain("EngineerBot");
    expect(response.data.components).toEqual([]);
  });

  it("updates the HandoffRecord to rejected", async () => {
    await handleHandoffButton(ctx, TOKEN, `handoff_reject_${handoffId}`, "bob");

    const stored = stateStore.get(`handoff_${handoffId}`) as HandoffRecord;
    expect(stored.status).toBe("rejected");
    expect(stored.resolvedBy).toBe("discord:bob");
  });

  it("does NOT spawn the target agent", async () => {
    // Reset session create mock after initiateHandoff
    ctx.agents.sessions.create.mockClear();

    await handleHandoffButton(ctx, TOKEN, `handoff_reject_${handoffId}`, "bob");

    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleHandoffButton — edge cases
// ---------------------------------------------------------------------------

describe("handleHandoffButton — edge cases", () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("returns ephemeral 'not found' when handoff ID does not exist", async () => {
    const response = (await handleHandoffButton(
      ctx,
      TOKEN,
      "handoff_approve_hoff_nonexistent",
      "alice",
    )) as any;

    // respondToInteraction returns { type: 4, data: { content, flags: 64 } }
    expect(response.type).toBe(4);
    expect(response.data.content).toContain("not found");
    expect(response.data.flags).toBe(64); // ephemeral
  });

  it("returns ephemeral message when handoff already resolved", async () => {
    const result = await initiateHandoff(
      ctx,
      TOKEN,
      "thread-abc",
      "EngineerBot",
      "ReviewBot",
      "company-1",
      "Review please",
    );

    // Approve first
    await handleHandoffButton(ctx, TOKEN, `handoff_approve_${result.handoffId}`, "alice");

    // Try to approve again
    const response = (await handleHandoffButton(
      ctx,
      TOKEN,
      `handoff_approve_${result.handoffId}`,
      "bob",
    )) as any;

    expect(response.type).toBe(4);
    expect(response.data.content).toContain("already approved");
    expect(response.data.flags).toBe(64);
  });
});

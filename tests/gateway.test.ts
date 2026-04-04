import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

function makeCtx(): PluginContext {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    http: {
      fetch: vi.fn(),
    },
    metrics: { emit: vi.fn() },
  } as unknown as PluginContext;
}

describe("connectGateway", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("returns no-op and warns when WebSocket is not available", async () => {
    // Simulate an environment without WebSocket (Node < 21)
    // @ts-expect-error -- intentionally deleting global for test
    delete globalThis.WebSocket;

    const { connectGateway } = await import("../src/gateway.js");
    const ctx = makeCtx();
    const handler = vi.fn();

    const result = await connectGateway(ctx, "fake-token", handler);

    expect(result).toEqual({ close: expect.any(Function) });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket is not available"),
    );
    expect(handler).not.toHaveBeenCalled();
    result.close(); // should not throw
  });
});

describe("respondViaCallback", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles 204 responses without error (Bug 1 regression)", async () => {
    // Simulate Discord returning 204 No Content on successful callback
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: () => Promise.resolve(""),
    }) as unknown as typeof fetch;

    const { respondViaCallback } = await import("../src/gateway.js");
    const ctx = makeCtx();

    await respondViaCallback(ctx, "interaction-1", "token-1", {
      type: 4,
      data: { content: "Hello" },
    });

    // Should not log any error or warning
    expect(ctx.logger.error).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();

    // Should have called native fetch, not ctx.http.fetch
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/interactions/interaction-1/token-1/callback"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("logs warning on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    }) as unknown as typeof fetch;

    const { respondViaCallback } = await import("../src/gateway.js");
    const ctx = makeCtx();

    await respondViaCallback(ctx, "interaction-1", "token-1", { type: 4 });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Interaction callback failed",
      expect.objectContaining({ status: 400 }),
    );
  });
});

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

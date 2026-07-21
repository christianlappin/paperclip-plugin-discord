import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  BINDING_MISSING_MESSAGE,
  COMPANY_SCOPE_MISSING_MESSAGE,
  SECRET_REF_INVALID_MESSAGE,
  resolveCompanyScopedSecret,
  resolveStartupDiscordBotToken,
  type DiscordRuntimeHealth,
} from "../src/runtime-token.js";

const COMPANY_ID = "3741f9e1-0e05-4ac3-ac19-19117dd6824b";
const SECRET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OBJECT_REF = { type: "secret_ref", secretId: SECRET_ID } as const;

function makeContext(resolve: (...args: unknown[]) => Promise<string>): PluginContext {
  return {
    secrets: { resolve },
    logger: { error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
}

describe("resolveStartupDiscordBotToken", () => {
  it("returns the resolved bot token and marks health ok", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const resolve = vi.fn(async () => "bot-token");
    const ctx = makeContext(resolve);

    const token = await resolveStartupDiscordBotToken(ctx, OBJECT_REF, COMPANY_ID, (next) => health.push(next));

    expect(token).toBe("bot-token");
    expect(health).toEqual([{ status: "ok" }]);
    // The host call must carry the object ref + company scope + config path.
    expect(resolve).toHaveBeenCalledWith(OBJECT_REF, {
      companyId: COMPANY_ID,
      configPath: "discordBotTokenRef",
    });
  });

  it("normalizes a legacy bare-UUID ref to the object shape", async () => {
    const resolve = vi.fn(async () => "bot-token");
    const ctx = makeContext(resolve);

    const token = await resolveStartupDiscordBotToken(ctx, SECRET_ID, COMPANY_ID, () => {});

    expect(token).toBe("bot-token");
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      { companyId: COMPANY_ID, configPath: "discordBotTokenRef" },
    );
  });

  it("degrades health without calling the host when the ref is invalid", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const resolve = vi.fn(async () => "bot-token");
    const ctx = makeContext(resolve);

    const token = await resolveStartupDiscordBotToken(ctx, "not-a-uuid", COMPANY_ID, (next) => health.push(next));

    expect(token).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(health[0]?.status).toBe("degraded");
    expect(health[0]?.message).toBe(SECRET_REF_INVALID_MESSAGE);
  });

  it("degrades health without calling the host when no company scope is available", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const resolve = vi.fn(async () => "bot-token");
    const ctx = makeContext(resolve);

    const token = await resolveStartupDiscordBotToken(ctx, OBJECT_REF, null, (next) => health.push(next));

    expect(token).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(health[0]?.status).toBe("degraded");
    expect(health[0]?.message).toBe(COMPANY_SCOPE_MISSING_MESSAGE);
  });

  it("degrades health and does not throw when host resolution fails", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const ctx = makeContext(async () => {
      throw new Error("Secret is not bound to plugin:x at discordBotTokenRef (binding_missing)");
    });

    const token = await resolveStartupDiscordBotToken(ctx, OBJECT_REF, COMPANY_ID, (next) => health.push(next));

    expect(token).toBeUndefined();
    expect(health[0]?.status).toBe("degraded");
    expect(health[0]?.message).toBe(BINDING_MISSING_MESSAGE);
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("resolveCompanyScopedSecret", () => {
  it("passes through arbitrary config paths", async () => {
    const resolve = vi.fn(async () => "board-key");
    const ctx = makeContext(resolve);

    const value = await resolveCompanyScopedSecret(ctx, OBJECT_REF, {
      companyId: COMPANY_ID,
      configPath: "paperclipBoardApiKeyRef",
    });

    expect(value).toBe("board-key");
    expect(resolve).toHaveBeenCalledWith(OBJECT_REF, {
      companyId: COMPANY_ID,
      configPath: "paperclipBoardApiKeyRef",
    });
  });
});

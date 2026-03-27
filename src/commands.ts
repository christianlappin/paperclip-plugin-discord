import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";
import { withRetry } from "./retry.js";
import { handleHandoffButton, handleDiscussionButton, handleAcpCommand } from "./session-registry.js";

interface InteractionOption {
  name: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

interface InteractionData {
  name: string;
  custom_id?: string;
  component_type?: number;
  options?: InteractionOption[];
}

interface Interaction {
  type: number;
  data?: InteractionData;
  member?: { user: { username: string } };
}

export interface CommandContext {
  baseUrl: string;
  companyId: string;
  token: string;
  defaultChannelId: string;
}

function getOption(
  options: InteractionOption[] | undefined,
  name: string,
): string | undefined {
  return options
    ?.find((o) => o.name === name)
    ?.value?.toString();
}

export const SLASH_COMMANDS = [
  {
    name: "clip",
    description: "Manage your Paperclip instance from Discord",
    options: [
      {
        name: "status",
        description: "Show active agents and recent task completions",
        type: 1,
      },
      {
        name: "approve",
        description: "Approve a pending approval",
        type: 1,
        options: [
          {
            name: "id",
            description: "The approval ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "budget",
        description: "Check an agent's remaining budget",
        type: 1,
        options: [
          {
            name: "agent",
            description: "Agent name or ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "issues",
        description: "List open issues with optional project filter",
        type: 1,
        options: [
          {
            name: "project",
            description: "Filter by project name",
            type: 3,
            required: false,
          },
        ],
      },
      {
        name: "agents",
        description: "Show all agents with status indicators",
        type: 1,
      },
      {
        name: "help",
        description: "List all available /clip and /acp commands",
        type: 1,
      },
      {
        name: "connect",
        description: "Link this channel to a Paperclip company",
        type: 1,
        options: [
          {
            name: "company",
            description: "Company name or ID",
            type: 3,
            required: false,
          },
        ],
      },
      {
        name: "connect-channel",
        description: "Map current Discord channel to a Paperclip project",
        type: 1,
        options: [
          {
            name: "project",
            description: "Project name to map to this channel",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "digest",
        description: "Configure daily digest for this channel",
        type: 1,
        options: [
          {
            name: "action",
            description: "on, off, or status",
            type: 3,
            required: true,
            choices: [
              { name: "on", value: "on" },
              { name: "off", value: "off" },
              { name: "status", value: "status" },
            ],
          },
          {
            name: "mode",
            description: "Digest mode (daily, bidaily, tridaily)",
            type: 3,
            required: false,
            choices: [
              { name: "daily", value: "daily" },
              { name: "bidaily", value: "bidaily" },
              { name: "tridaily", value: "tridaily" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "acp",
    description: "Manage coding agent sessions via Agent Client Protocol",
    options: [
      {
        name: "spawn",
        description: "Start a new coding agent session in a thread",
        type: 1,
        options: [
          {
            name: "agent",
            description: "Agent name to spawn",
            type: 3,
            required: true,
          },
          {
            name: "task",
            description: "Task description for the agent",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "status",
        description: "Check the status of an ACP session",
        type: 1,
        options: [
          {
            name: "session",
            description: "The ACP session ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "cancel",
        description: "Cancel a running ACP session",
        type: 1,
        options: [
          {
            name: "session",
            description: "The ACP session ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "close",
        description: "Close a completed ACP session and archive the thread",
        type: 1,
        options: [
          {
            name: "session",
            description: "The ACP session ID",
            type: 3,
            required: true,
          },
        ],
      },
    ],
  },
];

export async function handleInteraction(
  ctx: PluginContext,
  interaction: Interaction,
  cmdCtx: CommandContext,
): Promise<unknown> {
  if (interaction.type === 1) {
    return { type: 1 };
  }

  if (interaction.type === 2 && interaction.data) {
    await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);
    return handleSlashCommand(ctx, interaction.data, interaction.member, cmdCtx);
  }

  if (interaction.type === 3 && interaction.data) {
    return handleButtonClick(ctx, interaction.data, interaction.member?.user.username, cmdCtx);
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown interaction type.",
    ephemeral: true,
  });
}

async function handleSlashCommand(
  ctx: PluginContext,
  data: InteractionData,
  member?: { user: { username: string } },
  cmdCtx?: CommandContext,
): Promise<unknown> {
  if (data.name === "acp") {
    return handleAcpCommand(
      ctx,
      cmdCtx?.token ?? "",
      data,
      cmdCtx?.companyId ?? "default",
      cmdCtx?.defaultChannelId ?? "",
    );
  }

  const subcommand = data.options?.[0];
  if (!subcommand) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/clip status`.",
      ephemeral: true,
    });
  }

  const subName = subcommand.name;
  const companyId = cmdCtx?.companyId ?? "default";
  const baseUrl = cmdCtx?.baseUrl ?? "http://localhost:3100";

  switch (subName) {
    case "status":
      return handleStatus(ctx, companyId);
    case "approve":
      return handleApprove(
        ctx,
        getOption(subcommand.options ?? [], "id"),
        member?.user.username,
        baseUrl,
      );
    case "budget":
      return handleBudget(ctx, getOption(subcommand.options ?? [], "agent"), companyId);
    case "issues":
      return handleIssues(ctx, companyId, getOption(subcommand.options ?? [], "project"), baseUrl);
    case "agents":
      return handleAgents(ctx, companyId);
    case "help":
      return handleHelp();
    case "connect":
      return handleConnect(ctx, getOption(subcommand.options ?? [], "company"));
    case "connect-channel":
      return handleConnectChannel(ctx, getOption(subcommand.options ?? [], "project") ?? "");
    case "digest":
      return handleDigest(
        ctx,
        getOption(subcommand.options ?? [], "action") ?? "status",
        getOption(subcommand.options ?? [], "mode"),
      );
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown command: ${subName}`,
        ephemeral: true,
      });
  }
}

async function handleStatus(ctx: PluginContext, companyId: string): Promise<unknown> {
  try {
    const agents = await ctx.agents.list({ companyId, status: "active" });
    const issues = await ctx.issues.list({ companyId, status: "done", limit: 5 });

    const agentList = agents.length > 0
      ? agents.map((a: { name?: string; id: string }) => `- **${a.name ?? a.id}**`).join("\n")
      : "No active agents";

    const issueList = issues.length > 0
      ? issues.map((i: { identifier: string | null; id: string; title?: string }) => `- **${i.identifier ?? i.id}** ${i.title ?? ""}`).join("\n")
      : "No recent completions";

    const embeds: DiscordEmbed[] = [
      {
        title: "Paperclip Status",
        color: COLORS.BLUE,
        fields: [
          { name: `Active Agents (${agents.length})`, value: agentList },
          { name: `Recent Completions (${issues.length})`, value: issueList },
        ],
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch status: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleApprove(
  ctx: PluginContext,
  approvalId: string | undefined,
  username?: string,
  baseUrl?: string,
): Promise<unknown> {
  if (!approvalId) {
    return respondToInteraction({
      type: 4,
      content: "Missing approval ID. Usage: `/clip approve id:<approval-id>`",
      ephemeral: true,
    });
  }

  try {
    const url = `${baseUrl ?? "http://localhost:3100"}/api/approvals/${approvalId}/approve`;
    await withRetry(() =>
      ctx.http.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: `discord:${username ?? "unknown"}` }),
      }),
    );

    await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    ctx.logger.info("Approval via Discord", { approvalId, username });

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Approval Resolved",
        description: `**Approved** \`${approvalId}\` by ${username ?? "Discord user"}`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to approve ${approvalId}: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleBudget(
  ctx: PluginContext,
  agentQuery: string | undefined,
  companyId: string,
): Promise<unknown> {
  if (!agentQuery) {
    return respondToInteraction({
      type: 4,
      content: "Missing agent name. Usage: `/clip budget agent:<name>`",
      ephemeral: true,
    });
  }

  try {
    const agents = await ctx.agents.list({ companyId });
    const agent = agents.find(
      (a: { id: string; name: string }) =>
        a.id === agentQuery || a.name === agentQuery ||
        a.name.toLowerCase() === agentQuery.toLowerCase(),
    );

    if (!agent) {
      return respondToInteraction({
        type: 4,
        content: `Agent not found: ${agentQuery}`,
        ephemeral: true,
      });
    }

    const budgetState = await ctx.state.get({
      scopeKind: "agent",
      scopeId: agent.id,
      stateKey: "budget",
    }) as { spent?: number; limit?: number } | null;

    const spent = budgetState?.spent ?? 0;
    const limit = budgetState?.limit ?? 0;
    const remaining = limit - spent;
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;

    return respondToInteraction({
      type: 4,
      embeds: [
        {
          title: `Budget: ${agent.name ?? agent.id}`,
          color: remaining > 0 ? COLORS.GREEN : COLORS.RED,
          fields: [
            { name: "Spent", value: `$${spent.toFixed(2)}`, inline: true },
            { name: "Limit", value: `$${limit.toFixed(2)}`, inline: true },
            { name: "Remaining", value: `$${remaining.toFixed(2)} (${pct}% used)`, inline: true },
          ],
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        },
      ],
      ephemeral: true,
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to look up budget for ${agentQuery}: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleIssues(
  ctx: PluginContext,
  companyId: string,
  projectFilter?: string,
  baseUrl?: string,
): Promise<unknown> {
  try {
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const filtered = projectFilter
      ? issues.filter((i: { project?: { name?: string } | null }) => {
          const projName = i.project?.name ?? "";
          return projName.toLowerCase().includes(projectFilter.toLowerCase());
        })
      : issues;

    if (filtered.length === 0) {
      const filter = projectFilter ? ` for project "${projectFilter}"` : "";
      return respondToInteraction({
        type: 4,
        content: `No issues found${filter}.`,
        ephemeral: true,
      });
    }

    const statusEmoji: Record<string, string> = {
      done: "✅", todo: "📋", in_progress: "🔄", backlog: "📥", blocked: "🚫", in_review: "🔍",
    };

    const fields = filtered.map((i: { identifier?: string | null; id: string; title?: string; status: string }) => {
      const emoji = statusEmoji[i.status] ?? "📋";
      const id = i.identifier ?? i.id;
      return {
        name: `${emoji} ${id}`,
        value: i.title ?? "(untitled)",
      };
    });

    const embeds: DiscordEmbed[] = [
      {
        title: `Open Issues${projectFilter ? ` (${projectFilter})` : ""}`,
        color: COLORS.BLUE,
        fields,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch issues: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleAgents(ctx: PluginContext, companyId: string): Promise<unknown> {
  try {
    const agents = await ctx.agents.list({ companyId });

    if (agents.length === 0) {
      return respondToInteraction({ type: 4, content: "No agents found.", ephemeral: true });
    }

    const statusEmoji: Record<string, string> = {
      active: "🟢", error: "🔴", paused: "🟡", idle: "⚪", running: "🔵",
    };

    const lines = agents.map((a: { name?: string; id: string; status: string }) => {
      const emoji = statusEmoji[a.status] ?? "⚪";
      return `${emoji} **${a.name ?? a.id}** — ${a.status}`;
    });

    const embeds: DiscordEmbed[] = [
      {
        title: "Agents",
        description: lines.join("\n"),
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch agents: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

function handleHelp(): unknown {
  const commands = [
    "`/clip status` — Show active agents and recent completions",
    "`/clip issues [project]` — List open issues",
    "`/clip agents` — Show all agents with status",
    "`/clip approve <id>` — Approve a pending approval",
    "`/clip budget <agent>` — Check agent budget",
    "`/clip connect [company]` — Link channel to a company",
    "`/clip connect-channel <project>` — Map channel to a project",
    "`/clip digest <on|off|status> [mode]` — Configure daily digest",
    "`/clip help` — Show this help message",
    "",
    "`/acp spawn <agent> <task>` — Start an agent session in a thread",
    "`/acp status <session>` — Check session status",
    "`/acp cancel <session>` — Cancel a session",
    "`/acp close <session>` — Close and archive a session thread",
  ];

  const embeds: DiscordEmbed[] = [
    {
      title: "Paperclip Bot Commands",
      description: commands.join("\n"),
      color: COLORS.BLUE,
      footer: { text: "Paperclip" },
    },
  ];

  return respondToInteraction({ type: 4, embeds, ephemeral: true });
}

async function handleConnect(
  ctx: PluginContext,
  companyArg?: string,
): Promise<unknown> {
  if (!companyArg?.trim()) {
    try {
      const companies = await ctx.companies.list();
      const names = companies.map((c: { name?: string; id: string }) => c.name || c.id).join(", ");
      return respondToInteraction({
        type: 4,
        content: `Usage: \`/clip connect company:<name>\`\nAvailable: ${names || "none"}`,
        ephemeral: true,
      });
    } catch {
      return respondToInteraction({
        type: 4,
        content: "Usage: `/clip connect company:<name>`",
        ephemeral: true,
      });
    }
  }

  try {
    const input = companyArg.trim();
    const companies = await ctx.companies.list();
    const match = companies.find(
      (c: { id: string; name?: string }) =>
        c.id === input || c.name?.toLowerCase() === input.toLowerCase(),
    );

    if (!match) {
      const names = companies.map((c: { name?: string; id: string }) => c.name || c.id).join(", ");
      return respondToInteraction({
        type: 4,
        content: `Company "${input}" not found. Available: ${names || "none"}`,
        ephemeral: true,
      });
    }

    await ctx.state.set(
      { scopeKind: "instance", stateKey: `company_default` },
      { companyId: match.id, companyName: match.name ?? input, linkedAt: new Date().toISOString() },
    );

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Company Connected",
        description: `Linked to company: **${match.name ?? input}**`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleConnectChannel(
  ctx: PluginContext,
  projectName: string,
): Promise<unknown> {
  if (!projectName.trim()) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/clip connect-channel project:<project-name>`",
      ephemeral: true,
    });
  }

  try {
    const existing = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "channel-project-map",
    })) as Record<string, string> | null;

    const channelMap = existing ?? {};
    // Store project → channelId mapping (channelId will be resolved at notification time)
    // For now we store the project name as key with a placeholder
    channelMap[projectName.trim()] = "pending";

    await ctx.state.set(
      { scopeKind: "instance", stateKey: "channel-project-map" },
      channelMap,
    );

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Channel Mapped",
        description: `Mapped project **${projectName.trim()}** to this channel.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to map channel: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleDigest(
  ctx: PluginContext,
  action: string,
  mode?: string,
): Promise<unknown> {
  const stateKey = "digest-config";

  if (action === "status") {
    const config = (await ctx.state.get({
      scopeKind: "instance",
      stateKey,
    })) as { mode?: string; enabled?: boolean } | null;

    const currentMode = config?.mode ?? "off";
    const enabled = config?.enabled ?? false;

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Digest Configuration",
        fields: [
          { name: "Enabled", value: enabled ? "Yes" : "No", inline: true },
          { name: "Mode", value: currentMode, inline: true },
        ],
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
      ephemeral: true,
    });
  }

  if (action === "off") {
    await ctx.state.set(
      { scopeKind: "instance", stateKey },
      { mode: "off", enabled: false },
    );
    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Digest Disabled",
        description: "Daily digest has been turned off.",
        color: COLORS.GRAY,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  if (action === "on") {
    const digestMode = mode ?? "daily";
    await ctx.state.set(
      { scopeKind: "instance", stateKey },
      { mode: digestMode, enabled: true },
    );
    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Digest Enabled",
        description: `Daily digest set to **${digestMode}** mode.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  return respondToInteraction({
    type: 4,
    content: "Usage: `/clip digest action:<on|off|status> [mode:<daily|bidaily|tridaily>]`",
    ephemeral: true,
  });
}

async function handleButtonClick(
  ctx: PluginContext,
  data: InteractionData,
  username?: string,
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const customId = data.custom_id ?? data.name;
  const actor = username ?? "Discord user";
  const base = cmdCtx?.baseUrl ?? "http://localhost:3100";
  const token = cmdCtx?.token ?? "";

  if (customId.startsWith("approval_approve_")) {
    const approvalId = customId.replace("approval_approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, action: "approve", actor });

    try {
      await withRetry(() =>
        ctx.http.fetch(`${base}/api/approvals/${approvalId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `discord:${actor}` }),
        }),
      );
      await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    } catch (err) {
      ctx.logger.error("Failed to approve via API", { approvalId, error: String(err) });
    }

    return {
      type: 7,
      data: {
        embeds: [{
          title: "Approval Resolved",
          description: `**Approved** by ${actor}`,
          color: COLORS.GREEN,
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    };
  }

  if (customId.startsWith("approval_reject_")) {
    const approvalId = customId.replace("approval_reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, action: "reject", actor });

    try {
      await withRetry(() =>
        ctx.http.fetch(`${base}/api/approvals/${approvalId}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `discord:${actor}` }),
        }),
      );
      await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    } catch (err) {
      ctx.logger.error("Failed to reject via API", { approvalId, error: String(err) });
    }

    return {
      type: 7,
      data: {
        embeds: [{
          title: "Approval Resolved",
          description: `**Rejected** by ${actor}`,
          color: COLORS.RED,
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    };
  }

  if (customId.startsWith("esc_")) {
    return handleEscalationButton(ctx, customId, actor, base);
  }

  if (customId.startsWith("handoff_")) {
    return handleHandoffButton(ctx, token, customId, actor);
  }

  if (customId.startsWith("disc_")) {
    return handleDiscussionButton(ctx, token, customId, actor);
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown button action.",
    ephemeral: true,
  });
}

async function handleEscalationButton(
  ctx: PluginContext,
  customId: string,
  actor: string,
  _baseUrl: string,
): Promise<unknown> {
  const parts = customId.split("_");
  const action = parts[1];
  const escalationId = parts.slice(2).join("_");

  ctx.logger.info("Escalation button clicked", { escalationId, action, actor });

  const record = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: `escalation_${escalationId}`,
  }) as {
    escalationId: string;
    companyId: string;
    agentName: string;
    reason: string;
    suggestedReply?: string;
    status: string;
  } | null;

  if (!record) {
    return respondToInteraction({ type: 4, content: `Escalation \`${escalationId}\` not found.`, ephemeral: true });
  }

  if (record.status !== "pending") {
    return respondToInteraction({ type: 4, content: `Escalation already ${record.status}.`, ephemeral: true });
  }

  const companyId = record.companyId || "default";

  const resolveRecord = async (resolution: string): Promise<void> => {
    record.status = "resolved";
    await ctx.state.set(
      { scopeKind: "company", scopeId: "default", stateKey: `escalation_${escalationId}` },
      {
        ...record,
        resolvedAt: new Date().toISOString(),
        resolvedBy: `discord:${actor}`,
        resolution,
      },
    );
    await ctx.metrics.write(METRIC_NAMES.escalationsResolved, 1);
    ctx.events.emit("escalation-resolved", companyId, {
      escalationId,
      action: resolution,
      resolvedBy: actor,
      suggestedReply: record.suggestedReply,
    });
  };

  switch (action) {
    case "suggest": {
      await resolveRecord("suggested_reply");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - RESOLVED`,
            description: `**Suggested reply accepted** by ${actor}`,
            color: COLORS.GREEN,
            fields: [
              { name: "Reason", value: record.reason.slice(0, 1024) },
              ...(record.suggestedReply ? [{ name: "Reply Used", value: record.suggestedReply.slice(0, 1024) }] : []),
            ],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    case "reply": {
      await resolveRecord("human_reply");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - RESOLVED`,
            description: `**${actor}** is replying to the customer directly.`,
            color: COLORS.GREEN,
            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    case "override": {
      await resolveRecord("agent_override");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - OVERRIDDEN`,
            description: `**${actor}** has overridden the agent.`,
            color: COLORS.GREEN,
            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    case "dismiss": {
      await resolveRecord("dismissed");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - DISMISSED`,
            description: `Dismissed by ${actor}`,
            color: COLORS.GRAY,
            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    default:
      return respondToInteraction({ type: 4, content: `Unknown escalation action: ${action}`, ephemeral: true });
  }
}

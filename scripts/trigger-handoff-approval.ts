#!/usr/bin/env npx tsx
/**
 * trigger-handoff-approval.ts
 *
 * Posts a handoff approval request to Discord with Approve/Reject buttons.
 * This simulates what the `handoff_to_agent` tool does when an agent
 * requests a conversation handoff.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=<token> DISCORD_CHANNEL_ID=<channel> npx tsx scripts/trigger-handoff-approval.ts
 *
 * Optional env vars:
 *   FROM_AGENT   — name of the agent initiating (default: "EngineerBot")
 *   TO_AGENT     — name of the target agent (default: "ReviewBot")
 *   REASON       — handoff reason (default: "Need code review for recent changes")
 *   CONTEXT      — additional context (default: "Testing handoff approval flow end-to-end")
 *
 * The script:
 *   1. Generates a handoff ID
 *   2. Posts a yellow embed with Approve/Reject buttons to the channel
 *   3. Prints the handoff ID and message details
 *   4. Leaves the approval pending for a human to click in Discord
 *
 * NOTE: For the button click to be handled by the plugin, the Discord plugin
 * must be running with its interaction webhook registered. The plugin's
 * onWebhook handler will look up the handoff record in plugin state.
 * If you're only testing that buttons render correctly in Discord, this
 * script is sufficient on its own.
 */

const DISCORD_API = "https://discord.com/api/v10";

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

if (!token || !channelId) {
  console.error("Required env vars: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID");
  process.exit(1);
}

const fromAgent = process.env.FROM_AGENT ?? "EngineerBot";
const toAgent = process.env.TO_AGENT ?? "ReviewBot";
const reason = process.env.REASON ?? "Need code review for recent changes";
const context = process.env.CONTEXT ?? "Testing handoff approval flow end-to-end";

const handoffId = `hoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const body = {
  embeds: [
    {
      title: `Handoff Request: ${fromAgent} -> ${toAgent}`,
      description: reason,
      color: 0xfee75c, // yellow
      fields: [
        { name: "From", value: fromAgent, inline: true },
        { name: "To", value: toAgent, inline: true },
        { name: "Context", value: context },
      ],
      footer: { text: "Paperclip Handoff" },
      timestamp: new Date().toISOString(),
    },
  ],
  components: [
    {
      type: 1, // action row
      components: [
        {
          type: 2, // button
          style: 3, // green
          label: "Approve Handoff",
          custom_id: `handoff_approve_${handoffId}`,
        },
        {
          type: 2,
          style: 4, // red
          label: "Reject Handoff",
          custom_id: `handoff_reject_${handoffId}`,
        },
      ],
    },
  ],
};

async function main() {
  console.log(`Posting handoff approval request to channel ${channelId}...`);
  console.log(`  Handoff ID: ${handoffId}`);
  console.log(`  From: ${fromAgent} -> To: ${toAgent}`);
  console.log(`  Reason: ${reason}`);
  console.log();

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Discord API error ${res.status}: ${text}`);
    process.exit(1);
  }

  const msg = await res.json();
  console.log(`Message posted successfully!`);
  console.log(`  Message ID: ${msg.id}`);
  console.log(`  Channel: ${msg.channel_id}`);
  console.log();
  console.log("The approval buttons are now visible in Discord.");
  console.log("Click 'Approve Handoff' or 'Reject Handoff' to test the flow.");
  console.log();
  console.log("NOTE: For the button click to trigger the plugin's handler,");
  console.log("the Discord plugin must be running with its interaction webhook");
  console.log("registered and the handoff record must exist in plugin state.");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

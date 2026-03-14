#!/usr/bin/env node
/**
 * Autonomous agent loop — runs without Claude Code.
 *
 * Plumbing (heartbeat, signing, inbox, git) is handled locally.
 * Thinking (classify, compose, decide, code) is delegated to opencode CLI.
 *
 * Usage:
 *   WALLET_PASSWORD="xxx" node scripts/loop.mjs              # perpetual loop
 *   WALLET_PASSWORD="xxx" node scripts/loop.mjs --once        # single cycle
 *
 * Environment:
 *   WALLET_PASSWORD  — required
 *   NETWORK          — mainnet (default) | testnet
 *   CYCLE_INTERVAL   — ms between cycles (default: 300000 = 5 min)
 *   MODEL_HEAVY      — model for coding/PRs (default: opencode-go/glm-5)
 *   MODEL_MEDIUM     — model for decisions/replies (default: opencode-go/kimi-k2.5)
 *   MODEL_LIGHT      — model for simple tasks (default: opencode-go/minimax-m2.5)
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const DAEMON = path.join(ROOT, "daemon");
const MEMORY = path.join(ROOT, "memory");
const SCRIPTS = path.join(ROOT, "scripts");
const SIGN = path.join(SCRIPTS, "sign.mjs");

const PASSWORD = process.env.WALLET_PASSWORD;
if (!PASSWORD) { console.error("WALLET_PASSWORD required"); process.exit(1); }

const SINGLE_CYCLE = process.argv.includes("--once");
const CYCLE_INTERVAL = parseInt(process.env.CYCLE_INTERVAL || "300000", 10);

// Model tiers: heavy (coding), medium (decisions/replies), light (simple tasks)
const MODELS = {
  heavy:  process.env.MODEL_HEAVY  || "opencode-go/glm-5",
  medium: process.env.MODEL_MEDIUM || "opencode-go/kimi-k2.5",
  light:  process.env.MODEL_LIGHT  || "opencode-go/minimax-m2.5",
};

// Read CLAUDE.md for addresses
const claudeMd = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
const STX_ADDR = claudeMd.match(/Stacks address:\*{0,2}\s*(SP\w+)/)?.[1];
const BTC_ADDR = claudeMd.match(/BTC SegWit:\*{0,2}\s*(bc1q\w+)/)?.[1];

if (!STX_ADDR || !BTC_ADDR) {
  console.error("Could not parse STX/BTC addresses from CLAUDE.md");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      timeout: opts.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    }).trim();
  } catch (e) {
    return opts.fallback ?? null;
  }
}

function sign(mode, message, flags = "") {
  const cmd = `node ${SIGN} ${mode} ${JSON.stringify(message)} ${flags}`;
  const result = run(cmd, { env: { WALLET_PASSWORD: PASSWORD }, timeout: 15000 });
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    return parsed.success ? parsed : null;
  } catch { return null; }
}

function btcSign(message) {
  const result = sign("btc", message);
  return result?.signatureBase64 || null;
}

function stxSign(message) {
  const result = sign("stx", message);
  return result?.signature || null;
}

/**
 * Call opencode run with a prompt, return the text response.
 * @param {string} prompt
 * @param {object} opts
 * @param {"heavy"|"medium"|"light"} opts.tier - model tier (default: "medium")
 */
function llm(prompt, opts = {}) {
  const tier = opts.tier || "medium";
  const model = MODELS[tier];
  const args = ["run", prompt, "--format", "json", "--dir", ROOT];
  if (model) args.push("-m", model);

  const result = spawnSync("opencode", args, {
    encoding: "utf8",
    timeout: opts.timeout || 120000,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
  });

  if (result.status !== 0 && result.status !== null) {
    console.error(`  [llm] opencode exit ${result.status}: ${(result.stderr || "").slice(0, 200)}`);
    return null;
  }

  // Parse JSON lines, extract text parts
  const output = result.stdout || "";
  const lines = output.split("\n").filter(Boolean);
  const texts = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "text" && evt.part?.text) {
        texts.push(evt.part.text);
      }
    } catch { /* skip non-JSON lines */ }
  }
  return texts.join("") || null;
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function log(phase, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] ${phase}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Phase 1: Heartbeat
// ---------------------------------------------------------------------------

function heartbeat() {
  const ts = timestamp();
  const sig = btcSign(`AIBTC Check-In | ${ts}`);
  if (!sig) { log("heartbeat", "signing failed"); return false; }

  const body = JSON.stringify({ signature: sig, timestamp: ts, btcAddress: BTC_ADDR });
  const tmpFile = `/tmp/hb_${Date.now()}.json`;
  fs.writeFileSync(tmpFile, body);
  const result = run(
    `curl -s -w "\\n%{http_code}" -X POST https://aibtc.com/api/heartbeat -H "Content-Type: application/json" -d @${tmpFile}`,
    { timeout: 15000 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}

  if (!result) { log("heartbeat", "curl failed"); return false; }
  const lines = result.split("\n");
  const code = lines.pop();
  const respBody = lines.join("\n");

  if (code === "200" || code === "201") {
    try {
      const data = JSON.parse(respBody);
      log("heartbeat", `OK #${data.checkIn?.checkInCount || "?"}`);
    } catch {
      log("heartbeat", `OK (HTTP ${code})`);
    }
    return true;
  }
  log("heartbeat", `failed HTTP ${code}`);
  return false;
}

// ---------------------------------------------------------------------------
// Phase 2: Inbox
// ---------------------------------------------------------------------------

function fetchInbox() {
  const result = run(
    `curl -s "https://aibtc.com/api/inbox/${STX_ADDR}?status=unread"`,
    { timeout: 15000 }
  );
  if (!result) return [];
  try {
    const data = JSON.parse(result);
    return data.inbox?.messages || [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Phase 3-4: Decide + Execute (LLM)
// ---------------------------------------------------------------------------

function decideAndExecute(cycle, messages, health) {
  const soulMd = fs.existsSync(path.join(ROOT, "SOUL.md"))
    ? fs.readFileSync(path.join(ROOT, "SOUL.md"), "utf8")
    : "";
  const stateMd = fs.readFileSync(path.join(DAEMON, "STATE.md"), "utf8");
  const contactsMd = fs.existsSync(path.join(MEMORY, "contacts.md"))
    ? fs.readFileSync(path.join(MEMORY, "contacts.md"), "utf8")
    : "";

  const inboxSummary = messages.length > 0
    ? messages.map(m =>
        `From: ${m.peerDisplayName || m.fromAddress} (${m.peerBtcAddress || "?"})\n` +
        `ID: ${m.messageId}\n` +
        `Content: ${m.content}\n`
      ).join("\n---\n")
    : "No unread messages.";

  const modAction = {
    0: "Check open PRs for review feedback",
    1: "Contribute to a contact's repo (find issue, file PR or comment)",
    2: "Track AIBTC core repos (github.com/aibtcdev) for new issues/PRs",
    3: "Contribute to a different contact's repo than last time",
    4: "Monitor bounties",
    5: "Self-audit: review own repos for issues",
  }[cycle % 6];

  const prompt = `You are Allora, an autonomous AI agent on the AIBTC network.

${soulMd}

## Current State
${stateMd}

## Cycle ${cycle}
Scheduled action: ${modAction}

## Inbox (${messages.length} unread)
${inboxSummary}

## Contacts
${contactsMd}

## Instructions
1. If there are unread messages, compose brief replies (max 400 chars each, ASCII only, no em-dashes).
   Return each reply as: REPLY|<messageId>|<reply text>
2. Decide and describe ONE action for this cycle based on the scheduled action above.
   Return as: ACTION|<description of what to do>
3. If the action requires GitHub work, include the specific gh commands.
   Return as: GITHUB|<gh command to run>
4. If the action requires writing code, building features, or opening PRs, write a detailed prompt
   for a coding agent. Return as: HEAVY|<detailed prompt for the coding task>
5. Write a one-line journal entry.
   Return as: JOURNAL|<entry>
6. Write the next STATE.md content (max 10 lines).
   Return as: STATE|<full STATE.md content>

Return ONLY these tagged lines, one per line. No other text.`;

  const response = llm(prompt, { tier: "medium", timeout: 180000 });
  if (!response) {
    log("decide", "LLM returned nothing");
    return { replies: [], action: null, github: [], journal: null, state: null };
  }

  // Parse tagged lines
  const replies = [];
  let action = null;
  const github = [];
  let heavyPrompt = null;
  let journal = null;
  let state = null;

  for (const line of response.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("REPLY|")) {
      const parts = trimmed.substring(6).split("|");
      if (parts.length >= 2) {
        replies.push({ messageId: parts[0], text: parts.slice(1).join("|") });
      }
    } else if (trimmed.startsWith("ACTION|")) {
      action = trimmed.substring(7);
    } else if (trimmed.startsWith("GITHUB|")) {
      github.push(trimmed.substring(7));
    } else if (trimmed.startsWith("HEAVY|")) {
      heavyPrompt = trimmed.substring(6);
    } else if (trimmed.startsWith("JOURNAL|")) {
      journal = trimmed.substring(8);
    } else if (trimmed.startsWith("STATE|")) {
      state = trimmed.substring(6);
    }
  }

  return { replies, action, github, heavyPrompt, journal, state };
}

// ---------------------------------------------------------------------------
// Phase 5: Deliver (send replies)
// ---------------------------------------------------------------------------

function sendReply(messageId, replyText) {
  const prefix = `Inbox Reply | ${messageId} | `;
  const maxReply = 500 - prefix.length;
  let text = replyText;
  if (text.length > maxReply) text = text.slice(0, maxReply - 3) + "...";

  const fullMsg = prefix + text;
  const sig = btcSign(fullMsg);
  if (!sig) { log("deliver", `signing failed for ${messageId.slice(0, 20)}...`); return false; }

  const payload = JSON.stringify({
    messageId, reply: text, signature: sig, btcAddress: BTC_ADDR,
  });
  const tmpFile = `/tmp/reply_${Date.now()}.json`;
  fs.writeFileSync(tmpFile, payload);

  const result = run(
    `curl -s -w "\\n%{http_code}" -X POST "https://aibtc.com/api/outbox/${STX_ADDR}" -H "Content-Type: application/json" -d @${tmpFile}`,
    { timeout: 15000 }
  );
  fs.unlinkSync(tmpFile);

  if (!result) { log("deliver", `curl failed for ${messageId.slice(0, 20)}...`); return false; }
  const code = result.split("\n").pop();

  if (code === "200" || code === "201") {
    log("deliver", `replied to ${messageId.slice(0, 30)}...`);
    return true;
  }

  // Fallback: mark as read
  log("deliver", `reply failed (${code}), marking as read`);
  const readSig = btcSign(`Inbox Read | ${messageId}`);
  if (readSig) {
    run(
      `curl -s -X PATCH "https://aibtc.com/api/inbox/${STX_ADDR}/${messageId}" ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"messageId":"${messageId}","signature":"${readSig}","btcAddress":"${BTC_ADDR}"}'`,
      { timeout: 15000 }
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 6: Execute GitHub commands
// ---------------------------------------------------------------------------

function executeGithub(commands) {
  for (const cmd of commands) {
    // Safety: only allow gh commands
    if (!cmd.startsWith("gh ")) {
      log("github", `skipped non-gh command: ${cmd.slice(0, 50)}`);
      continue;
    }
    log("github", cmd.slice(0, 80));
    const result = run(cmd, { timeout: 60000, fallback: "(failed)" });
    if (result) log("github", result.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Write state files
// ---------------------------------------------------------------------------

function writeState(cycle, result, hbOk, msgCount, repliesSent) {
  // health.json
  const health = {
    cycle,
    status: hbOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    phases: {
      heartbeat: hbOk ? "ok" : "failed",
      inbox: `${msgCount} messages`,
      decide: result.action ? "ok" : "idle",
      execute: result.github.length > 0 ? `${result.github.length} commands` : "idle",
      deliver: `${repliesSent} replies sent`,
      write: "ok",
      sync: "pending",
    },
    stats: { messages_received: msgCount, replies_sent: repliesSent },
    circuit_breaker: { heartbeat_fail_count: hbOk ? 0 : 1 },
    next_cycle_at: new Date(Date.now() + CYCLE_INTERVAL).toISOString(),
  };
  writeJson(path.join(DAEMON, "health.json"), health);

  // STATE.md
  if (result.state) {
    fs.writeFileSync(path.join(DAEMON, "STATE.md"), result.state + "\n");
  } else {
    const fallback = `## Cycle ${cycle} State
- Last: ${result.action || "idle cycle"}
- Pending: none
- Blockers: ${hbOk ? "none" : "heartbeat failed"}
- Wallet: active
- Mode: Peacetime
- Next: cycle ${cycle + 1}
- Follow-ups: none
`;
    fs.writeFileSync(path.join(DAEMON, "STATE.md"), fallback);
  }

  // Journal
  if (result.journal) {
    const journalPath = path.join(MEMORY, "journal.md");
    const existing = fs.readFileSync(journalPath, "utf8");
    fs.writeFileSync(journalPath, existing.trimEnd() + `\n- Cycle ${cycle}: ${result.journal}\n`);
  }
}

// ---------------------------------------------------------------------------
// Phase 8: Git sync
// ---------------------------------------------------------------------------

function gitSync(cycle, summary) {
  run("git add daemon/ memory/", { timeout: 10000 });
  const msg = `Cycle ${cycle}: ${summary}`;
  const commitResult = run(
    `git commit -m "${msg.replace(/"/g, '\\"')}"`,
    { timeout: 10000, fallback: "" }
  );
  if (commitResult && !commitResult.includes("nothing to commit")) {
    run("git push origin main", { timeout: 30000 });
    log("sync", "committed + pushed");
  } else {
    log("sync", "nothing to commit");
  }
}

// ---------------------------------------------------------------------------
// Main cycle
// ---------------------------------------------------------------------------

async function runCycle(cycle) {
  console.log(`\n=== Cycle ${cycle} ===`);

  // Phase 1
  const hbOk = heartbeat();

  // Phase 2
  const messages = fetchInbox();
  log("inbox", `${messages.length} unread`);

  // Phase 3-4
  const health = readJson(path.join(DAEMON, "health.json")) || {};
  log("decide", "calling LLM (medium)...");
  const result = decideAndExecute(cycle, messages, health);
  if (result.action) log("execute", result.action.slice(0, 100));

  // If action requires heavy coding, delegate to heavy model
  if (result.heavyPrompt) {
    log("execute", "delegating to heavy model...");
    const heavyResult = llm(result.heavyPrompt, { tier: "heavy", timeout: 300000 });
    if (heavyResult) log("execute", `heavy: ${heavyResult.slice(0, 100)}`);
  }

  // Phase 5
  let repliesSent = 0;
  for (const reply of result.replies) {
    if (sendReply(reply.messageId, reply.text)) repliesSent++;
  }

  // Phase 6
  if (result.github.length > 0) executeGithub(result.github);

  // Phase 7
  writeState(cycle, result, hbOk, messages.length, repliesSent);

  // Phase 8
  const summary = result.action?.slice(0, 60) || "idle cycle";
  gitSync(cycle, summary);

  log("done", `cycle ${cycle} complete`);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function main() {
  const health = readJson(path.join(DAEMON, "health.json"));
  let cycle = (health?.cycle || 0) + 1;

  if (SINGLE_CYCLE) {
    await runCycle(cycle);
    return;
  }

  console.log(`Starting perpetual loop from cycle ${cycle} (${CYCLE_INTERVAL / 1000}s interval)`);

  while (true) {
    await runCycle(cycle);
    cycle++;
    log("sleep", `${CYCLE_INTERVAL / 1000}s until cycle ${cycle}`);
    await new Promise(r => setTimeout(r, CYCLE_INTERVAL));
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

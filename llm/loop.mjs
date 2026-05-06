#!/usr/bin/env node
/**
 * Autonomous agent loop — SDK-native edition.
 * ALL LLM calls go through @opencode-ai/sdk (no raw spawn/openocode run).
 *
 * Plumbing (heartbeat, signing, inbox, git) is handled locally.
 * Thinking (decide, heavy tasks) is delegated to opencode via SDK client.session.prompt().
 *
 * Usage:
 *   WALLET_PASSWORD="xxx" node llm/loop.mjs              # perpetual loop
 *   WALLET_PASSWORD="xxx" node llm/loop.mjs --once        # single cycle
 *   WALLET_PASSWORD="xxx" node llm/loop.mjs --verbose      # verbose logging
 *   WALLET_PASSWORD="xxx" node llm/loop.mjs --phases 1,2   # run specific phases only
 *
 * Environment:
 *   WALLET_PASSWORD  — required
 *   NETWORK          — mainnet (default) | testnet
 *   CYCLE_INTERVAL   — ms between cycles (default: 300000 = 5 min)
 *   MODEL_HEAVY      — model for coding/PRs (default: opencode-go/glm-5)
 *   MODEL_MEDIUM     — model for decisions/replies (default: opencode-go/kimi-k2.5)
 *   MODEL_LIGHT      — model for simple tasks (default: opencode-go/minimax-m2.5)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createOpencode } from "@opencode-ai/sdk";

import { WalletConfig, getWalletManager, resetWalletManager } from "../scripts/wallet.mjs";
import { Heartbeater } from "../scripts/phase1.mjs";
import { InboxFetcher } from "../scripts/phase2.mjs";
import { Deliverer } from "../scripts/phase5.mjs";
import { Outreach } from "../scripts/phase6.mjs";
import { Writer } from "../scripts/phase7.mjs";
import { Syncer } from "../scripts/phase8.mjs";

const ROOT = process.cwd();
const DAEMON = path.join(ROOT, "daemon");
const MEMORY = path.join(ROOT, "memory");
const SCRIPTS = path.join(ROOT, "scripts");
const SIGN = path.join(SCRIPTS, "sign.mjs");

const PASSWORD = process.env.WALLET_PASSWORD;
if (!PASSWORD) { console.error("WALLET_PASSWORD required"); process.exit(1); }

const SINGLE_CYCLE = process.argv.includes("--once");
const VERBOSE = process.argv.includes("--verbose");
if (VERBOSE) process.env.VERBOSE = "1";

const PHASES_ARG = process.argv.find(a => a.startsWith("--phases="));
const PHASES = PHASES_ARG
  ? PHASES_ARG.split("=")[1].split(",").map(n => parseInt(n.trim(), 10)).filter(n => n >= 1 && n <= 8)
  : [1, 2, 3, 4, 5, 6, 7, 8];

const CYCLE_INTERVAL = parseInt(process.env.CYCLE_INTERVAL || "300000", 10);
const BACKOFF_ATTEMPTS = 5;
const BACKOFF_DELAY_MS = 60000;

const MODELS = {
  heavy:  process.env.MODEL_HEAVY  || "opencode-go/glm-5",
  medium: process.env.MODEL_MEDIUM || "opencode-go/kimi-k2.5",
  light:  process.env.MODEL_LIGHT  || "opencode-go/minimax-m2.5",
};

const claudeMd = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
const STX_ADDR = claudeMd.match(/Stacks address:\*{0,2}\s*(SP\w+)/)?.[1];
const BTC_ADDR = claudeMd.match(/BTC SegWit:\*{0,2}\s*(bc1q\w+)/)?.[1];

if (!STX_ADDR || !BTC_ADDR) {
  console.error("Could not parse STX/BTC addresses from CLAUDE.md");
  process.exit(1);
}

let heartbeater = null;
let inboxFetcher = null;
let deliverer = null;
let outreach = null;
let walletManager = null;

let opencodeClient = null;
let server = null;
let serverUrl = null;

// ─── utilities ────────────────────────────────────────────────────────────────

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

function log(phase, msg, verboseOnly = false) {
  if (verboseOnly && !VERBOSE) return;
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = verboseOnly ? "[V] " : "";
  console.log(`  ${prefix}[${ts}] ${phase}: ${msg}`);
}

// ─── model parsing ────────────────────────────────────────────────────────────

function parseModel(model) {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerID: "opencode-go", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

// ─── SDK response helpers ─────────────────────────────────────────────────────

function extractText(data) {
  if (!data?.parts) return "";
  return data.parts
    .filter(p => p.type === "text")
    .map(p => p.text)
    .join("\n");
}

function parseTaggedLines(text) {
  const result = { replies: [], action: null, github: [], heavyPrompt: null, journal: null, state: null };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("REPLY|")) {
      const idx = t.indexOf("|", 6);
      if (idx > 0) result.replies.push({ messageId: t.substring(6, idx), text: t.substring(idx + 1) });
    } else if (t.startsWith("ACTION|")) {
      result.action = t.substring(7);
    } else if (t.startsWith("GITHUB|")) {
      result.github.push(t.substring(7));
    } else if (t.startsWith("HEAVY|")) {
      result.heavyPrompt = t.substring(6);
    } else if (t.startsWith("JOURNAL|")) {
      result.journal = t.substring(8);
    } else if (t.startsWith("STATE|")) {
      result.state = t.substring(6);
    }
  }
  return result;
}

// ─── prompt builder (inlined from Decider) ────────────────────────────────────

function buildDecidePrompt(cycle, messages, stateMd, contactsMd, soulMd) {
  const inboxSummary = messages.length > 0
    ? messages.map(m =>
        `From: ${m.peerDisplayName || m.fromAddress} (${m.peerBtcAddress || "?"})\n` +
        `ID: ${m.messageId}\n` +
        `Classification: ${m.classification}\n` +
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

  return `You are Allora, an autonomous AI agent on the AIBTC network.

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
   IMPORTANT: When cloning repos, always clone to the ./repos/ subdirectory (e.g., 'gh repo clone owner/repo ./repos/repo-name')
4. If the action requires writing code, building features, or opening PRs, write a detailed prompt
   for a coding agent. Return as: HEAVY|<detailed prompt for the coding task>
5. Write a one-line journal entry.
   Return as: JOURNAL|<entry>
6. Write the next STATE.md content (max 10 lines).
   Return as: STATE|<full STATE.md content>

Return ONLY these tagged lines, one per line. No other text.`;
}

// ─── opencode SDK init ────────────────────────────────────────────────────────

async function initOpencode(opts = {}) {
  console.log("  [init] starting opencode server via SDK...");
  try {
    const result = await createOpencode({
      hostname: "127.0.0.1",
      port: 4096,
      config: { logLevel: opts.verbose ? "DEBUG" : "WARN" },
      timeout: opts.timeout || 30000,
    });
    opencodeClient = result.client;
    server = result.server;
    serverUrl = result.server.url;
    console.log(`  [init] opencode SDK ready at ${serverUrl}`);
    return true;
  } catch (e) {
    console.error(`  [init] opencode SDK failed: ${e.message}`);
    return false;
  }
}

function cleanupOpencode() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
  opencodeClient = null;
  serverUrl = null;
}

function isAnotherLoopRunning() {
  try {
    const currentPid = process.pid;
    const result = execSync(
      "pgrep -f 'llm/loop\\.mjs' || true",
      { encoding: "utf8" }
    ).trim();
    if (!result) return false;
    const pids = result.split("\n").map(p => parseInt(p.trim())).filter(Boolean);
    const excludePids = new Set([currentPid, process.ppid, process.pid]);
    return pids.some(pid => !excludePids.has(pid));
  } catch (e) {
    return false;
  }
}

async function waitForBackoff() {
  for (let attempt = 1; attempt <= BACKOFF_ATTEMPTS; attempt++) {
    if (!isAnotherLoopRunning()) return true;
    console.log(`[startup] Another loop.mjs instance detected (attempt ${attempt}/${BACKOFF_ATTEMPTS}), waiting ${BACKOFF_DELAY_MS/1000}s...`);
    await new Promise(r => setTimeout(r, BACKOFF_DELAY_MS));
  }
  console.error(`[startup] Max backoff attempts reached, another instance still running. Exiting.`);
  return false;
}

function cleanupOnExit() {
  console.log("\n[cleanup] Shutting down...");
  cleanupOpencode();
  if (walletManager) walletManager.lock();
  resetWalletManager();
  console.log("[cleanup] Done.");
  process.exit(0);
}

// ─── phase implementations ────────────────────────────────────────────────────

// Phase 1: heartbeat (unchanged — uses curl)
async function heartbeat() {
  if (!heartbeater) { log("heartbeat", "not initialized"); return false; }
  const result = await heartbeater.run();
  if (result.ok) {
    log("heartbeat", `OK #${result.checkInCount || "?"} - ${result.responseBody?.slice(0, 100) || ""}`);
    return true;
  }
  log("heartbeat", `failed: ${result.error}`);
  return false;
}

// Phase 2: inbox (unchanged — uses curl)
async function fetchInbox() {
  if (!inboxFetcher) { log("inbox", "not initialized"); return []; }
  const result = await inboxFetcher.run();
  if (!result.ok) { log("inbox", `failed: ${result.error}`); return []; }
  log("inbox", `${result.stats.total} messages (${result.stats.trustedTasks} trusted task, ${result.stats.untrustedTasks} untrusted task, ${result.stats.normal} normal)`);
  return result.messages;
}

// Phase 3: decide — SDK-native (no child process)
async function decide(cycle, messages) {
  const stateMd = fs.readFileSync(path.join(DAEMON, "STATE.md"), "utf8");
  const contactsMd = fs.existsSync(path.join(MEMORY, "contacts.md"))
    ? fs.readFileSync(path.join(MEMORY, "contacts.md"), "utf8") : "";
  const soulMd = fs.existsSync(path.join(ROOT, "SOUL.md"))
    ? fs.readFileSync(path.join(ROOT, "SOUL.md"), "utf8") : "";

  const prompt = buildDecidePrompt(cycle, messages, stateMd, contactsMd, soulMd);
  const modelConfig = parseModel(MODELS.medium);

  log("decide", `prompting (model: ${MODELS.medium})...`);

  try {
    const sessionResp = await opencodeClient.session.create({}, { timeout: 15000 });
    if (sessionResp.error) {
      log("decide", `session create failed: ${JSON.stringify(sessionResp.error).slice(0, 100)}`);
      return { replies: [], action: null, github: [], heavyPrompt: null, journal: null, state: null };
    }
    const sessionId = sessionResp.data.id;

    const resp = await opencodeClient.session.prompt({
      body: {
        model: modelConfig,
        parts: [{ type: "text", text: prompt }],
      },
      path: { id: sessionId },
    }, { timeout: 180000 });

    if (resp.error) {
      log("decide", `prompt error: ${JSON.stringify(resp.error).slice(0, 100)}`);
      return { replies: [], action: null, github: [], heavyPrompt: null, journal: null, state: null };
    }

    const text = extractText(resp.data);
    const result = parseTaggedLines(text);

    if (result.action) log("decide", result.action.slice(0, 80));
    else if (VERBOSE) log("decide", `parts: ${resp.data.parts?.length || 0}, text: ${text.length} chars`);
    return result;

  } catch (e) {
    log("decide", `failed: ${e.message}`);
    return { replies: [], action: null, github: [], heavyPrompt: null, journal: null, state: null };
  }
}

// Phase 4 helper: github commands (inlined from Executor)
function runGithubSync(commands) {
  if (!commands || commands.length === 0) return { ok: true, executed: 0, total: 0 };
  let executed = 0;
  for (const cmd of commands) {
    if (!cmd.startsWith("gh ")) {
      log("execute", `skipping non-gh: ${cmd.slice(0, 50)}`);
      continue;
    }
    const result = run(cmd, { timeout: 60000 });
    if (result !== null) { executed++; log("execute", `gh ok: ${cmd.slice(0, 60)}`); }
    else log("execute", `gh failed: ${cmd.slice(0, 60)}`);
  }
  return { ok: executed === commands.length, executed, total: commands.length };
}

// Phase 4 helper: heavy task — SDK-native
async function runHeavy(prompt, model, timeout = 300000) {
  const modelConfig = parseModel(model) || parseModel(MODELS.heavy);

  try {
    const sessionResp = await opencodeClient.session.create({}, { timeout: 15000 });
    if (sessionResp.error) return { ok: false, error: `session create failed: ${JSON.stringify(sessionResp.error).slice(0, 100)}` };
    const sessionId = sessionResp.data.id;

    const resp = await opencodeClient.session.prompt({
      body: {
        model: modelConfig,
        parts: [{ type: "text", text: prompt }],
      },
      path: { id: sessionId },
    }, { timeout });

    if (resp.error) return { ok: false, error: JSON.stringify(resp.error).slice(0, 200) };
    return { ok: true, stdout: extractText(resp.data), info: resp.data.info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Phase helpers
function shouldRunPhase(n) {
  return PHASES.includes(n);
}

// ─── cycle orchestrator ───────────────────────────────────────────────────────

async function runCycle(cycle) {
  console.log(`\n=== Cycle ${cycle} ===`);
  if (PHASES.length < 8) {
    console.log(`  Running phases: ${PHASES.join(", ")}`);
  }

  let hbOk = false;
  let messages = [];
  const result = { replies: [], action: null, github: [], heavyPrompt: null, journal: null, state: null };
  let repliesSent = 0;
  let repliesFailed = 0;

  if (shouldRunPhase(1)) { hbOk = await heartbeat(); }
  else log("phase1", "skipped");

  if (shouldRunPhase(2)) { messages = await fetchInbox(); }
  else log("phase2", "skipped");

  if (shouldRunPhase(3)) { Object.assign(result, await decide(cycle, messages)); }
  else log("phase3", "skipped");

  if (shouldRunPhase(4)) {
    if (result.github && result.github.length > 0) {
      log("execute", `running ${result.github.length} gh command(s)...`);
      const ghResult = runGithubSync(result.github);
      log("execute", `gh: ${ghResult.executed}/${ghResult.total} commands succeeded`);
    }
    if (result.heavyPrompt) {
      log("execute", "delegating to heavy model...");
      const heavyResult = await runHeavy(result.heavyPrompt, MODELS.heavy, 300000);
      if (heavyResult.ok) log("execute", "heavy: completed");
      else log("execute", `heavy: failed - ${heavyResult.error}`);
    } else if (result.action) {
      log("execute", result.action.slice(0, 100));
    }
  } else log("phase4", "skipped");

  if (shouldRunPhase(5)) {
    if (result.replies && result.replies.length > 0) {
      log("deliver", `sending ${result.replies.length} reply(ies)...`);
      for (const reply of result.replies) {
        const sent = await deliverer.sendReply(reply.messageId, reply.text);
        if (sent.ok) {
          repliesSent++;
          log("deliver", `sent to ${reply.messageId.slice(0, 20)}...`);
        } else {
          repliesFailed++;
          log("deliver", `failed for ${reply.messageId.slice(0, 20)}...: ${sent.error}`);
        }
      }
      log("deliver", `replies: ${repliesSent} sent, ${repliesFailed} failed`);
    }
  } else log("phase5", "skipped");

  if (shouldRunPhase(6)) {
    log("outreach", "checking for pending follow-ups...");
    const outreachResult = await outreach.run();
    if (outreachResult.sent > 0) log("outreach", `sent ${outreachResult.sent} message(s)`);
    else if (outreachResult.budgetExhausted) log("outreach", "budget exhausted");
    else log("outreach", "no messages sent");
  } else log("phase6", "skipped");

  if (shouldRunPhase(7)) {
    const writer = new Writer();
    const writeResult = await writer.run(cycle, result, hbOk, messages.length, repliesSent, repliesFailed);
    log("write", `wrote: ${writeResult.written.join(", ")}`);
  } else log("phase7", "skipped");

  if (shouldRunPhase(8)) {
    const syncer = new Syncer();
    const syncResult = await syncer.run(cycle, result.action?.slice(0, 60) || "idle cycle");
    if (syncResult.skipped) log("sync", "nothing to commit");
    else if (syncResult.pushed) log("sync", "committed + pushed");
    else if (syncResult.error) log("sync", `error: ${syncResult.error}`);
  } else log("phase8", "skipped");

  log("done", `cycle ${cycle} complete`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.on("SIGTERM", cleanupOnExit);
  process.on("SIGINT", cleanupOnExit);
  process.on("exit", () => {
    try { execSync(`pkill -9 -P ${process.pid} 2>/dev/null || true`); } catch (e) {}
  });

  if (!await initOpencode({ verbose: VERBOSE })) {
    console.error("Failed to initialize opencode SDK");
    process.exit(1);
  }

  try {
    const config = WalletConfig.load();
    walletManager = getWalletManager(config);
    log("init", `config: stx=${config.stxAddress}, btc=${config.btcAddress}`);

    await walletManager.unlock(PASSWORD);
    log("init", "wallet unlocked");

    heartbeater = new Heartbeater(walletManager);
    inboxFetcher = new InboxFetcher(walletManager.stxAddress);
    deliverer = new Deliverer(walletManager);
    outreach = new Outreach(walletManager);
    log("init", `ready: btc=${config.btcAddress}, stx=${config.stxAddress}`);
  } catch (e) {
    console.error("Failed to initialize:", e.message);
    process.exit(1);
  }

  if (!await waitForBackoff()) {
    process.exit(1);
  }

  const health = readJson(path.join(DAEMON, "health.json"));
  let cycle = (health?.cycle || 0) + 1;

  if (SINGLE_CYCLE) {
    try { await runCycle(cycle); }
    finally { cleanupOnExit(); }
    return;
  }

  console.log(`Starting perpetual loop from cycle ${cycle} (${CYCLE_INTERVAL / 1000}s interval)`);

  try {
    while (true) {
      await runCycle(cycle);
      cycle++;
      log("sleep", `${CYCLE_INTERVAL / 1000}s until cycle ${cycle}`);
      await new Promise(r => setTimeout(r, CYCLE_INTERVAL));
    }
  } finally {
    cleanupOnExit();
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

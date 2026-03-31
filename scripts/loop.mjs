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
 *   WALLET_PASSWORD="xxx" node scripts/loop.mjs --verbose      # verbose logging
 *   WALLET_PASSWORD="xxx" node scripts/loop.mjs --phases 1,2   # run specific phases only
 *
 * Environment:
 *   WALLET_PASSWORD  — required
 *   NETWORK          — mainnet (default) | testnet
 *   CYCLE_INTERVAL   — ms between cycles (default: 300000 = 5 min)
 *   MODEL_HEAVY      — model for coding/PRs (default: opencode-go/glm-5)
 *   MODEL_MEDIUM     — model for decisions/replies (default: opencode-go/kimi-k2.5)
 *   MODEL_LIGHT      — model for simple tasks (default: opencode-go/minimax-m2.5)
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { WalletConfig, getWalletManager, resetWalletManager } from "./wallet.mjs";
import { Heartbeater } from "./phase1.mjs";
import { InboxFetcher } from "./phase2.mjs";
import { Decider } from "./phase3.mjs";
import { Executor } from "./phase4.mjs";
import { Deliverer } from "./phase5.mjs";
import { Outreach } from "./phase6.mjs";
import { Writer } from "./phase7.mjs";
import { Syncer } from "./phase8.mjs";

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
const VERBOSE = process.argv.includes("--verbose");
if (VERBOSE) process.env.VERBOSE = "1";

const PHASES_ARG = process.argv.find(a => a.startsWith("--phases="));
const PHASES = PHASES_ARG
  ? PHASES_ARG.split("=")[1].split(",").map(n => parseInt(n.trim(), 10)).filter(n => n >= 1 && n <= 8)
  : [1, 2, 3, 4, 5, 6, 7, 8];

const CYCLE_INTERVAL = parseInt(process.env.CYCLE_INTERVAL || "300000", 10);
const BACKOFF_ATTEMPTS = 5;
const BACKOFF_DELAY_MS = 60000; // 1 minute

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

let heartbeater = null;
let inboxFetcher = null;
let deliverer = null;
let outreach = null;

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
 * Kills entire process group to prevent orphaned processes.
 * @param {string} prompt
 * @param {object} opts
 * @param {"heavy"|"medium"|"light"} opts.tier - model tier (default: "medium")
 */
function llm(prompt, opts = {}) {
  const tier = opts.tier || "medium";
  const model = MODELS[tier];
  const args = ["run", prompt, "--format", "json", "--dir", ROOT];
  if (model) args.push("-m", model);

  const timeout = opts.timeout || 120000;
  
  // Use spawn (async) so we can kill the entire process group
  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      detached: true, // Create new process group
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeoutId = setTimeout(() => {
      killed = true;
      // Kill entire process group (negative PID)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (e) {
        try {
          child.kill("SIGTERM");
        } catch (e2) { /* ignore */ }
      }
      // Force kill after 5 seconds
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          try {
            child.kill("SIGKILL");
          } catch (e2) { /* ignore */ }
        }
      }, 5000);
    }, timeout);

    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      
      if (killed) {
        console.error(`  [llm] killed after ${timeout}ms timeout`);
        resolve(null);
        return;
      }
      
      if (code !== 0 && code !== null) {
        console.error(`  [llm] opencode exit ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }

      // Parse JSON lines, extract text parts
      const lines = stdout.split("\n").filter(Boolean);
      const texts = [];
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "text" && evt.part?.text) {
            texts.push(evt.part.text);
          }
        } catch { /* skip non-JSON lines */ }
      }
      resolve(texts.join("") || null);
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      console.error(`  [llm] spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

/**
 * Check if another loop.mjs process is currently running (excluding this one).
 * Uses pgrep to find node processes running scripts/loop.mjs.
 */
function isAnotherLoopRunning() {
  try {
    const currentPid = process.pid;
    const parentPid = process.ppid;
    const result = execSync(
      "pgrep -f 'scripts/loop\\.mjs' || true",
      { encoding: "utf8" }
    ).trim();
    
    if (!result) return false;
    
    const pids = result.split("\n").map(p => parseInt(p.trim())).filter(Boolean);
    const excludePids = new Set([currentPid, parentPid, process.pid]);
    return pids.some(pid => !excludePids.has(pid));
  } catch (e) {
    return false;
  }
}

/**
 * Wait with backoff if another loop instance is running.
 * Returns true if we should proceed, false if max attempts reached.
 */
async function waitForBackoff() {
  for (let attempt = 1; attempt <= BACKOFF_ATTEMPTS; attempt++) {
    if (!isAnotherLoopRunning()) {
      return true;
    }
    
    console.log(`[startup] Another loop.mjs instance detected (attempt ${attempt}/${BACKOFF_ATTEMPTS}), waiting ${BACKOFF_DELAY_MS/1000}s...`);
    await new Promise(r => setTimeout(r, BACKOFF_DELAY_MS));
  }
  
  console.error(`[startup] Max backoff attempts (${BACKOFF_ATTEMPTS}) reached, another instance still running. Exiting.`);
  return false;
}

/**
 * Kill all child processes and subprocesses recursively.
 */
function killAllChildren() {
  try {
    // Get all child PIDs of this process
    const result = execSync(
      `pgrep -P ${process.pid} || true`,
      { encoding: "utf8" }
    ).trim();
    
    if (!result) return;
    
    const childPids = result.split("\n").map(p => parseInt(p.trim())).filter(Boolean);
    
    // Kill children recursively first (depth-first)
    for (const pid of childPids) {
      try {
        // Try to get grandchildren
        const grandChildren = execSync(
          `pgrep -P ${pid} || true`,
          { encoding: "utf8" }
        ).trim();
        
        if (grandChildren) {
          const grandPids = grandChildren.split("\n").map(p => parseInt(p.trim())).filter(Boolean);
          for (const gpid of grandPids) {
            try {
              process.kill(gpid, "SIGTERM");
              setTimeout(() => {
                try { process.kill(gpid, "SIGKILL"); } catch (e) {}
              }, 2000);
            } catch (e) {}
          }
        }
        
        // Kill child
        process.kill(pid, "SIGTERM");
        setTimeout(() => {
          try { process.kill(pid, "SIGKILL"); } catch (e) {}
        }, 2000);
      } catch (e) {}
    }
  } catch (e) {
    // Ignore errors during cleanup
  }
}

/**
 * Comprehensive cleanup on exit - kills all subprocesses.
 */
function cleanupOnExit() {
  console.log("\n[cleanup] Shutting down, killing all subprocesses...");
  killAllChildren();
  cleanupOpencode();
  if (walletManager) walletManager.lock();
  resetWalletManager();
  console.log("[cleanup] Done.");
  process.exit(0);
}

/**
 * Cleanup any lingering opencode processes to prevent resource exhaustion.
 * Called at the end of each cycle.
 */
function cleanupOpencode() {
  try {
    // Find and kill any opencode processes running > 60 seconds (orphaned)
    const result = run(
      "ps aux | grep '[o]pencode' | awk '{print $2, $10}' || true",
      { timeout: 5000, fallback: "" }
    );
    if (!result) return;
    
    const lines = result.split("\n").filter(Boolean);
    for (const line of lines) {
      const [pid, timeStr] = line.trim().split(/\s+/);
      if (!pid || !timeStr) continue;
      
      // Parse time (format: MM:SS or HH:MM:SS)
      const timeParts = timeStr.split(":").map(Number);
      let totalSeconds = 0;
      if (timeParts.length === 2) {
        totalSeconds = timeParts[0] * 60 + timeParts[1];
      } else if (timeParts.length === 3) {
        totalSeconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
      }
      
      // Kill processes running longer than 2 minutes (likely orphaned)
      if (totalSeconds > 120) {
        try {
          execSync(`kill -9 ${pid} 2>/dev/null || true`);
          log("cleanup", `killed orphaned opencode pid:${pid} (${timeStr})`);
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    // Silently ignore cleanup errors
  }
}

function log(phase, msg, verboseOnly = false) {
  if (verboseOnly && !VERBOSE) return;
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = verboseOnly ? "[V] " : "";
  console.log(`  ${prefix}[${ts}] ${phase}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Phase 1: Heartbeat
// ---------------------------------------------------------------------------

async function heartbeat() {
  if (!heartbeater) {
    log("heartbeat", "heartbeater not initialized");
    return false;
  }

  const result = await heartbeater.run();
  if (result.ok) {
    log("heartbeat", `OK #${result.checkInCount || "?"} - ${result.responseBody?.slice(0, 100) || ""}`);
    return true;
  }
  log("heartbeat", `failed: ${result.error}`);
  return false;
}

// ---------------------------------------------------------------------------
// Phase 2: Inbox
// ---------------------------------------------------------------------------

async function fetchInbox() {
  if (!inboxFetcher) {
    log("inbox", "inboxFetcher not initialized");
    return [];
  }

  const result = await inboxFetcher.run();
  if (!result.ok) {
    log("inbox", `failed: ${result.error}`);
    return [];
  }

  log("inbox", `${result.stats.total} messages (${result.stats.trustedTasks} trusted task, ${result.stats.untrustedTasks} untrusted task, ${result.stats.normal} normal)`);
  return result.messages;
}

// ---------------------------------------------------------------------------
// Phase 3: Decide (LLM)
// ---------------------------------------------------------------------------

async function decide(cycle, messages) {
  const stateMd = fs.readFileSync(path.join(DAEMON, "STATE.md"), "utf8");
  const contactsMd = fs.existsSync(path.join(MEMORY, "contacts.md"))
    ? fs.readFileSync(path.join(MEMORY, "contacts.md"), "utf8")
    : "";
  const soulMd = fs.existsSync(path.join(ROOT, "SOUL.md"))
    ? fs.readFileSync(path.join(ROOT, "SOUL.md"), "utf8")
    : "";

  log("decide", "spawning decider (opencode medium)...");

  const decider = new Decider({
    cycle,
    messages,
    stateMd,
    contactsMd,
    soulMd,
    model: MODELS.medium,
    timeout: 180000,
  });

  const result = await decider.run();

  if (!result.ok) {
    log("decide", `failed: ${result.error || "non-zero exit"}`);
    return { replies: [], action: null, github: [], heavyPrompt: null, journal: null, state: null };
  }

  if (result.action) log("decide", result.action.slice(0, 80));
  return result;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Phase 6: Outreach
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 7: Write state files
// ---------------------------------------------------------------------------
// Phase 8: Git sync
// ---------------------------------------------------------------------------
// Main cycle
// ---------------------------------------------------------------------------

function shouldRunPhase(n) {
  return PHASES.includes(n);
}

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

  // Phase 1: Heartbeat
  if (shouldRunPhase(1)) {
    hbOk = await heartbeat();
  } else {
    log("phase1", "skipped");
  }

  // Phase 2: Inbox
  if (shouldRunPhase(2)) {
    messages = await fetchInbox();
  } else {
    log("phase2", "skipped");
  }

  // Phase 3: Decide
  if (shouldRunPhase(3)) {
    Object.assign(result, await decide(cycle, messages));
  } else {
    log("phase3", "skipped");
  }

  // Phase 4: Execute
  if (shouldRunPhase(4)) {
    const executor = new Executor();
    if (result.github && result.github.length > 0) {
      log("execute", `running ${result.github.length} gh command(s)...`);
      const ghResult = await executor.runGithub(result.github);
      log("execute", `gh: ${ghResult.executed}/${ghResult.total} commands succeeded`);
    }

    if (result.heavyPrompt) {
      log("execute", "delegating to heavy model...");
      const heavyResult = await executor.runHeavy(result.heavyPrompt, MODELS.heavy, 300000);
      if (heavyResult.ok) {
        log("execute", `heavy: completed`);
      } else {
        log("execute", `heavy: failed - ${heavyResult.error}`);
      }
    } else if (result.action) {
      log("execute", result.action.slice(0, 100));
    }
  } else {
    log("phase4", "skipped");
  }

  // Phase 5: Deliver
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
  } else {
    log("phase5", "skipped");
  }

  // Phase 6: Outreach
  if (shouldRunPhase(6)) {
    log("outreach", "checking for pending follow-ups...");
    const outreachResult = await outreach.run();
    if (outreachResult.sent > 0) {
      log("outreach", `sent ${outreachResult.sent} message(s)`);
    } else if (outreachResult.budgetExhausted) {
      log("outreach", "budget exhausted");
    } else {
      log("outreach", "no messages sent");
    }
  } else {
    log("phase6", "skipped");
  }

  // Phase 7: Write state files
  if (shouldRunPhase(7)) {
    const writer = new Writer();
    const writeResult = await writer.run(cycle, result, hbOk, messages.length, repliesSent, repliesFailed);
    log("write", `wrote: ${writeResult.written.join(", ")}`);
  } else {
    log("phase7", "skipped");
  }

  // Phase 8: Sync
  if (shouldRunPhase(8)) {
    const syncer = new Syncer();
    const syncResult = await syncer.run(cycle, result.action?.slice(0, 60) || "idle cycle");
    if (syncResult.skipped) {
      log("sync", "nothing to commit");
    } else if (syncResult.pushed) {
      log("sync", "committed + pushed");
    } else if (syncResult.error) {
      log("sync", `error: ${syncResult.error}`);
    }
  } else {
    log("phase8", "skipped");
  }

  log("done", `cycle ${cycle} complete`);

  // Cleanup any orphaned opencode processes
  cleanupOpencode();

  // Ensure all subprocesses from this cycle are terminated
  killAllChildren();
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function main() {
  // Register cleanup handlers for graceful shutdown
  process.on("SIGTERM", cleanupOnExit);
  process.on("SIGINT", cleanupOnExit);
  process.on("exit", () => {
    // Synchronous cleanup for exit event
    try {
      execSync(`pkill -9 -P ${process.pid} 2>/dev/null || true`);
    } catch (e) {}
  });

  // Load wallet config (addresses only, no decryption) and unlock
  let walletManager;
  try {
    const config = WalletConfig.load();
    walletManager = getWalletManager(config);
    log("init", `config: stx=${config.stxAddress}, btc=${config.btcAddress}`);

    // Unlock wallet (decrypt mnemonic and derive keys)
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

  // Check for existing instance with backoff
  if (!await waitForBackoff()) {
    process.exit(1);
  }

  const health = readJson(path.join(DAEMON, "health.json"));
  let cycle = (health?.cycle || 0) + 1;

  if (SINGLE_CYCLE) {
    try {
      await runCycle(cycle);
    } finally {
      cleanupOnExit();
    }
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

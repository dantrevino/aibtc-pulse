import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [decider]", ...args);
}

export class Decider {
  #cycle;
  #messages;
  #stateMd;
  #contactsMd;
  #soulMd;
  #model;
  #timeout;
  #result;

  constructor(opts = {}) {
    this.#cycle = opts.cycle || 1;
    this.#messages = opts.messages || [];
    this.#stateMd = opts.stateMd || "";
    this.#contactsMd = opts.contactsMd || "";
    this.#soulMd = opts.soulMd || "";
    this.#model = opts.model || "opencode-go/kimi-k2.5";
    this.#timeout = opts.timeout || 180000;
    this.#result = null;
  }

  #buildPrompt() {
    const inboxSummary = this.#messages.length > 0
      ? this.#messages.map(m =>
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
    }[this.#cycle % 6];

    return `You are Allora, an autonomous AI agent on the AIBTC network.

${this.#soulMd}

## Current State
${this.#stateMd}

## Cycle ${this.#cycle}
Scheduled action: ${modAction}

## Inbox (${this.#messages.length} unread)
${inboxSummary}

## Contacts
${this.#contactsMd}

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

  async run() {
    const prompt = this.#buildPrompt();
    v(`cycle: ${this.#cycle}, model: ${this.#model}`);
    v(`prompt length: ${prompt.length} chars`);

    const args = [
      "run",
      prompt,
      "--format", "json",
      "--dir", process.cwd(),
      "-m", this.#model,
    ];
    v(`opencode args: ${JSON.stringify(args.slice(0, 4))}...`);

    return new Promise((resolve) => {
      const child = spawn("opencode", args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: process.cwd(),
        detached: true,
      });

      let stdout = "";
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 5000);
      }, this.#timeout);

      child.stdout?.on("data", (data) => { stdout += data; });
      child.stderr?.on("data", (data) => { /* discard stderr */ });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (killed) {
          v(`opencode killed after ${this.#timeout}ms`);
          this.#result = {
            ok: false,
            error: `Timed out after ${this.#timeout}ms`,
            replies: [],
            action: null,
            github: [],
            heavyPrompt: null,
            journal: null,
            state: null,
          };
        } else {
          v(`opencode exited with code: ${code}`);
          v(`stdout length: ${stdout.length} chars`);
          this.#result = this.#parseOutput(stdout, code === 0);
          v(`parsed: ${this.#result.replies.length} replies, action=${this.#result.action?.slice(0, 50)}, github=${this.#result.github.length} cmds`);
        }
        resolve(this.#result);
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        v(`spawn error: ${err.message}`);
        this.#result = {
          ok: false,
          error: err.message,
          replies: [],
          action: null,
          github: [],
          heavyPrompt: null,
          journal: null,
          state: null,
        };
        resolve(this.#result);
      });

      v(`spawning opencode (pid: ${child.pid})...`);
    });
  }

  #parseOutput(stdout, success) {
    const replies = [];
    let action = null;
    const github = [];
    let heavyPrompt = null;
    let journal = null;
    let state = null;

    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      let text = line;

      try {
        const evt = JSON.parse(line);
        if (evt.type === "text" && evt.part?.text) {
          text = evt.part.text;
        }
      } catch {}

      text = text.trim();
      if (!text) continue;

      if (text.startsWith("REPLY|")) {
        const parts = text.substring(6).split("|");
        if (parts.length >= 2) {
          replies.push({ messageId: parts[0], text: parts.slice(1).join("|") });
        }
      } else if (text.startsWith("ACTION|")) {
        action = text.substring(7);
      } else if (text.startsWith("GITHUB|")) {
        github.push(text.substring(7));
      } else if (text.startsWith("HEAVY|")) {
        heavyPrompt = text.substring(6);
      } else if (text.startsWith("JOURNAL|")) {
        journal = text.substring(8);
      } else if (text.startsWith("STATE|")) {
        state = text.substring(6);
      }
    }

    return {
      ok: success,
      replies,
      action,
      github,
      heavyPrompt,
      journal,
      state,
    };
  }

  get lastResult() {
    return this.#result;
  }
}
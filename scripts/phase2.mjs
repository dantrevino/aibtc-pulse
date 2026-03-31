import fs from "node:fs";
import path from "node:path";
import { run } from "./shared.mjs";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [inbox]", ...args);
}

export class InboxFetcher {
  #stxAddress;
  #trustedSenders;
  #lastResult;

  constructor(stxAddress) {
    this.#stxAddress = stxAddress;
    this.#trustedSenders = new Set();
    this.#lastResult = null;
  }

  #loadTrustedSenders() {
    const agentsPath = path.join(process.cwd(), "AGENTS.md");
    if (!fs.existsSync(agentsPath)) {
      v("AGENTS.md not found, no trusted senders");
      return;
    }
    const content = fs.readFileSync(agentsPath, "utf8");
    const matches = content.match(/SP[A-Z0-9]{28,41}/g);
    if (matches) {
      matches.forEach(addr => this.#trustedSenders.add(addr));
      v(`loaded ${this.#trustedSenders.size} trusted senders`);
    }
  }

  #isTrusted(sender) {
    return this.#trustedSenders.has(sender);
  }

  #classifyMessage(msg) {
    const sender = msg.fromAddress;
    const isTrusted = this.#isTrusted(sender);
    const content = msg.content || "";
    const hasTaskKeyword = /fork|PR|build|deploy|fix|review|audit/i.test(content);

    let classification;
    if (hasTaskKeyword && isTrusted) {
      classification = "trusted_task";
    } else if (hasTaskKeyword && !isTrusted) {
      classification = "untrusted_task";
    } else {
      classification = "normal";
    }

    v(`message from ${sender}: classification=${classification}`);

    return {
      ...msg,
      isTrusted,
      classification,
    };
  }

  async run() {
    this.#loadTrustedSenders();

    const result = run(
      `curl -s "https://aibtc.com/api/inbox/${this.#stxAddress}?status=unread"`,
      { timeout: 15000 }
    );

    if (!result || result.code !== 0) {
      v(`curl failed: code=${result?.code}, stderr=${result?.stderr}`);
      this.#lastResult = { ok: false, error: `curl failed: ${result?.stderr || "unknown"}`, messages: [] };
      return this.#lastResult;
    }

    let messages = [];
    try {
      const data = JSON.parse(result.stdout);
      messages = data.inbox?.messages || [];
      v(`received ${messages.length} messages`);
    } catch {
      v(`parse error: ${result.stdout.slice(0, 200)}`);
      this.#lastResult = { ok: false, error: "failed to parse response", messages: [] };
      return this.#lastResult;
    }

    const classified = messages.map(m => this.#classifyMessage(m));
    const trustedTasks = classified.filter(m => m.classification === "trusted_task");
    const untrustedTasks = classified.filter(m => m.classification === "untrusted_task");

    this.#lastResult = {
      ok: true,
      messages: classified,
      idle: messages.length === 0,
      stats: {
        total: messages.length,
        trustedTasks: trustedTasks.length,
        untrustedTasks: untrustedTasks.length,
        normal: classified.filter(m => m.classification === "normal").length,
      },
    };

    v(`classified: ${trustedTasks.length} trusted_task, ${untrustedTasks.length} untrusted_task, ${this.#lastResult.stats.normal} normal`);

    return this.#lastResult;
  }

  get lastResult() {
    return this.#lastResult;
  }
}
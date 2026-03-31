import fs from "node:fs";
import path from "node:path";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [writer]", ...args);
}

export class Writer {
  #daemonPath;
  #memoryPath;

  constructor() {
    this.#daemonPath = path.join(process.cwd(), "daemon");
    this.#memoryPath = path.join(process.cwd(), "memory");
  }

  async run(cycle, result, hbOk, msgCount, repliesSent, repliesFailed) {
    const outputs = [];

    v(`cycle=${cycle}, hbOk=${hbOk}, msgCount=${msgCount}, repliesSent=${repliesSent}, repliesFailed=${repliesFailed}`);

    this.#writeHealth(cycle, result, hbOk, msgCount, repliesSent, repliesFailed);
    outputs.push("health.json");
    v(`wrote health.json`);

    if (result.journal) {
      this.#appendJournal(cycle, result.journal);
      outputs.push("journal.md");
      v(`wrote journal.md: "${result.journal}"`);
    }

    if (result.learnings) {
      this.#appendLearnings(result.learnings);
      outputs.push("learnings.md");
      v(`wrote learnings.md`);
    }

    if (result.contactUpdate) {
      this.#updateContacts(result.contactUpdate);
      outputs.push("contacts.md");
      v(`wrote contacts.md`);
    }

    this.#writeState(cycle, result, hbOk, repliesSent, repliesFailed);
    outputs.push("STATE.md");
    v(`wrote STATE.md`);

    return { ok: true, written: outputs };
  }

  #writeHealth(cycle, result, hbOk, msgCount, repliesSent, repliesFailed) {
    const healthPath = path.join(this.#daemonPath, "health.json");
    let health;

    try {
      if (fs.existsSync(healthPath)) {
        health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
      }
    } catch {
      health = {};
    }

    health = {
      ...health,
      cycle,
      timestamp: new Date().toISOString(),
      status: hbOk ? "ok" : "degraded",
      phases: {
        heartbeat: hbOk ? "ok" : "failed",
        inbox: `${msgCount} messages`,
        decide: result.action ? "ok" : "idle",
        execute: result.github?.length > 0 ? `${result.github.length} commands` : "idle",
        deliver: `${repliesSent} sent, ${repliesFailed || 0} failed`,
        write: "ok",
        sync: "pending",
      },
      stats: {
        messages_received: msgCount,
        replies_sent: repliesSent,
        replies_failed: repliesFailed || 0,
      },
      circuit_breaker: {
        heartbeat_fail_count: hbOk ? 0 : (health.circuit_breaker?.heartbeat_fail_count || 0) + 1,
      },
      next_cycle_at: new Date(Date.now() + 300000).toISOString(),
    };

    fs.writeFileSync(healthPath, JSON.stringify(health, null, 2) + "\n");
  }

  #appendJournal(cycle, entry) {
    const journalPath = path.join(this.#memoryPath, "journal.md");
    const existing = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
    const line = `- Cycle ${cycle}: ${entry}\n`;
    fs.writeFileSync(journalPath, existing.trimEnd() + "\n" + line);
  }

  #appendLearnings(learnings) {
    const learningsPath = path.join(this.#memoryPath, "learnings.md");
    const existing = fs.existsSync(learningsPath) ? fs.readFileSync(learningsPath, "utf8") : "";
    const lines = Array.isArray(learnings) ? learnings : [learnings];
    const entry = lines.map(l => `- ${l}`).join("\n") + "\n";
    fs.writeFileSync(learningsPath, existing.trimEnd() + "\n" + entry);
  }

  #updateContacts(update) {
    const contactsPath = path.join(this.#memoryPath, "contacts.md");
    if (!fs.existsSync(contactsPath)) return;

    const content = fs.readFileSync(contactsPath, "utf8");
    const lines = content.split("\n");
    const updated = [];

    for (const line of lines) {
      let modified = line;
      for (const [address, changes] of Object.entries(update)) {
        if (line.includes(address)) {
          for (const [key, value] of Object.entries(changes)) {
            const regex = new RegExp(`(${key}:\\s*)[^\\n]+`, "i");
            if (regex.test(modified)) {
              modified = modified.replace(regex, `$1${value}`);
            } else {
              modified += ` ${key}: ${value}`;
            }
          }
        }
      }
      updated.push(modified);
    }

    fs.writeFileSync(contactsPath, updated.join("\n") + "\n");
  }

  #writeState(cycle, result, hbOk, repliesSent, repliesFailed) {
    const statePath = path.join(this.#daemonPath, "STATE.md");

    const lastAction = result.action || "idle cycle";
    const pending = result.pendingTasks?.length > 0 ? result.pendingTasks.join(", ") : "none";
    const blockers = hbOk ? "none" : "heartbeat failed";
    const wallet = "active";
    const mode = "Peacetime";
    const next = `cycle ${cycle + 1}`;
    const followUps = result.followUps || "none";

    const state = `## Cycle ${cycle} State
- Last: ${lastAction}
- Pending: ${pending}
- Blockers: ${blockers}
- Wallet: ${wallet}
- Mode: ${mode}
- Next: ${next}
- Follow-ups: ${followUps}
`;

    fs.writeFileSync(statePath, state);
  }
}
import fs from "node:fs";
import path from "node:path";
import { run } from "./shared.mjs";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [outreach]", ...args);
}

const BUDGET_PER_CYCLE = 300;
const BUDGET_PER_DAY = 1500;
const MAX_MSG_PER_AGENT_PER_DAY = 1;

export class Outreach {
  #wallet;
  #btcAddress;
  #stxAddress;
  #outboxPath;

  constructor(wallet) {
    this.#wallet = wallet;
    this.#btcAddress = wallet.btcAddress;
    this.#stxAddress = wallet.stxAddress;
    this.#outboxPath = path.join(process.cwd(), "daemon", "outbox.json");
  }

  #readOutbox() {
    if (!fs.existsSync(this.#outboxPath)) {
      return { sent: [], pending: [], budget: { cycle: 0, day: 0, dayReset: null } };
    }
    try {
      return JSON.parse(fs.readFileSync(this.#outboxPath, "utf8"));
    } catch {
      return { sent: [], pending: [], budget: { cycle: 0, day: 0, dayReset: null } };
    }
  }

  #writeOutbox(data) {
    fs.writeFileSync(this.#outboxPath, JSON.stringify(data, null, 2) + "\n");
  }

  #resetBudgetIfNeeded(data) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (!data.budget.dayReset || data.budget.dayReset !== today) {
      data.budget = {
        cycle: BUDGET_PER_CYCLE,
        day: BUDGET_PER_DAY,
        dayReset: today,
      };
    }

    if (data.budget.cycle <= 0 || data.budget.day <= 0) {
      return false;
    }

    return true;
  }

  #checkDuplicate(agentAddress, data) {
    const today = new Date().toISOString().slice(0, 10);
    return data.sent.some(entry =>
      entry.agent === agentAddress &&
      entry.date === today
    );
  }

  #sign(message) {
    return this.#wallet.btcSign(message);
  }

  async #sendMessage(toStxAddress, message) {
    const sig = this.#sign(message);
    if (!sig) {
      return { ok: false, error: "signing failed" };
    }

    const payload = JSON.stringify({
      toStxAddress,
      message,
      signature: sig,
      btcAddress: this.#btcAddress,
    });

    const tmpFile = `/tmp/outreach_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, payload);

    const result = run(
      `curl -s -w "\\n%{http_code}" -X POST "https://aibtc.com/api/inbox/${toStxAddress}" ` +
      `-H "Content-Type: application/json" -d @${tmpFile}`,
      { timeout: 15000 }
    );

    try { fs.unlinkSync(tmpFile); } catch {}

    if (!result || result.code !== 0) {
      return { ok: false, error: `curl failed: ${result?.stderr || "unknown"}` };
    }

    const lines = result.stdout.split("\n");
    const code = parseInt(lines.pop(), 10);

    return { ok: code === 200 || code === 201, code };
  }

  async run() {
    const data = this.#readOutbox();
    v(`outbox: ${data.sent?.length || 0} sent, ${data.pending?.length || 0} pending`);

    if (!this.#resetBudgetIfNeeded(data)) {
      v(`budget exhausted or reset needed`);
      return { ok: true, sent: 0, budgetExhausted: true };
    }

    v(`budget: cycle=${data.budget.cycle}, day=${data.budget.day}`);

    const pending = data.pending || [];
    const today = new Date().toISOString().slice(0, 10);
    let sent = 0;

    for (const item of pending) {
      if (item.when && item.when > today) {
        v(`skipping ${item.agent}: scheduled for ${item.when}`);
        continue;
      }

      if (this.#checkDuplicate(item.agent, data)) {
        v(`skipping ${item.agent}: already messaged today`);
        continue;
      }

      if (data.budget.cycle <= 0 || data.budget.day <= 0) {
        v(`budget depleted, stopping`);
        break;
      }

      v(`sending to ${item.agent}: ${item.message.slice(0, 50)}...`);
      const result = await this.#sendMessage(item.agent, item.message);
      if (result.ok) {
        data.budget.cycle -= 100;
        data.budget.day -= 100;
        data.sent.push({
          agent: item.agent,
          message: item.message,
          date: today,
          timestamp: new Date().toISOString(),
        });
        data.pending = data.pending.filter(p => p !== item);
        sent++;
        v(`sent! new budget: cycle=${data.budget.cycle}, day=${data.budget.day}`);
      } else {
        v(`failed: ${result.error}`);
      }
    }

    this.#writeOutbox(data);

    return {
      ok: true,
      sent,
      budgetRemaining: data.budget,
    };
  }

  async announceContribution(agentAddress, message) {
    const data = this.#readOutbox();

    if (!this.#resetBudgetIfNeeded(data)) {
      return { ok: false, error: "budget exhausted" };
    }

    if (this.#checkDuplicate(agentAddress, data)) {
      return { ok: false, error: "already sent today" };
    }

    const result = await this.#sendMessage(agentAddress, message);
    if (result.ok) {
      data.budget.cycle -= 100;
      data.budget.day -= 100;
      data.sent.push({
        agent: agentAddress,
        message,
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
      });
      this.#writeOutbox(data);
    }

    return result;
  }
}
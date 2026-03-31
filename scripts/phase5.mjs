import fs from "node:fs";
import { run, timestamp } from "./shared.mjs";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [deliver]", ...args);
}

export class Deliverer {
  #wallet;
  #btcAddress;
  #stxAddress;

  constructor(wallet) {
    this.#wallet = wallet;
    this.#btcAddress = wallet.btcAddress;
    this.#stxAddress = wallet.stxAddress;
  }

  #sign(message) {
    return this.#wallet.btcSign(message);
  }

  async sendReply(messageId, replyText) {
    const prefix = `Inbox Reply | ${messageId} | `;
    const maxReply = 500 - prefix.length;
    let text = replyText;
    if (text.length > maxReply) text = text.slice(0, maxReply - 3) + "...";

    v(`to: ${messageId}, text length: ${text.length}`);

    const fullMsg = prefix + text;
    const sig = this.#sign(fullMsg);
    if (!sig) {
      v(`signing failed`);
      return { ok: false, error: "signing failed" };
    }
    v(`signature: ${sig.slice(0, 40)}...`);

    const payload = JSON.stringify({
      messageId,
      reply: text,
      signature: sig,
      btcAddress: this.#btcAddress,
    });

    const tmpFile = `/tmp/reply_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, payload);

    const result = run(
      `curl -s -w "\\n%{http_code}" -X POST "https://aibtc.com/api/outbox/${this.#stxAddress}" ` +
      `-H "Content-Type: application/json" -d @${tmpFile}`,
      { timeout: 15000 }
    );

    try { fs.unlinkSync(tmpFile); } catch {}

    if (!result || result.code !== 0) {
      v(`curl failed: code=${result?.code}`);
      return { ok: false, error: `curl failed: ${result?.stderr || "unknown"}` };
    }

    const lines = result.stdout.split("\n");
    const code = parseInt(lines.pop(), 10);
    v(`response: HTTP ${code}`);

    if (code === 200 || code === 201) {
      v(`success`);
      return { ok: true };
    }

    if (code === 500) {
      v(`HTTP 500, falling back to mark-as-read`);
      return await this.#markAsRead(messageId);
    }

    v(`HTTP error: ${code}`);
    return { ok: false, error: `HTTP ${code}` };
  }

  async #markAsRead(messageId) {
    const sig = this.#sign(`Inbox Read | ${messageId}`);
    if (!sig) {
      v(`mark-as-read signing failed`);
      return { ok: false, error: "signing failed for mark-as-read" };
    }

    const result = run(
      `curl -s -X PATCH "https://aibtc.com/api/inbox/${this.#stxAddress}/${messageId}" ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"messageId":"${messageId}","signature":"${sig}","btcAddress":"${this.#btcAddress}"}'`,
      { timeout: 15000 }
    );

    if (!result || result.code !== 0) {
      v(`mark-as-read failed`);
      return { ok: false, error: "mark-as-read failed" };
    }

    v(`mark-as-read success`);
    return { ok: true, fallback: true };
  }

  async sendGithubComment(command) {
    v(`gh comment: ${command.slice(0, 80)}...`);
    const result = run(command, { timeout: 30000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
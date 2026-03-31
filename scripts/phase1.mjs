import fs from "node:fs";
import { run, timestamp } from "./shared.mjs";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [heartbeat]", ...args);
}

export class Heartbeater {
  #wallet;
  #btcAddress;
  #lastResult;

  constructor(wallet) {
    this.#wallet = wallet;
    this.#btcAddress = wallet.btcAddress;
    this.#lastResult = null;
  }

  async run() {
    const ts = timestamp();
    const message = `AIBTC Check-In | ${ts}`;
    v(`timestamp: ${ts}`);
    v(`message: ${message}`);
    v(`btcAddress: ${this.#btcAddress}`);

    let sig;
    try {
      sig = this.#wallet.btcSign(message);
      v(`signature: ${sig.slice(0, 40)}...`);
    } catch (e) {
      v(`signing error: ${e.message}`);
      this.#lastResult = { ok: false, error: `signing failed: ${e.message}` };
      return this.#lastResult;
    }

    const body = JSON.stringify({
      signature: sig,
      timestamp: ts,
      btcAddress: this.#btcAddress,
    });
    v(`request body: ${body.slice(0, 100)}...`);

    const tmpFile = `/tmp/hb_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, body);

    const result = run(
      `curl -s -w "\\n%{http_code}" -X POST https://aibtc.com/api/heartbeat ` +
      `-H "Content-Type: application/json" -d @${tmpFile}`,
      { timeout: 15000 }
    );

    try { fs.unlinkSync(tmpFile); } catch {}

    if (!result || result.code !== 0) {
      v(`curl failed: code=${result?.code}, stderr=${result?.stderr}`);
      this.#lastResult = { ok: false, error: `curl failed: ${result?.stderr || "unknown"}` };
      return this.#lastResult;
    }

    const lines = result.stdout.split("\n");
    const code = parseInt(lines.pop(), 10);
    const respBody = lines.join("\n");
    v(`response: HTTP ${code}, body: ${respBody.slice(0, 200)}...`);

    if (code === 200 || code === 201) {
      let checkInCount;
      try {
        const data = JSON.parse(respBody);
        checkInCount = data.checkIn?.checkInCount;
        v(`parsed response: checkInCount=${checkInCount}`);
      } catch {}
      this.#lastResult = { ok: true, checkInCount, responseBody: respBody };
      return this.#lastResult;
    }

    v(`HTTP error: ${code}`);
    this.#lastResult = { ok: false, error: `HTTP ${code}`, responseBody: respBody };
    return this.#lastResult;
  }

  get lastResult() {
    return this.#lastResult;
  }

  get btcAddress() {
    return this.#btcAddress;
  }
}
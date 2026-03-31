import { run } from "./shared.mjs";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [syncer]", ...args);
}

export class Syncer {
  #lastResult;

  constructor() {
    this.#lastResult = null;
  }

  async run(cycle, summary) {
    const commitMsg = `Cycle ${cycle}: ${summary}`;
    v(`commit message: "${commitMsg}"`);

    const addResult = run("git add daemon/ memory/", { timeout: 10000 });
    v(`git add: code=${addResult.code}`);
    if (addResult.code !== 0) {
      v(`git add failed: ${addResult.stderr}`);
      this.#lastResult = { ok: false, committed: false, pushed: false, error: addResult.stderr };
      return this.#lastResult;
    }

    const commitResult = run(
      `git commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
      { timeout: 10000 }
    );
    v(`git commit: code=${commitResult.code}`);

    if (commitResult.code !== 0) {
      if (commitResult.stdout?.includes("nothing to commit")) {
        v(`nothing to commit`);
        this.#lastResult = { ok: true, committed: false, pushed: false, skipped: true };
        return this.#lastResult;
      }
      v(`git commit failed: ${commitResult.stderr}`);
      this.#lastResult = { ok: false, committed: false, pushed: false, error: commitResult.stderr };
      return this.#lastResult;
    }

    const pushResult = run("git push origin main", { timeout: 30000 });
    v(`git push: code=${pushResult.code}`);
    if (pushResult.code !== 0) {
      v(`git push failed: ${pushResult.stderr}`);
      this.#lastResult = { ok: false, committed: true, pushed: false, error: pushResult.stderr };
      return this.#lastResult;
    }

    v(`success: committed and pushed`);
    this.#lastResult = { ok: true, committed: true, pushed: true };
    return this.#lastResult;
  }

  get lastResult() {
    return this.#lastResult;
  }
}
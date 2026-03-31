import { Subprocess } from "./subprocess.mjs";
import { run } from "./shared.mjs";

const VERBOSE = process.env.VERBOSE === "1";

function v(...args) {
  if (VERBOSE) console.error("[VERBOSE] [executor]", ...args);
}

export class Executor {
  #result;
  #ghResults;

  constructor() {
    this.#result = null;
    this.#ghResults = [];
  }

  async runGithub(commands) {
    if (!commands || commands.length === 0) {
      v("no commands to run");
      return { ok: true, executed: 0 };
    }

    v(`running ${commands.length} gh command(s)`);
    let executed = 0;
    for (const cmd of commands) {
      if (!cmd.startsWith("gh ")) {
        v(`skipping non-gh command: ${cmd.slice(0, 50)}...`);
        this.#ghResults.push({ cmd, ok: false, error: "only gh commands allowed" });
        continue;
      }

      v(`gh: ${cmd.slice(0, 80)}...`);
      const result = run(cmd, { timeout: 60000 });
      const ok = result.code === 0;
      v(`  result: code=${result.code}, stdout=${result.stdout.slice(0, 100)}...`);
      this.#ghResults.push({
        cmd,
        ok,
        stdout: result.stdout,
        stderr: result.stderr,
      });

      if (ok) executed++;
    }

    this.#result = {
      ok: executed === commands.length,
      executed,
      total: commands.length,
      results: this.#ghResults,
    };

    v(`completed: ${executed}/${commands.length} succeeded`);
    return this.#result;
  }

  async runHeavy(prompt, model = "opencode-go/glm-5", timeout = 300000) {
    v(`model=${model}, timeout=${timeout}ms, prompt length=${prompt.length} chars`);

    const args = [
      "run",
      prompt,
      "--format", "json",
      "--dir", process.cwd(),
      "-m", model,
    ];

    const proc = new Subprocess("opencode", args, {});
    v(`spawning opencode (pid: ${proc.pid})...`);

    try {
      await proc.wait(timeout);
      v(`exited: status=${proc.status}, code=${proc.exitCode}, stdout len=${proc.stdout.length}`);
      this.#result = {
        ok: proc.status === "done",
        executed: 1,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exitCode: proc.exitCode,
      };
      return this.#result;
    } catch (e) {
      v(`error: ${e.message}`);
      this.#result = {
        ok: false,
        executed: 0,
        error: e.message,
      };
      return this.#result;
    }
  }

  get lastResult() {
    return this.#result;
  }

  get ghResults() {
    return this.#ghResults;
  }
}
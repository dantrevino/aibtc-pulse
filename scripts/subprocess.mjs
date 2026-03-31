import { spawn } from "node:child_process";

export class Subprocess {
  pid = null;
  args = [];
  env = {};
  proc = null;
  status = "pending";
  exitCode = null;
  stdout = "";
  stderr = "";

  constructor(cmd, args = [], env = {}) {
    this.cmd = cmd;
    this.args = args;
    this.env = { ...process.env, ...env };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.status = "running";
      this.proc = spawn(this.cmd, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });

      this.pid = this.proc.pid;

      this.proc.stdout?.on("data", (data) => { this.stdout += data; });
      this.proc.stderr?.on("data", (data) => { this.stderr += data; });

      this.proc.on("close", (code) => {
        this.exitCode = code;
        this.status = code === 0 ? "done" : "failed";
        resolve(code);
      });

      this.proc.on("error", (err) => {
        this.status = "failed";
        this.stderr += err.message;
        reject(err);
      });
    });
  }

  kill() {
    if (!this.proc) return;
    this.status = "killed";
    try {
      process.kill(this.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(this.pid, "SIGKILL");
      } catch {}
    }, 2000);
  }

  wait(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.status === "done" || this.status === "failed") {
        resolve(this.exitCode);
        return;
      }

      const timeout = setTimeout(() => {
        this.kill();
        reject(new Error(`Subprocess timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.proc?.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });

      this.proc?.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
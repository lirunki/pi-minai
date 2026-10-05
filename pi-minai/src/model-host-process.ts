import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ModelHostProcessOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Pipe child stdout/stderr into the parent process (pollutes the pi window). */
  inheritOutput?: boolean;
  /** Write child stdout/stderr to this file instead. Default when neither inheritOutput nor logFile is set. */
  logFile?: string;
};

/** Owns an optional external model-host child process without making the registry a supervisor. */
export class ModelHostProcess {
  private child?: ChildProcess;
  private logFds: number[] = [];
  constructor(private readonly options: ModelHostProcessOptions, private readonly ready: () => Promise<boolean>) {}
  get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }
  /** Where child output goes; undefined when inherited. */
  get logPath(): string | undefined { if (this.options.inheritOutput) return undefined; return this.options.logFile ?? path.join(os.tmpdir(), `minai-${path.basename(this.options.command)}.log`); }
  async start(): Promise<void> {
    if (this.running) return;
    if (await this.ready().catch(() => false)) return;
    const env = { ...process.env, ...(this.options.env ?? {}) };
    const stdio: "inherit" | "ignore" | ["ignore", number, number] = (() => {
      if (this.options.inheritOutput) return "inherit";
      const logPath = this.logPath!;
      try { this.logFds = [openSync(logPath, "a"), openSync(logPath, "a")]; return ["ignore", this.logFds[0]!, this.logFds[1]!] as ["ignore", number, number]; } catch { return "ignore"; }
    })();
    this.child = spawn(this.options.command, this.options.args ?? [], { cwd: this.options.cwd, env, stdio });
    const timeout = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    while (Date.now() < timeout) { if (!this.running) throw new Error(`Model host exited while starting: ${this.options.command} (log: ${this.logPath ?? "discarded"})`); if (await this.ready()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
    await this.stop();
    throw new Error(`Model host did not become ready: ${this.options.command} (log: ${this.logPath ?? "discarded"})`);
  }
  async stop(): Promise<void> {
    const child = this.child; if (!child) { this.closeLogFds(); return; }
    if (child.exitCode === null) { child.kill("SIGTERM"); const timeout = this.options.shutdownTimeoutMs ?? 5_000; await new Promise<void>((resolve) => { const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, timeout); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
    this.child = undefined;
    this.closeLogFds();
  }
  private closeLogFds(): void { for (const fd of this.logFds) { try { closeSync(fd); } catch {} } this.logFds = []; }
}

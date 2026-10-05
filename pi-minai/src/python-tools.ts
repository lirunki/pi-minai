import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ContractValidationError, MinaiPiError } from "./errors.js";

export type PythonToolStatus = "draft" | "active" | "disabled";
export type PythonPermission = "filesystem" | "network" | "subprocess";

export type PythonToolManifest = {
  name: string;
  description: string;
  tags?: string[];
  inputSchema: Record<string, unknown>;
  entrypoint: string;
  permissions: PythonPermission[];
  version: string;
  status: PythonToolStatus;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type PythonToolResult =
  | { ok: true; value: unknown; stdout?: string; stderr?: string }
  | { ok: false; error: string; code: "tool_unknown" | "tool_inactive" | "tool_permission" | "tool_path" | "tool_timeout" | "tool_aborted" | "tool_exit" | "tool_output" | "tool_runner"; stdout?: string; stderr?: string };

export interface PythonToolCatalogService {
  list(): PythonToolManifest[];
  get(name: string): PythonToolManifest | undefined;
  register(manifest: PythonToolManifest): void;
}

export interface PythonToolRunnerService {
  run(name: string, args: unknown, signal?: AbortSignal): Promise<PythonToolResult>;
}

function validateManifest(manifest: PythonToolManifest): PythonToolManifest {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(manifest.name)) throw new ContractValidationError("Python tool name is invalid");
  if (!manifest.description.trim() || !manifest.entrypoint.trim() || !manifest.version.trim()) throw new ContractValidationError(`Python tool ${manifest.name} has missing text fields`);
  if (!Array.isArray(manifest.permissions) || manifest.permissions.some((permission) => !["filesystem", "network", "subprocess"].includes(permission))) throw new ContractValidationError(`Python tool ${manifest.name} has invalid permissions`);
  if (manifest.timeoutMs !== undefined && (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 1)) throw new ContractValidationError(`Python tool ${manifest.name} has invalid timeout`);
  if (manifest.maxOutputBytes !== undefined && (!Number.isInteger(manifest.maxOutputBytes) || manifest.maxOutputBytes < 1)) throw new ContractValidationError(`Python tool ${manifest.name} has invalid output limit`);
  return manifest;
}

export class InMemoryPythonToolCatalog implements PythonToolCatalogService {
  private readonly tools = new Map<string, PythonToolManifest>();
  constructor(manifests: PythonToolManifest[] = []) { manifests.forEach((manifest) => this.register(manifest)); }
  list(): PythonToolManifest[] { return [...this.tools.values()].map((manifest) => structuredClone(manifest)); }
  get(name: string): PythonToolManifest | undefined { const manifest = this.tools.get(name); return manifest ? structuredClone(manifest) : undefined; }
  register(manifest: PythonToolManifest): void {
    const validated = validateManifest(structuredClone(manifest));
    if (this.tools.has(validated.name)) throw new ContractValidationError(`Python tool already exists: ${validated.name}`);
    this.tools.set(validated.name, validated);
  }
}

export class PythonToolError extends MinaiPiError {
  constructor(message: string, code: "tool_permission" | "tool_path" | "tool_runner") { super(message, code); this.name = "PythonToolError"; }
}

export type PythonToolRunnerOptions = {
  workspaceRoot: string;
  pythonExecutable?: string;
  allowedPermissions?: PythonPermission[];
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
};

export class SubprocessPythonToolRunner implements PythonToolRunnerService {
  constructor(private readonly catalog: PythonToolCatalogService, private readonly options: PythonToolRunnerOptions) {}

  async run(name: string, args: unknown, signal?: AbortSignal): Promise<PythonToolResult> {
    const manifest = this.catalog.get(name);
    if (!manifest) return { ok: false, error: `Unknown Python tool: ${name}`, code: "tool_unknown" };
    if (manifest.status !== "active") return { ok: false, error: `Python tool is not active: ${name}`, code: "tool_inactive" };
    const allowed = new Set(this.options.allowedPermissions ?? []);
    if (manifest.permissions.some((permission) => !allowed.has(permission))) return { ok: false, error: `Python tool requests disallowed permissions: ${name}`, code: "tool_permission" };
    if (signal?.aborted) return { ok: false, error: "Python tool was aborted", code: "tool_aborted" };

    let root: string;
    let entrypoint: string;
    try {
      root = await realpath(this.options.workspaceRoot);
      entrypoint = await realpath(path.resolve(root, manifest.entrypoint));
    } catch {
      return { ok: false, error: `Python entrypoint does not exist: ${manifest.entrypoint}`, code: "tool_path" };
    }
    if (entrypoint !== root && !entrypoint.startsWith(`${root}${path.sep}`)) return { ok: false, error: "Python entrypoint escapes workspace", code: "tool_path" };

    const timeoutMs = manifest.timeoutMs ?? this.options.defaultTimeoutMs ?? 10_000;
    const maxOutputBytes = manifest.maxOutputBytes ?? this.options.defaultMaxOutputBytes ?? 1_000_000;
    return new Promise<PythonToolResult>((resolve) => {
      const child = spawn(this.options.pythonExecutable ?? "python3", ["-I", entrypoint], { cwd: root, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let exceeded = false;
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > maxOutputBytes) { exceeded = true; child.kill("SIGKILL"); return; }
        if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const abort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ ok: false, error: error.message, code: "tool_runner", stdout, stderr }); });
      child.on("close", (code) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return resolve({ ok: false, error: "Python tool was aborted", code: "tool_aborted", stdout, stderr });
        if (exceeded) return resolve({ ok: false, error: "Python tool output exceeded limit", code: "tool_output", stdout, stderr });
        if (code === null) return resolve({ ok: false, error: "Python tool timed out", code: "tool_timeout", stdout, stderr });
        if (code !== 0) return resolve({ ok: false, error: `Python tool exited with code ${code}`, code: "tool_exit", stdout, stderr });
        try { resolve({ ok: true, value: JSON.parse(stdout), stdout, stderr }); }
        catch { resolve({ ok: false, error: "Python tool returned invalid JSON", code: "tool_output", stdout, stderr }); }
      });
      child.stdin.end(JSON.stringify(args));
    });
  }
}

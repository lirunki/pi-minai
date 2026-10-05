import { readFile, readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { StaticGuidanceCatalog, type GuidanceCatalogService, type GuidanceRecord } from "./guidance.js";

function string(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
async function files(root: string): Promise<string[]> { const entries = await readdir(root, { withFileTypes: true }); const result: string[] = []; for (const entry of entries) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") result.push(path); } return result; }
async function expand(value: unknown, root: string): Promise<string> { const text = string(value); const match = /^<<(.+)>>$/.exec(text.trim()); if (!match) return text; const reference = match[1]!.trim(); if (!reference.startsWith("./")) return text; return readFile(join(root, reference.slice(2)), "utf8"); }

/** Loads the existing Python MINAI guidance JSON shape without importing Python. */
export async function loadGuidanceCatalog(root: string): Promise<GuidanceCatalogService> {
  const records: GuidanceRecord[] = [];
  for (const source of await files(root)) {
    const raw = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
    const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
    const rawInstances = Array.isArray(raw.instances) ? raw.instances : [];
    const instances = [];
    for (const item of rawInstances) {
      const value = item as Record<string, unknown>;
      instances.push({
        ...(typeof value.model_class_regex === "string" ? { modelClassRegex: value.model_class_regex } : {}),
        instructions: await expand(value.instructions, root),
        ...(value.instructions_final === undefined ? {} : { instructionsFinal: await expand(value.instructions_final, root) }),
        ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
        ...(typeof value.rank === "number" ? { rank: value.rank } : {}),
      });
    }
    const id = basename(source, ".json").replace(/[^A-Za-z0-9_-]+/g, "_");
    records.push({ id, description: string(metadata.description, id), ...(typeof metadata.purpose === "string" ? { purpose: metadata.purpose } : {}), ...(Array.isArray(metadata.tags) ? { tags: metadata.tags.filter((tag): tag is string => typeof tag === "string") } : {}), instances });
  }
  return new StaticGuidanceCatalog(records);
}

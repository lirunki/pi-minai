import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGuidanceCatalog } from "../src/guidance-files.js";
import type { GuidanceCatalogService } from "../src/guidance.js";
import { GuidanceSelector } from "../src/guidance.js";
import { minaiServices } from "../src/minai-services.js";

let catalog: GuidanceCatalogService | undefined;
export function getLoadedGuidanceCatalog(): GuidanceCatalogService | undefined { return catalog; }
export async function loadProjectGuidances(root = process.env.MINAI_GUIDANCE_ROOT ?? "guidances"): Promise<GuidanceCatalogService> { catalog = await loadGuidanceCatalog(root); minaiServices.replace("catalog:guidance", catalog); minaiServices.replace("selector:guidance", new GuidanceSelector(catalog)); return catalog; }

export default function guidanceExtension(pi: ExtensionAPI): void {
  pi.registerCommand("minai-guidances", { description: "List loaded MINAI guidance definitions", handler: async (_args, ctx) => { try { const loaded = catalog ?? await loadProjectGuidances(); ctx.ui.notify(loaded.list().map((guidance) => `${guidance.id}: ${guidance.description}`).join("\n"), "info"); } catch (error) { ctx.ui.notify(`Could not load guidances: ${error instanceof Error ? error.message : String(error)}`, "error"); } } });
  pi.registerCommand("minai-guidance", { description: "Resolve a MINAI guidance by id", handler: async (args, ctx) => { const id = args.trim(); if (!id) { ctx.ui.notify("Usage: /minai-guidance <id>", "warning"); return; } try { const loaded = catalog ?? await loadProjectGuidances(); const guidance = loaded.get(id); if (!guidance) { ctx.ui.notify(`Unknown guidance: ${id}`, "warning"); return; } const instance = loaded.resolve(id, ""); ctx.ui.notify(JSON.stringify({ id, description: guidance.description, purpose: guidance.purpose, tags: guidance.tags, instructions: instance.instructions }, null, 2), "info"); } catch (error) { ctx.ui.notify(`Could not resolve guidance: ${error instanceof Error ? error.message : String(error)}`, "error"); } } });
}

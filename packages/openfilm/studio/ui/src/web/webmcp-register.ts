/**
 * The registration half (kept beside the defs): tolerant, idempotent, honest. The native
 * modelContext when present, else the vendored official polyfill; per-tool failures recorded,
 * never fatal (StrictMode double-run registers the same names twice — the polyfill overwrites,
 * the native may refuse duplicates).
 */
import { ensureModelContext, filmToolDefs, type ModelContextLike, type WebMCPToolDef } from './webmcp.ts';
import { editFamilyTools } from './webmcp-edit.ts';

export interface RegisterResult {
  /** Whether the environment supports WebMCP at all (native or polyfill). */
  supported: boolean;
  registered: string[];
  failures: Array<{ name: string; error: string }>;
}

/** Register the film's four families. `openProject` = the App's navigation (projects_open). */
export async function registerWebMCPTools(openProject: (id: string) => void): Promise<RegisterResult> {
  const mc: ModelContextLike | null = await ensureModelContext();
  if (!mc) return { supported: false, registered: [], failures: [] };
  /* the edit family's verbs ride beside the four families' tools (4.2, T07) */
  const defs: WebMCPToolDef[] = [...filmToolDefs(openProject), ...editFamilyTools()];
  const registered: string[] = [];
  const failures: RegisterResult['failures'] = [];
  for (const def of defs) {
    try {
      await mc.registerTool(def);
      registered.push(def.name);
    } catch (e) {
      failures.push({ name: def.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { supported: true, registered, failures };
}

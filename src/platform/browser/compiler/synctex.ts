import type { ReviewSourceLocation } from "@/core/review/model";
import type { ReanchorBox } from "@/core/review/reanchor";
import {
  forwardSearchSyncTex,
  parseSyncTex,
  synctexBoxToRect,
} from "@/core/synctex/parse";

/**
 * Decompress a `.synctex.gz` buffer as the engine emits it (ADR-010, ADR-012).
 *
 * `LatexCompiler.compile()`'s `synctex` field is the gzip container's raw
 * bytes (`texlyre-busytex`'s own documentation calls it out:
 * `application/gzip`), not the SyncTeX text inside it. Kept as its own module
 * rather than folded into `indexed-bundle.ts`'s private `gunzip`: that one
 * exists to inflate archive entries, this exists to inflate a compile
 * artifact, and the only thing they share is calling the same browser API.
 */
export async function decompressSyncTex(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buffer);
}

/**
 * `ReanchorContext["forwardSearch"]`, backed by a real `.synctex.gz`.
 *
 * Decompresses and parses once per call, not once per source: parsing is the
 * expensive part, and `reanchorAnnotations` already batches every unplaced
 * annotation into one call for exactly this reason. Not wired into
 * `WorkspaceScreen` yet — see ADR-012 for what remains.
 */
export async function synctexForwardSearch(
  gzBytes: Uint8Array,
  sources: readonly ReviewSourceLocation[],
): Promise<(ReanchorBox | null)[]> {
  const doc = parseSyncTex(await decompressSyncTex(gzBytes));
  return sources.map((source) => {
    const hit = forwardSearchSyncTex(doc, source.file, source.line)[0];
    return hit ? { page: hit.page, ...synctexBoxToRect(doc, hit.box) } : null;
  });
}

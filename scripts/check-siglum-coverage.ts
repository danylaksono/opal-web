/**
 * Corpus coverage against @siglum/engine's own manifests (ADR-003).
 *
 * Resolution goes through `file-manifest.json`, which maps every shipped TeX
 * Live path to the bundle and byte range holding it. That is authoritative:
 * `bundles.json`'s `packages` map only names packages that can be requested by
 * name, so treating absence from it as "not shipped" wrongly reports base LaTeX
 * as missing.
 *
 * Distinguishes the three states that matter for the offline policy in
 * PLAN.md 7.3: in the engine's baseline bundles, in a bundle fetched on demand,
 * or not bundled at all and therefore needing a CTAN fetch.
 *
 * Usage: pnpm spike:siglum [engine]   (default: xelatex, matching desktop)
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const ASSET_ROOT = resolve("public/engines/siglum/bundles");

interface CorpusEntry {
  id: string;
  documentClass: string;
  packages: string[];
}

interface BundlesManifest {
  bundles: Record<string, { files: number; size: number }>;
  engines: Record<string, { required: string[] }>;
  deferred: string[];
}

type FileManifest = Record<string, { bundle: string }>;

type Availability = "baseline" | "on-demand" | "ctan";

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(ASSET_ROOT, name), "utf8")) as T;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const engineName = process.argv[2] ?? "xelatex";

  const manifest = await readJson<BundlesManifest>("bundles.json");
  const fileManifest = await readJson<FileManifest>("file-manifest.json");
  const corpus: { entries: CorpusEntry[] } = JSON.parse(
    await readFile(
      resolve("tests/fixtures/compiler-corpus/manifest.json"),
      "utf8",
    ),
  );

  const engine = manifest.engines[engineName];
  if (!engine) {
    throw new Error(
      `Unknown engine ${engineName}. Available: ${Object.keys(manifest.engines).join(", ")}`,
    );
  }

  // One basename can appear in several bundles (a package and its dev variant).
  const bundlesByFile = new Map<string, Set<string>>();
  for (const [path, info] of Object.entries(fileManifest)) {
    const name = basename(path);
    let set = bundlesByFile.get(name);
    if (!set) {
      set = new Set();
      bundlesByFile.set(name, set);
    }
    set.add(info.bundle);
  }

  const baseline = new Set(engine.required);
  const baselineBytes = engine.required.reduce(
    (total, name) => total + (manifest.bundles[name]?.size ?? 0),
    0,
  );

  console.log(`Engine: ${engineName} (Siglum, TeX Live 2025)`);
  console.log(
    `Baseline: ${engine.required.length} bundles, ${formatMb(baselineBytes)} uncompressed`,
  );
  console.log(`Deferred: ${manifest.deferred.join(", ")}\n`);

  function locate(
    name: string,
    isClass: boolean,
  ): { state: Availability; bundles: string[] } {
    const candidates = isClass
      ? [`${name}.cls`, `${name}.sty`]
      : [`${name}.sty`, `${name}.cls`];
    for (const candidate of candidates) {
      const bundles = bundlesByFile.get(candidate);
      if (!bundles) continue;
      const sorted = [...bundles].sort();
      return {
        state: sorted.some((bundle) => baseline.has(bundle))
          ? "baseline"
          : "on-demand",
        bundles: sorted,
      };
    }
    return { state: "ctan", bundles: [] };
  }

  const tally: Record<Availability, number> = {
    baseline: 0,
    "on-demand": 0,
    ctan: 0,
  };
  const ctanNames = new Set<string>();
  const blockedProjects: string[] = [];

  console.log("Per project:");
  for (const entry of corpus.entries) {
    const refs: Array<[string, boolean]> = [
      [entry.documentClass, true],
      ...entry.packages.map((name): [string, boolean] => [name, false]),
    ];

    const extraBundles = new Set<string>();
    const ctan: string[] = [];

    for (const [name, isClass] of refs) {
      const { state, bundles } = locate(name, isClass);
      tally[state]++;
      if (state === "ctan") {
        ctan.push(name);
        ctanNames.add(name);
      } else if (state === "on-demand") {
        for (const bundle of bundles) {
          if (!baseline.has(bundle)) extraBundles.add(bundle);
        }
      }
    }

    if (ctan.length > 0) blockedProjects.push(entry.id);

    const parts: string[] = [];
    if (extraBundles.size > 0) {
      parts.push(`+bundles: ${[...extraBundles].sort().join(", ")}`);
    }
    if (ctan.length > 0) parts.push(`CTAN: ${ctan.join(", ")}`);
    console.log(
      `  ${entry.id.padEnd(22)} ${parts.length ? parts.join(" | ") : "baseline only"}`,
    );
  }

  const total = tally.baseline + tally["on-demand"] + tally.ctan;
  console.log(`\nName resolution across the corpus (${total} references):`);
  console.log(`  in the ${engineName} baseline : ${tally.baseline}`);
  console.log(`  in an on-demand bundle       : ${tally["on-demand"]}`);
  console.log(`  needs a CTAN fetch           : ${tally.ctan}`);
  console.log(
    `\n${blockedProjects.length}/${corpus.entries.length} projects depend on the CTAN path working.`,
  );
  console.log(
    `CTAN-only names: ${ctanNames.size ? [...ctanNames].sort().join(", ") : "none"}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

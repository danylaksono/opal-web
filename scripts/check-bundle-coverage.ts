/**
 * Cross-reference the compiler corpus against a candidate engine's bundle
 * manifest (ADR-003, PLAN.md 7.3 "TeX resources and offline policy").
 *
 * Answers the package-delivery question before any large download: which of the
 * corpus's classes and packages a bundle tier actually provides, and what is
 * left over. A name missing from every tier is a documented incompatibility,
 * which PLAN.md 7.4 requires us to publish rather than hide.
 *
 * Usage: pnpm spike:coverage <path-to-engine-manifest.json>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * `\usepackage{x}` names a *file*, `x.sty`; a bundle manifest lists TeX Live
 * *package* names, and one package ships many files. Comparing the two
 * namespaces directly reports base LaTeX as missing, so the corpus names are
 * translated here first.
 *
 * This table covers the corpus only. It is hand-built from TeX Live's own
 * grouping and is deliberately explicit: an automatic mapping needs the tlpdb
 * file index, which is not something to infer. Anything absent maps to itself,
 * which is correct for the many packages whose file and package names agree.
 */
const FILE_TO_TEXLIVE_PACKAGE: Record<string, string> = {
  // LaTeX base: classes and the encoding packages ship together.
  article: "latex",
  book: "latex",
  report: "latex",
  fontenc: "latex",
  inputenc: "latex",
  // The graphics bundle.
  graphicx: "graphics",
  // AMS is split across three TeX Live packages.
  amssymb: "amsfonts",
  amsmath: "amsmath",
  amsthm: "amscls",
  // The `tools` bundle.
  multicol: "tools",
  tabularx: "tools",
  // Latin Modern.
  lmodern: "lm",
  // TikZ ships inside PGF.
  tikz: "pgf",
  // The algorithms bundle provides both.
  algorithm: "algorithms",
  algorithmic: "algorithms",
  // Third-party classes, named lowercase in TeX Live.
  IEEEtran: "ieeetran",
};

interface CorpusEntry {
  id: string;
  documentClass: string;
  packages: string[];
}

interface EngineBundle {
  name: string;
  bytes: number;
  provides: string[];
}

interface EngineManifest {
  version: string;
  texliveSnapshot: { release: string; tlpdbRevision: number };
  engines: string[];
  bundles: EngineBundle[];
}

function texlivePackage(fileName: string): string {
  return FILE_TO_TEXLIVE_PACKAGE[fileName] ?? fileName;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error(
      "Usage: pnpm spike:coverage <path-to-engine-manifest.json>",
    );
  }

  const engine: EngineManifest = JSON.parse(
    await readFile(resolve(manifestPath), "utf8"),
  );
  const corpus: { entries: CorpusEntry[] } = JSON.parse(
    await readFile(
      resolve("tests/fixtures/compiler-corpus/manifest.json"),
      "utf8",
    ),
  );

  console.log(
    `Engine: TeX Live ${engine.texliveSnapshot.release} (tlpdb r${engine.texliveSnapshot.tlpdbRevision}), assets ${engine.version}`,
  );
  console.log(`Binaries: ${engine.engines.join(", ")}\n`);

  const byBytes = engine.bundles.slice().sort((a, b) => a.bytes - b.bytes);
  const required = new Map<string, string>();
  for (const entry of corpus.entries) {
    for (const file of [entry.documentClass, ...entry.packages]) {
      required.set(file, texlivePackage(file));
    }
  }

  const cumulative = new Set<string>();
  for (const bundle of byBytes) {
    const provides = new Set(bundle.provides);
    let added = 0;
    for (const [, pkg] of required) {
      if (provides.has(pkg) && !cumulative.has(pkg)) {
        cumulative.add(pkg);
        added++;
      }
    }
    const distinct = new Set(required.values());
    console.log(
      `Bundle "${bundle.name}" (${formatMb(bundle.bytes)}, ${bundle.provides.length} packages)`,
    );
    console.log(
      `  cumulative corpus coverage: ${cumulative.size}/${distinct.size} packages (+${added})`,
    );
  }

  const unresolved = [...required]
    .filter(([, pkg]) => !cumulative.has(pkg))
    .map(([file, pkg]) => (file === pkg ? file : `${file} (${pkg})`))
    .sort();
  console.log(
    `\nProvided by no bundle: ${unresolved.length ? unresolved.join(", ") : "none"}`,
  );

  const core = byBytes[0];
  const coreProvides = new Set(core?.provides ?? []);
  const allProvides = new Set(engine.bundles.flatMap((b) => b.provides));

  console.log("\nPer project:");
  for (const entry of corpus.entries) {
    const files = [entry.documentClass, ...entry.packages];
    const beyondCore = files.filter(
      (file) => !coreProvides.has(texlivePackage(file)),
    );
    const unavailable = files.filter(
      (file) => !allProvides.has(texlivePackage(file)),
    );

    const verdict =
      unavailable.length > 0
        ? `BLOCKED — no bundle provides ${unavailable.join(", ")}`
        : beyondCore.length === 0
          ? `"${core?.name}" alone`
          : `needs a larger bundle for ${beyondCore.join(", ")}`;
    console.log(`  ${entry.id.padEnd(22)} ${verdict}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

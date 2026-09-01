/**
 * Build the compiler acceptance corpus from the desktop repository
 * (PLAN.md 7.4, backlog "Build the 13-template compiler corpus manifest").
 *
 * The corpus is copied rather than referenced across repositories on purpose:
 * PLAN.md 18 rules out cross-repository source links, and a pinned copy is what
 * makes an engine comparison reproducible after desktop moves on.
 *
 * Usage: pnpm spike:corpus [pathToDesktopRepo]
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const DEFAULT_DESKTOP = resolve("../tectonic-editor");
const desktopRoot = resolve(process.argv[2] ?? DEFAULT_DESKTOP);
const examplesRoot = join(desktopRoot, "apps/desktop/public/examples");
const corpusRoot = resolve("tests/fixtures/compiler-corpus");

/** Packages we already expect to be hard for a browser TeX distribution. */
const HEAVY_PACKAGES = new Set([
  "fontawesome5",
  "siunitx",
  "tcolorbox",
  "tikz",
  "pgfplots",
  "microtype",
  "algorithm",
  "algorithmic",
  "listings",
]);

/** Classes that are not part of a minimal TeX baseline. */
const HEAVY_CLASSES = new Set(["acmart", "IEEEtran", "beamer"]);

interface CorpusEntry {
  id: string;
  mainFile: string;
  files: string[];
  documentClass: string;
  classOptions: string[];
  packages: string[];
  heavyPackages: string[];
  heavyDocumentClass: boolean;
  needsBibliography: boolean;
  bibliographyEngine: "natbib" | "cite" | "acmart" | "none";
  hasReferencePdf: boolean;
  notes: string[];
}

function matchAll(source: string, pattern: RegExp): RegExpMatchArray[] {
  return [...source.matchAll(pattern)];
}

function parseTex(tex: string): {
  documentClass: string;
  classOptions: string[];
  packages: string[];
} {
  const classMatch = /\\documentclass(?:\[([^\]]*)\])?\{([^}]*)\}/.exec(tex);
  const packages = new Set<string>();
  for (const match of matchAll(
    tex,
    /\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g,
  )) {
    for (const name of (match[1] ?? "").split(",")) {
      const trimmed = name.trim();
      if (trimmed) packages.add(trimmed);
    }
  }
  return {
    documentClass: classMatch?.[2]?.trim() ?? "unknown",
    classOptions: (classMatch?.[1] ?? "")
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean),
    packages: [...packages].sort(),
  };
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full, base)));
    } else {
      out.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

async function main(): Promise<void> {
  if (!existsSync(examplesRoot)) {
    throw new Error(
      `Desktop examples not found at ${examplesRoot}. Pass the desktop repo path as the first argument.`,
    );
  }

  const dirs = (await readdir(examplesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  await mkdir(corpusRoot, { recursive: true });
  const entries: CorpusEntry[] = [];

  for (const id of dirs) {
    const source = join(examplesRoot, id);
    const target = join(corpusRoot, id);
    const allFiles = await listFiles(source);
    await mkdir(target, { recursive: true });

    for (const file of allFiles) {
      // The bundled main.pdf is desktop Tectonic's output. It is the
      // comparison reference, not a project input, so it is renamed to keep it
      // out of the fixture the compiler is handed.
      const destination = file === "main.pdf" ? "main.reference.pdf" : file;
      const directory = destination.split("/").slice(0, -1).join("/");
      if (directory) await mkdir(join(target, directory), { recursive: true });
      await cp(join(source, file), join(target, destination));
    }

    const tex = await readFile(join(source, "main.tex"), "utf8");
    const parsed = parseTex(tex);
    const projectFiles = allFiles.filter((file) => file !== "main.pdf");
    const hasBib = projectFiles.some((file) => file.endsWith(".bib"));
    const usesBibCommand =
      /\\(bibliography|addbibresource|printbibliography)\b/.test(tex);

    const notes: string[] = [];
    if (parsed.classOptions.includes("a0paper")) {
      notes.push("Very large page geometry; stresses renderer memory budget.");
    }
    if (parsed.packages.includes("tikz")) {
      notes.push("TikZ drawing; a common browser-engine failure point.");
    }
    if (parsed.packages.includes("fontawesome5")) {
      notes.push(
        "Needs a non-core font package shipped with the distribution.",
      );
    }
    if (HEAVY_CLASSES.has(parsed.documentClass)) {
      notes.push(
        `Third-party document class ${parsed.documentClass} must be resolvable.`,
      );
    }
    if (
      !parsed.packages.includes("fontspec") &&
      parsed.packages.includes("inputenc")
    ) {
      notes.push(
        "inputenc/fontenc pairing is pdfTeX-oriented; check XeTeX behaviour.",
      );
    }

    entries.push({
      id,
      mainFile: "main.tex",
      files: projectFiles,
      documentClass: parsed.documentClass,
      classOptions: parsed.classOptions,
      packages: parsed.packages,
      heavyPackages: parsed.packages.filter((name) => HEAVY_PACKAGES.has(name)),
      heavyDocumentClass: HEAVY_CLASSES.has(parsed.documentClass),
      needsBibliography: hasBib && usesBibCommand,
      bibliographyEngine: parsed.packages.includes("natbib")
        ? "natbib"
        : parsed.packages.includes("cite")
          ? "cite"
          : parsed.documentClass === "acmart"
            ? "acmart"
            : "none",
      hasReferencePdf: allFiles.includes("main.pdf"),
      notes,
    });
  }

  const manifest = {
    $schema: "./manifest.schema.json",
    generatedFrom: relative(resolve("."), desktopRoot).replace(/\\/g, "/"),
    generatedAt: new Date().toISOString().slice(0, 10),
    entryCount: entries.length,
    entries,
  };

  await writeFile(
    join(corpusRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const allPackages = new Set(entries.flatMap((entry) => entry.packages));
  console.log(`Corpus: ${entries.length} projects -> ${corpusRoot}`);
  console.log(`Distinct packages required: ${allPackages.size}`);
  console.log(
    `Distinct classes: ${new Set(entries.map((e) => e.documentClass)).size}`,
  );
  console.log(
    `Projects needing bibliography passes: ${entries.filter((e) => e.needsBibliography).length}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

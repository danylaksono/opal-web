import { useCallback, useEffect, useRef, useState } from "react";
import type { CompileDiagnostic } from "@/core/compiler/types";
import { projectPath } from "@/core/project/ids";
import { SiglumLatexCompiler } from "@/platform/browser/compiler/siglum-compiler";
import { MupdfRenderer } from "@/platform/browser/pdf/mupdf-renderer";
import type { DocumentComparison } from "@/spikes/fidelity/compare";
import { compareDocuments } from "@/spikes/fidelity/run";

/**
 * ADR-003 measurement surface.
 *
 * Select every file of a corpus project (main.tex plus any .bib or assets) and
 * it compiles through the `LatexCompiler` port, then opens the result through
 * the `PdfRenderer` port. Opening the PDF matters as much as producing one: a
 * compile that "succeeds" but emits something the renderer cannot parse is a
 * failure the exit code would not show.
 *
 * After a successful compile, feeding it the project's `main.reference.pdf`
 * compares the two beyond page count — words, ink and pixels — which is the
 * question page count cannot answer.
 */

interface SpikeResult {
  status: "idle" | "initialising" | "compiling" | "done" | "error";
  engine?: string;
  packageSet?: string;
  ok?: boolean;
  summary?: string;
  category?: string;
  durationMs?: number;
  pdfBytes?: number;
  pageCount?: number;
  hasSyncTex?: boolean;
  diagnostics?: readonly CompileDiagnostic[];
  logTail?: string;
  stage?: string;
}

interface FidelityState {
  status: "idle" | "comparing" | "done" | "error";
  comparison?: DocumentComparison;
  durationMs?: number;
  error?: string;
}

/**
 * The first place the worst-scoring page parts company with the reference.
 *
 * One line, because it is the difference between "the text differs" and "the
 * text differs because the date moved" — and only one of those is a defect.
 */
/** Page dimensions are decimals; a whole point is the useful resolution. */
function round(value: number): string {
  return value.toFixed(1);
}

function describeDivergence(comparison: DocumentComparison): string {
  const worst = [...comparison.pages].sort(
    (a, b) => a.words.similarity - b.words.similarity,
  )[0];
  const divergence = worst?.words.firstDivergence;
  if (!worst || !divergence) return "none";
  return `p${worst.pageIndex + 1} #${divergence.index}: ${
    divergence.reference ?? "(absent)"
  } -> ${divergence.candidate ?? "(absent)"}`;
}

export function CompilerSpike() {
  const [result, setResult] = useState<SpikeResult>({ status: "idle" });
  const [useCtan, setUseCtan] = useState(false);
  const [engine, setEngine] = useState<"xelatex" | "pdflatex" | "lualatex">(
    "xelatex",
  );
  const [fidelity, setFidelity] = useState<FidelityState>({ status: "idle" });
  const compilerRef = useRef<SiglumLatexCompiler | null>(null);
  const rendererRef = useRef<MupdfRenderer | null>(null);
  /**
   * The compiled PDF, kept so a reference can be compared against it later.
   * `openDocument` is documented as consuming the buffer it is given, so this
   * is a copy rather than the array handed to the renderer above.
   */
  const compiledPdfRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const renderer = new MupdfRenderer();
    rendererRef.current = renderer;
    return () => {
      void renderer.dispose();
      void compilerRef.current?.dispose();
      rendererRef.current = null;
      compilerRef.current = null;
    };
  }, []);

  const run = useCallback(
    async (fileList: FileList) => {
      setResult({ status: "initialising" });
      setFidelity({ status: "idle" });
      compiledPdfRef.current = null;

      // Rebuilt per run so the CTAN toggle takes effect, and so a wedged engine
      // cannot poison the next measurement.
      await compilerRef.current?.dispose();
      const compiler = new SiglumLatexCompiler({
        engine,
        verbose: true,
        ...(useCtan ? { ctanProxyUrl: "/ctan" } : {}),
        // Engine chatter goes to the console rather than React state: it is
        // high-volume, and this is a measurement harness where the browser
        // console is where you actually read it.
        onLog: (line) => console.log("[siglum]", line),
        onProgress: (stage, detail) =>
          setResult((previous) => ({
            ...previous,
            stage: detail ? `${stage}: ${detail}` : stage,
          })),
      });
      compilerRef.current = compiler;

      try {
        const files = await Promise.all(
          Array.from(fileList).map(async (file) => ({
            path: projectPath(file.name),
            content: new Uint8Array(await file.arrayBuffer()),
          })),
        );

        const mainFile =
          files.find((file) => file.path === "main.tex")?.path ??
          files.find((file) => file.path.endsWith(".tex"))?.path;
        if (!mainFile) throw new Error("No .tex file selected");

        setResult((previous) => ({ ...previous, status: "compiling" }));

        const compiled = await compiler.compile({
          revision: 1,
          mainFile,
          files,
        });

        let pageCount: number | undefined;
        if (compiled.ok && rendererRef.current) {
          compiledPdfRef.current = new Uint8Array(compiled.pdf);
          // Round-trip through the renderer: proves the bytes are a PDF a
          // viewer can actually open, not just a non-zero buffer.
          const doc = await rendererRef.current.openDocument(
            new Uint8Array(compiled.pdf),
          );
          pageCount = doc.pageCount;
          await doc.close();
        }

        setResult({
          status: "done",
          engine: `${compiled.engine.name} ${compiled.engine.version}`,
          packageSet: compiled.engine.packageSetVersion,
          ok: compiled.ok,
          durationMs: compiled.durationMs,
          diagnostics: compiled.diagnostics,
          logTail: compiled.log.split("\n").slice(-25).join("\n"),
          ...(compiled.ok
            ? {
                pdfBytes: compiled.pdf.byteLength,
                hasSyncTex: compiled.synctex !== undefined,
                ...(pageCount !== undefined ? { pageCount } : {}),
              }
            : { summary: compiled.summary, category: compiled.category }),
        });
      } catch (error) {
        setResult({
          status: "error",
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [useCtan, engine],
  );

  const compare = useCallback(async (file: File) => {
    const renderer = rendererRef.current;
    const compiled = compiledPdfRef.current;
    if (!renderer || !compiled) return;

    setFidelity({ status: "comparing" });
    const started = performance.now();
    try {
      const reference = new Uint8Array(await file.arrayBuffer());
      const comparison = await compareDocuments(
        renderer,
        reference,
        new Uint8Array(compiled),
      );
      setFidelity({
        status: "done",
        comparison,
        durationMs: performance.now() - started,
      });
    } catch (error) {
      setFidelity({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  return (
    <section>
      <h2>ADR-003: compiler spike</h2>
      <p className="lede">
        Select every file of one corpus project — <code>main.tex</code> plus any{" "}
        <code>.bib</code> and assets. Compiles with Siglum xelatex, then opens
        the PDF through the renderer port to confirm it is really readable.
      </p>

      <label style={{ display: "block", marginBottom: "0.75rem" }}>
        Engine{" "}
        <select
          data-testid="engine-select"
          value={engine}
          onChange={(event) => setEngine(event.target.value as typeof engine)}
        >
          <option value="xelatex">xelatex (matches desktop Tectonic)</option>
          <option value="pdflatex">pdflatex</option>
          <option value="lualatex">lualatex</option>
        </select>
      </label>

      <label style={{ display: "block", marginBottom: "0.75rem" }}>
        <input
          type="checkbox"
          data-testid="ctan-toggle"
          checked={useCtan}
          onChange={(event) => setUseCtan(event.target.checked)}
        />{" "}
        Enable CTAN fetching through a self-hosted proxy at <code>/ctan</code>.
        Off by default: ADR-001 makes on-demand package fetching opt-in, because
        it reveals which packages a document uses.
      </label>

      <input
        type="file"
        multiple
        data-testid="tex-input"
        onChange={(event) => {
          const files = event.target.files;
          if (files && files.length > 0) void run(files);
        }}
      />

      <div data-testid="compile-status" data-status={result.status}>
        {(result.status === "initialising" ||
          result.status === "compiling") && (
          <p>
            {result.status === "initialising"
              ? "Loading engine and bundles…"
              : "Compiling…"}{" "}
            {result.stage}
          </p>
        )}

        {result.status === "error" && (
          <div className="banner bad">
            <strong>Harness error:</strong> {result.summary}
          </div>
        )}

        {result.status === "done" && (
          <>
            <div className={result.ok ? "banner" : "banner bad"}>
              <strong data-testid="compile-verdict">
                {result.ok ? "Compiled" : `Failed (${result.category})`}
              </strong>
              {!result.ok && <> — {result.summary}</>}
            </div>

            <table>
              <tbody>
                <tr>
                  <td>Engine</td>
                  <td className="note" data-testid="compile-engine">
                    {result.engine}
                  </td>
                </tr>
                <tr>
                  <td>Package set</td>
                  <td className="note">
                    <code>{result.packageSet}</code>
                  </td>
                </tr>
                <tr>
                  <td>Duration</td>
                  <td className="note">{result.durationMs?.toFixed(0)} ms</td>
                </tr>
                {result.ok && (
                  <>
                    <tr>
                      <td>PDF</td>
                      <td className="note" data-testid="compile-pages">
                        {result.pdfBytes} bytes, {result.pageCount} pages
                      </td>
                    </tr>
                    <tr>
                      <td>SyncTeX</td>
                      <td className="note">
                        {result.hasSyncTex ? "emitted" : "not emitted"}
                      </td>
                    </tr>
                  </>
                )}
                <tr>
                  <td>Diagnostics</td>
                  <td className="note">
                    {result.diagnostics?.length ?? 0} parsed
                  </td>
                </tr>
              </tbody>
            </table>

            {result.diagnostics && result.diagnostics.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Where</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {result.diagnostics.slice(0, 12).map((diagnostic) => (
                    <tr key={`${diagnostic.message}-${diagnostic.line}`}>
                      <td className="note">{diagnostic.severity}</td>
                      <td className="note">
                        {diagnostic.file ?? "—"}
                        {diagnostic.line ? `:${diagnostic.line}` : ""}
                      </td>
                      <td className="note">{diagnostic.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <details>
              <summary>Last lines of the TeX log</summary>
              <pre
                style={{
                  overflowX: "auto",
                  fontSize: "0.75rem",
                  lineHeight: 1.5,
                }}
              >
                {result.logTail}
              </pre>
            </details>
          </>
        )}
      </div>

      {result.status === "done" && result.ok && (
        <>
          <h3>Fidelity against desktop</h3>
          <p className="lede">
            Select the project's <code>main.reference.pdf</code> — desktop
            Tectonic's output for the same source. Both go through the same
            renderer, so a difference here is a real difference. Words are
            compared as a sequence per page, never line by line: line breaking
            is the engine's own business. Bytes are never compared.
          </p>

          <input
            type="file"
            accept="application/pdf"
            data-testid="reference-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void compare(file);
            }}
          />

          <div data-testid="fidelity-status" data-status={fidelity.status}>
            {fidelity.status === "comparing" && <p>Comparing…</p>}

            {fidelity.status === "error" && (
              <div className="banner bad">
                <strong>Comparison failed:</strong> {fidelity.error}
              </div>
            )}

            {fidelity.status === "done" && fidelity.comparison && (
              <>
                <table>
                  <tbody>
                    <tr>
                      <td>Pages</td>
                      <td className="note" data-testid="fidelity-pages">
                        {fidelity.comparison.candidatePages} vs reference{" "}
                        {fidelity.comparison.referencePages}
                      </td>
                    </tr>
                    <tr>
                      <td>Pages matching word for word</td>
                      <td className="note" data-testid="fidelity-exact">
                        {fidelity.comparison.exactPages} /{" "}
                        {fidelity.comparison.pages.length}
                      </td>
                    </tr>
                    <tr>
                      <td>Mean word similarity</td>
                      <td className="note" data-testid="fidelity-mean">
                        {fidelity.comparison.meanWordSimilarity.toFixed(4)}
                      </td>
                    </tr>
                    <tr>
                      <td>Worst word similarity</td>
                      <td className="note" data-testid="fidelity-words">
                        {fidelity.comparison.worstWordSimilarity.toFixed(4)}
                      </td>
                    </tr>
                    <tr>
                      <td>Worst ink delta</td>
                      <td className="note" data-testid="fidelity-ink">
                        {fidelity.comparison.worstInkDelta.toFixed(4)}
                      </td>
                    </tr>
                    <tr>
                      <td>Worst differing pixels</td>
                      <td className="note" data-testid="fidelity-pixels">
                        {fidelity.comparison.worstDifferingRatio.toFixed(4)}
                      </td>
                    </tr>
                    <tr>
                      <td>First divergence</td>
                      <td className="note" data-testid="fidelity-divergence">
                        {describeDivergence(fidelity.comparison)}
                      </td>
                    </tr>
                    <tr>
                      <td>Duration</td>
                      <td className="note">
                        {fidelity.durationMs?.toFixed(0)} ms
                      </td>
                    </tr>
                  </tbody>
                </table>

                <table>
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Words</th>
                      <th>Ink (ref / ours)</th>
                      <th>Pixels</th>
                      <th>First divergence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fidelity.comparison.pages.map((page) => (
                      <tr key={page.pageIndex}>
                        <td className="note">
                          {page.pageIndex + 1}
                          {page.sizeMatches
                            ? ""
                            : ` (${page.size.reference.map(round).join("×")}pt` +
                              ` vs ${page.size.candidate.map(round).join("×")}pt)`}
                        </td>
                        <td className="note">
                          {page.words.similarity.toFixed(4)}
                        </td>
                        <td className="note">
                          {page.raster.referenceInk.toFixed(4)} /{" "}
                          {page.raster.candidateInk.toFixed(4)}
                        </td>
                        <td className="note">
                          {page.raster.comparable
                            ? page.raster.differingRatio.toFixed(4)
                            : "—"}
                        </td>
                        <td className="note">
                          {page.words.firstDivergence
                            ? `#${page.words.firstDivergence.index}: ${
                                page.words.firstDivergence.reference ?? "∅"
                              } → ${page.words.firstDivergence.candidate ?? "∅"}`
                            : "none"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

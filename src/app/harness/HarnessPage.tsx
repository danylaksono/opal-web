import { useMemo } from "react";
import {
  buildCapabilityReport,
  type Capability,
} from "@/platform/browser/capabilities/detect";
import { CompilerSpike } from "@/spikes/compiler/CompilerSpike";
import { PerformanceSpike } from "@/spikes/performance/PerformanceSpike";
import { RendererSpike } from "@/spikes/renderer/RendererSpike";
import corpus from "../../../tests/fixtures/compiler-corpus/manifest.json";

/**
 * The Phase 0 measurement harness, at `?harness=1`.
 *
 * This was the application's only page while the application was an
 * investigation, and it stayed the front page for two phases after that: a
 * person opening Opal Web met a capability table, a corpus table and three
 * instrument panels, with their projects somewhere below.
 *
 * It is not deleted, because the numbers in ADR-003 and ADR-011 are reproduced
 * by driving these panels — `pnpm spike:corpus-run`, `spike:perf`,
 * `spike:firstload` all open this page. It is a debug route: off the product's
 * path, on its own URL, dressed in the stylesheet the product no longer uses.
 */

interface CorpusEntry {
  id: string;
  documentClass: string;
  heavyDocumentClass: boolean;
  packages: string[];
  heavyPackages: string[];
  bibliographyEngine: string;
  needsBibliography: boolean;
  notes: string[];
}

function statusClass(capability: Capability): string {
  if (capability.status === "available") return "available";
  return capability.optional ? "optional-missing" : "unavailable";
}

function statusLabel(capability: Capability): string {
  if (capability.status === "available") return "Available";
  return capability.optional ? "Missing (optional)" : "Missing (required)";
}

export function HarnessPage() {
  const report = useMemo(() => buildCapabilityReport(), []);
  const entries = corpus.entries as CorpusEntry[];

  // The corpus is a static import, so nothing here needs memoising.
  const packageCount = new Set(entries.flatMap((entry) => entry.packages)).size;
  const classCount = new Set(entries.map((entry) => entry.documentClass)).size;
  const bibliographyCount = entries.filter(
    (entry) => entry.needsBibliography,
  ).length;

  return (
    <div className="harness-page" data-testid="harness">
      <main>
        <h1>Opal Web — Phase 0 harness</h1>
        <p className="lede">
          Measurement instrumentation, not the product: this page is how the
          ADR-003 and ADR-011 numbers are reproduced. The application is at{" "}
          <a href="/">/</a>.
        </p>

        <div className={report.supported ? "banner" : "banner bad"}>
          {report.supported ? (
            <>
              This browser has every capability Opal Web needs. Optional gaps
              below change which features degrade, not whether the app can run.
            </>
          ) : (
            <>
              This browser is missing required capabilities:{" "}
              <strong>{report.missingRequired.join(", ")}</strong>. Opal Web
              cannot run here.
            </>
          )}
        </div>

        <section>
          <h2>Browser capabilities</h2>
          <table>
            <thead>
              <tr>
                <th>Capability</th>
                <th>Status</th>
                <th>Why it matters</th>
              </tr>
            </thead>
            <tbody>
              {report.capabilities.map((capability) => (
                <tr key={capability.id}>
                  <td>{capability.label}</td>
                  <td className={`status ${statusClass(capability)}`}>
                    {statusLabel(capability)}
                  </td>
                  <td className="note">{capability.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2>Compiler acceptance corpus</h2>
          <p className="lede">
            {entries.length} projects pinned from the desktop examples,{" "}
            {classCount} document classes, {packageCount} distinct packages,{" "}
            {bibliographyCount} needing bibliography passes. An engine is not a
            candidate until every row here has a recorded outcome — a documented
            exception counts, a silent failure does not.
          </p>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Class</th>
                <th>Bibliography</th>
                <th>Known-hard packages</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <code>{entry.id}</code>
                  </td>
                  <td>
                    {entry.documentClass}
                    {entry.heavyDocumentClass ? " (non-baseline)" : ""}
                  </td>
                  <td className="note">
                    {entry.needsBibliography ? entry.bibliographyEngine : "—"}
                  </td>
                  <td className="note">
                    {entry.heavyPackages.join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <CompilerSpike />

        <PerformanceSpike />

        <RendererSpike />

        <section>
          <h2>Build configuration</h2>
          <table>
            <tbody>
              <tr>
                <td>Cross-origin isolation expected</td>
                <td className="note">
                  {__OPAL_CROSS_ORIGIN_ISOLATED__ ? "yes" : "no"} — set{" "}
                  <code>OPAL_COI=1</code> and uncomment the header block in{" "}
                  <code>netlify.toml</code> together, or the build and the host
                  will disagree.
                </td>
              </tr>
              <tr>
                <td>Corpus generated from</td>
                <td className="note">
                  <code>{corpus.generatedFrom}</code> on {corpus.generatedAt}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

# ADR-011: how TeX support files reach the browser

- **Status:** Proposed — measured against the live Tectonic bundle, not yet built
- **Date:** 2026-09-03
- **Deciders:** danylaksono

## Context

ADR-003 measured a cold first compile: **41 MB for the simplest document, 135 MB
for beamer**, in production terms. The engine is a constant 29.4 MB (7 MB
brotli). Everything above that floor is TeX support files, and it is where all
the variance lives.

The reason is that Siglum's bundles are fetched whole. There is a lazy
filesystem and a working HTTP range-request path, but `worker.js` takes it only
for bundles already in memory:

```js
if (deferredBundles.has(bundleName) && !bundleDataMap.has(bundleName)) {
    // load the whole thing
}
// Range requests only for already-loaded bundles, or if the full fetch failed
```

No size threshold. One font out of `cm-super` costs 57.2 MB. It is
worker-internal, so the adapter cannot reach it.

Two other decisions already point the same way. ADR-003's version-skew finding
concluded the package tree has to be ours, because Siglum's bundles span five
TeX Live vintages. And its font findings — no URW metrics, OpenType silently
discarded — are both "the tree does not contain what we need".

So: what should replace bundle-shaped delivery?

## The model already exists, in the engine desktop uses

Tectonic solves this problem and has been solving it in our own desktop app the
whole time. Its bundles are **indexed archives on a plain static URL**: a client
reads the index, then issues an HTTP range request for each file it actually
needs. There is no server-side compute — an index and byte offsets over a static
file.

### The format, verified against the live bundle

The `.ttb` v1 format is
[documented](https://github.com/tectonic-typesetting/tectonic-texlive-bundles/blob/master/doc/formatspec-v1.md):
a 66-byte header (magic `tectonicbundle`, version, index offset, index length,
hash), then concatenated gzip blobs, one of which is the index. The index is
text, and its `[FILELIST]` lines are
`<start_byte> <gzip_len> <real_len> <hash> <path>`.

The bundle Tectonic actually ships today is the older indexed-tar form, and it
behaves the same way. Measured directly against it:

| | |
| --- | --- |
| Bundle | `tlextras-2022.0r0.tar` |
| Size | 2.88 GB |
| Index sidecar | `.tar.index.gz`, **1.28 MB** |
| Index entries | 134,980 files |
| Index format | `<filename> <offset> <length>`, flat basenames |
| HTTP range request | **206, works** |

A client's whole protocol is: fetch the index once, then one range request per
file. Everything our corpus needs is in it — `ptmr8t.tfm`, `acmart.cls`,
`libertine.sty`, eight `hyperref` variants, the `cm-super` faces.

### What our own documents would cost

Cross-referencing the files each corpus project's engine log records TeX opening
against that index:

| project | files opened | those files | bundles fetched today |
| --- | --- | --- | --- |
| `blank` | 6 | **0.07 MB** | 25.6 MB |
| `paper-standard` | 53 | **1.03 MB** | 26.9 MB |
| `thesis-standard` | 77 | **1.56 MB** | 40.0 MB |
| `paper-acm` | 93 | **2.01 MB** | 95.7 MB |
| `presentation-beamer` | 145 | **2.10 MB** | 118.9 MB |

`presentation-beamer` reads 2.1 MB of TeX files and downloads 118.9 MB to get
them.

**Two caveats, both honest.** TeX prints `(path` only for macro files — the
opened set is `.sty`, `.tex`, `.def`, `.cfg`, `.clo`, `.fd`, `.cls`, `.ltx`, and
contains no font binaries at all. Fonts are additional and unmeasured, though
bounded by what these documents use: Latin Modern throughout, plus Times for one
and FontAwesome for another — a few megabytes, not tens. And the precompiled
format is separate again, 4.5 MB gzipped today; Tectonic builds formats locally
and caches them instead of shipping one.

Adding those back, a first load under this model is roughly:

| | |
| --- | --- |
| Engine, brotli | 7 MB |
| MuPDF, brotli | 3.6 MB |
| Bundle index | 1.3 MB |
| Format | ~4.5 MB, or generated locally |
| Macro files | 0.07–2.1 MB |
| Fonts, estimated | 1–3 MB |
| **Total** | **~17–21 MB** |

Against 41–135 MB today. The ceiling matters more than the floor: the variance
collapses, because nothing is fetched that the document does not open.

## Decision

**Adopt indexed-archive delivery with per-file range requests, self-hosted.**
Replace bundle-shaped delivery entirely: one static archive, one index, one
request per file actually used.

Three properties make this the right shape rather than merely a smaller one:

- **It needs no server.** An index and byte ranges over a static file. ADR-001
  wanted runtime assets served from an origin we control, and a static archive
  is exactly that — the 2.88 GB public bundle is a reference implementation, not
  something we would fetch from at compile time.
- **It has one vintage.** The archive is built from a single TeX Live tree,
  which is what ADR-003's version-skew decision asked for. `packageSetVersion`
  becomes true rather than aspirational.
- **It is the tree desktop uses.** Comparing our output against desktop
  Tectonic's stops comparing two package sets as well as two engines.

## What this does not decide

**It is not a decision to use Tectonic's engine.** No WebAssembly build of
Tectonic exists; the project has
[discussed it](https://github.com/tectonic-typesetting/tectonic/issues/166)
without doing it, and its C dependencies are described there as surmountable
rather than solved. This ADR takes Tectonic's *delivery model*, which is a file
format and an index, and leaves the engine question to ADR-003.

That separation is the point. The two were entangled only because one project
happens to ship both.

## Consequences

- Siglum's bundle loading is bypassed rather than fixed. Files would be injected
  through the same path the adapter already uses for font packages, which is
  known to work.
- Hosting a multi-gigabyte archive needs object storage with range support, not
  a CDN edge that wants small files. A tree built for our corpus rather than all
  of TeX Live would be far smaller, and that choice is now ours to make.
- Latency replaces bandwidth. A document opening 145 files makes 145 range
  requests, and HTTP/2 multiplexing rather than raw throughput becomes what
  matters. Unmeasured, and the first thing to measure.
- The index is a fixed 1.28 MB before any document compiles, which is the one
  place this model is *worse* than bundles for a trivial document.

## Still to measure

- [ ] Round-trip cost of 145 range requests against a real host, over HTTP/2.
- [ ] Whether the engine can be fed files one at a time without the
      all-or-nothing bundle path, through the adapter's existing injection
      point.
- [ ] Font bytes per document, which the `(path` convention does not reveal.
- [ ] Whether a tree scoped to plausible documents is small enough to serve from
      the same static host as the app.

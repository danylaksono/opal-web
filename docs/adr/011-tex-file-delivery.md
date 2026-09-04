# ADR-011: how TeX support files reach the browser

- **Status:** Proposed — format verified against the live Tectonic bundle, the
  delivery measured on a local archive, and file-level injection working behind
  `texArchiveUrl`; the engine's own bundle path is not yet replaced
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

### What the round trips cost, measured

The open risk was never the bytes; it was that a document opening 145 files
makes 145 requests. That is now measured rather than assumed, against a real
archive: `pnpm spike:tex-archive` writes every file out of the engine's own
bundles into one flat 257.8 MB archive of 8,269 files with a 249 KB index
(87 KB gzipped), and `pnpm serve:tex-archive` serves byte ranges out of it over
HTTP/2 or HTTP/1.1. The file list per document is what TeX recorded opening in
the corpus logs, so the request pattern is a real one, and latency is added by
the rig per response rather than by Chrome, whose throttling queues requests
before delaying them and so hides the parallelism under test.

`presentation-beamer`, 142 files, 2.14 MB, wall time in ms:

| | 1 par | 6 par | 24 par | 64 par |
| --- | --- | --- | --- | --- |
| **HTTP/2, default cache**, 150 ms | 23054 | 22198 | 22143 | 22261 |
| **HTTP/1.1, no-store**, 150 ms | 23031 | 3992 | 4005 | 4072 |
| **HTTP/2, no-store**, 150 ms | 23074 | 4093 | 1043 | **575** |
| **HTTP/2, no-store**, 50 ms | 8829 | 1514 | 464 | **275** |
| **HTTP/2, no-store**, 0 ms | 2155 | 108 | 80 | **93** |

Two things have to be true, and each is worth a sentence because getting either
wrong costs an order of magnitude.

**The client must decline the HTTP cache.** Every file is a different range of
the *same* URL, and Chrome takes a lock on the cache entry for a URL while a
request against it is in flight. Concurrent range requests therefore queue
behind each other: the first row above is a 64-way parallel client performing
exactly as if it were serial, 22 seconds either way. `cache: "no-store"` skips
the cache entry and the lock with it. This is not a tuning preference — it is
the difference between 22.1 s and 0.58 s for the same 142 files, and the wrong
one is the obvious way to write the code, so it is enforced and explained in
`fetchTexFile` rather than left to whoever writes the caller.

**The protocol must be HTTP/2.** With the cache declined, HTTP/1.1 flattens at
six requests in flight — 3992 ms at 6 parallel, 4072 ms at 64 — because that is
the per-origin connection limit. HTTP/2 multiplexes on one connection and keeps
scaling: 1043 ms at 24, 575 ms at 64. At six parallel the two protocols are
indistinguishable, which is what confirms the cap is the whole difference.

Done right, the worst document in the corpus takes **575 ms on a 150 ms link**
to fetch every TeX file it opens, against 22.1 s for the naive version of the
same model. Round trips are not what makes this model expensive.

**Three caveats.** The archive is built from Siglum's bundles, so 38 files the
corpus opens are not in it — `booktabs.sty`, `enumitem.sty`, `titlesec.sty`,
`acmart.cls`, `IEEEtran.cls` and the rest of what the CTAN proxy supplies,
which is ADR-003's version-skew finding showing up again. Those files are not
fetched here, so the byte totals are a small undercount. Three more names in the
logs are truncated by TeX's 79-column line wrap rather than missing. And the rig
is loopback with an artificial delay: it measures round trips honestly and says
nothing about throughput on a real link.

### Feeding the engine one file at a time: it works, and it is not enough

The engine takes files individually. Siglum's compile request carries a
`ctanFiles` map of path to bytes, which the worker writes into its filesystem
before running TeX, and `ctanFetcher.fileCache` is that map. The adapter now
takes files from the archive and puts them there, behind `texArchiveUrl`.

TeX read them. With CTAN off, `presentation-beamer` resolved `etoolbox.sty`,
the pgf chain, `xcolor.sty` and `hyperref.sty` as byte ranges, and the log shows
XeTeX opening each from the path the index recorded. Run twice, once each way,
the substitution is exact:

| | bundles fetched | of which by range |
| --- | --- | --- |
| Bundle resolution | 24 bundles | — |
| Archive resolution | 19 bundles | 2.8 MB |

The five it no longer fetches are `pgf-tikz`, `utils`, `tex-generic`,
`hyperref` and `xcolor`: **33.7 MB of bundles replaced by 2.8 MB of range
requests**, for the same document at the same point in its compile.

**Neither run compiles.** Both stop in the same place for the same reason:
`translator.sty`, which beamer loads unconditionally, is in no Siglum bundle and
therefore not in an archive built from them, so without CTAN there is nowhere to
get it. The comparison above is bytes spent before hitting an identical wall,
which is a fair comparison of delivery and not a claim that the document
compiled.

Four things were learned doing it, and three of them are limits.

**TeX names one missing file per run.** Resolution driven by error messages
therefore costs a full TeX pass per file, and beamer opens 142. Fetching the
whole TeX Live directory a missing file sits in — which the index now supports,
because it records paths — is what makes that tractable, but it does not make it
cheap: twelve passes, generous for bundles, ran out mid-chain on beamer and the
bound had to go to sixty for the archive path. Pulling siblings also transfers
more than the minimum, 2.8 MB against the 2.1 MB the document strictly opens.
That is the trade: fewer TeX passes for slightly more bytes, and it is only
worth taking because the bytes are small either way.

An engine that asked the archive for each file as it opened it would need none
of this. Tectonic does exactly that, which is the part of its design this ADR
cannot adopt through an adapter.

**Fonts never reach the adapter at all, which is why they cannot be counted
this way.** The 19 bundles both runs fetch are the set Siglum loads during its
own init, and ten of them are fonts: `cm-super` at 56.7 MB, `fonts-lm-type1` at
8.6 MB, `fonts-cm`, `fonts-lm-otf`, `fonts-lm-afm` and the rest — **77.1 MB of
font bundles, fetched before TeX runs and regardless of what the document
uses**. That is the answer to why the logs record no font files: TeX never
reports one missing, because they are all already there. A per-document font
figure cannot be obtained by watching what the engine asks for; it needs the
engine's font loading replaced, at which point the number is a property of the
new design rather than a measurement of this one.

**The adapter's hook is a fallback, so with CTAN on the archive saves nothing.**
Across the corpus it changed no project's byte total except `paper-acm`, and
there it *added* 2.1 MB (135.6 → 137.7 MB) while removing no bundle. The reason
is structural: Siglum resolves what it can internally and loads its baseline
eagerly, and the adapter only ever sees what that left unresolved. This is what
"Siglum's bundle loading is bypassed rather than fixed" means in practice, and
it is now a measurement rather than a plan: **the saving needs the engine's own
bundle path replaced, not supplemented.**

**Resolution order is load-bearing.** A first version let any archive answer
suppress the bundle and CTAN paths for that pass, which turned `paper-acm` from
compiling to failing: the archive answered for some of its files, and
`acmart.cls`, which only CTAN has, was never fetched. The archive now
short-circuits only when it answered for every file TeX named. Corpus results
are unchanged from the bundle baseline at 11 of 13.

### Building it from one pinned tree

The archive above was built from Siglum's bundles, which makes it useful for
measuring delivery and useless as a package set: ADR-003 found those bundles
span five TeX Live vintages. `pnpm spike:pinned-archive` builds from a single
vintage instead — Tectonic's published bundle, the tree desktop compiles
against — at `https://data1.fullyjustified.net/tlextras-2022.0r0.tar`, a URL
this ADR previously described without recording.

**It is a flat tar.** The index offsets point at file data, and the 512-byte tar
header before each one carries a bare basename. There are no directories in the
archive at all, so TeX Live paths cannot be recovered from it and are
synthesised by file type instead. That is not a workaround so much as a match
for how lookup works: kpathsea searches by type across a search path, and
Siglum's own CTAN fetcher places unrecognised files the same way.

Sizes, computed from the index without downloading anything:

| scope | files | bytes |
| --- | ---: | ---: |
| `corpus` — what the corpus opens or reports missing | 235 | **4.8 MB** |
| `macros` — every runtime macro in TeX Live, no fonts | 19,222 | 249 MB |
| `latin` — those plus Latin-script metrics and outlines | 29,716 | 399 MB |
| `full` | 134,980 | 2.6 GB |

**With the 4.8 MB corpus tier and CTAN switched off entirely, 9 of 13 compile.**
That includes `letter-formal`, which fails on `main` *with* CTAN — the
version-skew hypothesis confirmed by fixing it. Against the bundle baseline's 11
of 13 this is not yet a replacement, but it is a 4.8 MB archive on our own
origin standing in for a package proxy.

Two limits showed up, and the second decides the tier.

**Resolution needs to know every way TeX names a missing file.** The kernel
quotes with a backtick, a package raising the error itself through
`\IfFileExists` uses apostrophes, and `\input` says "I can't find file" instead.
LaTeX also appends the default extension while searching, so `lipsum.ltd` is how
a document asks for `lipsum.ltd.tex`. Each of those cost a corpus project until
it was handled.

**Some files cannot be discovered from an error at all.** `listings` loads its
own aspects and catches the failure itself, reporting "Couldn't load requested
aspect" and naming no file. Nothing can resolve that on demand, which is the
argument for the `macros` tier: the discovery chain ends only when the tree is
complete rather than fetched-as-asked.

**The host rate-limits.** Sixteen concurrent range requests earned HTTP 429 on
every request and then a block lasting minutes. A large tier has to be built by
reading the archive once and keeping what is in scope, which is what
`--via whole` does; range requests are for tiers of a few hundred files.

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
  matters. Measured above: 575 ms on a 150 ms link, and it stays that way only
  while both conditions hold.
- **Two of those conditions are now requirements, not preferences.** The host
  must serve HTTP/2 — an HTTP/1.1 host costs 7× on the same files — and the
  client must fetch with `cache: "no-store"`, or Chrome's per-URL cache lock
  serialises every request and costs 38×. Caching belongs a layer up, keyed by
  file rather than by byte range.
- The index is a fixed 1.28 MB before any document compiles, which is the one
  place this model is *worse* than bundles for a trivial document.

## Still to measure

- [x] Round-trip cost of 145 range requests over HTTP/2. **575 ms at 150 ms
      RTT, 64-way parallel, with the HTTP cache declined.** See above.
- [x] Whether the engine can be fed files one at a time. **Yes, and it is not
      enough.** See below.
- [~] Font bytes per document. Not obtainable by observation: Siglum fetches
      **77.1 MB of font bundles at init**, before TeX runs and independently of
      the document, so no font is ever reported missing. Answering this needs
      the engine's font loading replaced, not measured.
- [x] Whether a tree scoped to plausible documents is small enough to serve from
      the same static host as the app. **Only the narrowest tier is.** Measured
      from the pinned tree's index: corpus 4.8 MB, all runtime macros 249 MB,
      macros plus Latin-script fonts 399 MB, the whole tree 2.6 GB. A tier that
      ends discovery is hundreds of megabytes, so it needs object storage, as
      this ADR's consequences already assumed.

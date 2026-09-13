# ADR-011: how TeX support files reach the browser

- **Status:** Proposed — and now measured end to end on TeX Live 2026: a
  self-hosted endpoint over a 33.84 MB boot set compiles 11/13, and a first
  compile transfers **21.8–23.4 MB** against the 41–135 MB this ADR opened with
- **Date:** 2026-09-03, revised 2026-09-12
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

The four that still fail are worth separating, because only one of them is about
package delivery at all: `cv-modern` and `paper-ieee` now reach fonts and stop
there, on the OpenType and metric limitations ADR-003 already records;
`report-technical` stops inside `listings`, described below; `paper-acm` needs a
pass its retry budget does not reach.

Two limits showed up, and the second decides the tier.

**Resolution needs to know every way TeX names a missing file.** The kernel
quotes with a backtick, a package raising the error itself through
`\IfFileExists` uses apostrophes, and `\input` says "I can't find file" instead.
LaTeX also appends the default extension while searching, so `lipsum.ltd` is how
a document asks for `lipsum.ltd.tex`. Each of those cost a corpus project until
it was handled.

**Some files cannot be discovered from an error at all, and a complete tree
does not fix it.** `listings` loads its own aspects, catches the failure itself,
and reports "Couldn't load requested aspect" naming no file. The obvious remedy
is a tree with nothing missing, so the `macros` tier was built and measured: all
19,222 runtime macros in the vintage, 249 MB, read from the source in a single
pass. **It changed nothing.** The corpus compiles the same 9 of 13 as the 4.8 MB
tier, project for project, and `report-technical` still stops at the same
sentence.

The reason is that completeness of the *archive* is not completeness of the
*filesystem*. Resolution here is on demand: a file arrives because TeX said it
was missing. A failure that names no file fetches nothing, however much the
archive holds. Only an engine that asks the archive as it opens each file — what
Tectonic does, and what an adapter cannot reach — turns a complete tree into a
document that compiles.

So the tier is not the fix it looked like, and the 4.8 MB tier is the one worth
having until the engine reads from the archive itself.

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

### Revision: the tree to index is no longer Tectonic's

Two things found while measuring `texlyre-busytex` for ADR-003 change which
tree this decision should be applied to, without changing the decision.

**Tectonic's bundle repository is archived.** `tectonic-texlive-bundles` was
made read-only on 2 October 2024 with no successor named, and the only release
published there is `tlextras-2021.3r1`. The `tlextras-2022.0r0` tree this ADR
pins is served from `data1.fullyjustified.net`, a single host outside our
control, now unmaintained — and unreachable from at least one environment we
build in. "It is the tree desktop uses" is still true and still valuable for
comparison; "it is a tree we can keep getting" no longer is. A frozen 2022
vintage is also a widening gap against the documents users will bring.

**A maintained single-vintage tree ships with an engine we already measure.**
`texlyre-busytex` 1.4.0 carries TeX Live 2026 as three cumulative data tiers
and a `texmfrepo.txt` index of 8,418 revision-pinned packages. ADR-003 measures
that package set compiling **11 of 13 corpus projects with no network at all**.
Everything this ADR says about indexed delivery applies to it unchanged — it is
a tree, it has one vintage, and it is served from our origin.

What is new is the receiving end. This ADR had to work around TeX naming one
missing file per run, which cost a full pass per file and made `paper-acm` 57 s.
That engine exposes the hook directly:

```js
Module.kpse_remote_register(name, format, contents);  // one file, by format
Module.kpse_remote_register_misses(keys);             // misses as a SET
```

Per-file registration at the kpathsea level, and misses reported as a set
rather than one at a time. The finding above — that file-level injection "works,
and is not enough", because it could only supplement Siglum's own resolution and
never replace it — is a property of *that* engine, not of this delivery model.
Here `remoteEndpoint` is a first-class compile option with no bundle path behind
it to fight.

Truncating the tiers puts a number on what this ADR is for. At `basic` +
`recommended`, 294 MB, the corpus compiles 4/13. Adding `extra`, 341.6 MB more,
takes it to 11/13 — and every one of those seven documents is unblocked by
`enumitem`, `titlesec` or `tcolorbox`. **341.6 MB is fetched for three `.sty`
files.** That is the same failure this ADR opens with — `presentation-beamer`
downloading 118.9 MB to read 2.1 MB — an order of magnitude worse, and on a
tree where the files are demonstrably sufficient once they arrive.

None of this is measured yet, and it should not be adopted on the strength of an
API surface: what is measured is that the tiers compile 11/13 offline and cost
636 MB to load. Indexing that tree, and measuring a first load against the
41–135 MB this ADR set out to fix, is the next step and is listed below.

### Measured: the endpoint, on the tree's own index

Built and run, rather than argued from an API surface. Three findings made it
much less work than this ADR assumed.

**The archive already exists inside the engine's assets.** The tiers are
Emscripten file-packager output: the `.js` records every file's byte range, and
`extra` is a strict superset of `recommended`, which is a strict superset of
`basic` (7,185 ⊂ 13,236 ⊂ 23,883 files, no exceptions). So one index over
`texlive-extra.data` addresses everything any tier holds. **The blob is not
flat but LZ4-chunked at 2 KiB**, which is better than flat for this: a file is
read by decompressing the two or three chunks it spans. Nothing is repacked and
there is no second copy of the tree.

**The index is 2.13 MB raw, 0.38 MB gzipped** over 23,446 names — against the
fixed 1.28 MB this ADR records for Tectonic's, which it calls the one place
file-shaped delivery is worse than bundles for a trivial document. Gzipped, it
is no longer that.

**The protocol was read out of `busytex.js`, not guessed:**

    GET <endpoint>/<kpathsea format>/<encodeURIComponent(name)>

Synchronous XHR, 30 s timeout. **200 with a non-empty body registers the file;
404 is recorded as a miss and never asked again in that compile.** Everything
else means "not this time" and is re-asked. That asymmetry is load-bearing: an
endpoint answering 500 for an unknown name turns one missing file into a retry
per pass, and one wrong 404 ends the document.

### Result

`pnpm spike:corpus-run xelatex --texlyre --tiers 1 --endpoint` — the 92.8 MB
`basic` tier preloaded, everything else resolved one file at a time.

| | tiers only | `basic` + endpoint |
|---|---:|---:|
| Preloaded | 636 MB | 92.8 MB |
| Fetched, whole corpus | — | **9.06 MB** (379 files) |
| Compiled | 11 / 13 | **11 / 13** |
| Pages word for word | 32 / 60 | 32 / 60 |
| Cold per project | 28–46 s | **5.6–14.2 s** |

**The same eleven documents, and the same fidelity to the digit** — every
per-document word, ink and pixel figure is identical. This is not an
approximation of the tiers; it is the same tree, addressed instead of copied.

On this ADR's own reference document: `presentation-beamer` fetches **105 files,
1.35 MB**, against the **118.9 MB** of bundles Siglum fetched to read 2.1 MB of
the same kind of files.

357 requests returned 404 across the corpus, and all of them are correct — the
document's own `main.aux`, `main.toc`, `main.lot` before a pass has written
them, and optional `geometry.cfg` / `hyperref.cfg` probes that exist in no TeX
Live. A miss costs one request per compile, not one per pass, because the
engine remembers it.

### The defect this measurement found

The first run compiled **9/13**, not 11: `presentation-beamer` failed on
`beamerbasenavigationsymbols` and `thesis-standard` on `lipsum.ltd`, both
reported under unrelated categories (`missing-file` and `syntax`). Both files
are in the index. Neither was asked for by the name it is stored under —
they are `beamerbasenavigationsymbols.tex` and `lipsum.ltd.tex`.

kpathsea resolves a TeX input by trying the name and then the name with `.tex`,
and the engine asks the endpoint exactly as it would ask a local tree. The
endpoint stopped one step early, and because a 404 is remembered, one short
answer ended the document. 2,295 of 23,446 indexed names end in `.tex`, so this
was never a narrow case; it only looked like one.

Worth recording as a property of this delivery model rather than a bug that has
been fixed: **the endpoint is a kpathsea implementation, not a file server.**
Anything the local resolver does implicitly has to be done here explicitly, and
a gap shows up as a document failing somewhere unrelated rather than as a 404
anybody notices.

### Cutting the floor: what actually has to be mounted

The `basic` tier was never the answer to "what must be preloaded", only the
smallest thing that happened to be lying around. Preloading *nothing* says what
the real constraint is: the engine dies before kpathsea exists, on

```
lstat(/bin) failed: /bin: No such file or directory
kpathsea: Can't get directory of program name: /bin/busytex
```

having asked the endpoint for nothing whatsoever. So the floor is a set of
files, not a tier, and it has four members:

1. **Read before the resolver exists.** `/bin/busytex` — one byte, and kpathsea
   derives its own location from it — plus `texmf.cnf` and fontconfig's `/etc`
   files.
2. **Named by absolute path rather than looked up.** The format file, passed to
   the binary as `--fmt /texlive/.../xelatex.fmt`.
3. **Opened from inside the binary.** `icudt78l.dat`, 22 MB, which XeTeX reads
   directly rather than through kpathsea.
4. **Loaded unconditionally by every compile.** Not a hard requirement but a
   delivery one: `pdftex.map` is 5.54 MB and dvipdfmx loads it whatever the
   document says, so serving it per file is repetition, not delivery. Measured
   before it was mounted, the corpus fetched it twelve times — **66.5 MB of a
   96.2 MB total**.

That set is **110 files and 33.84 MB**, against `basic`'s 7,185 files and
156.87 MB uncompressed. It is built by `pnpm spike:texlive-min`, which emits a
real Emscripten data package without Emscripten: the `.data` is written as LZ4
chunks that are all *stored* rather than compressed, which `successes[i] = 0`
allows, and the loader `.js` is the shipped one with three substitutions.

### Result

| | tiers only | `basic` + endpoint | boot set + endpoint |
|---|---:|---:|---:|
| Preloaded | 636 MB | 92.8 MB | **33.84 MB** |
| Fetched, whole corpus | — | 9.06 MB | 29.70 MB |
| Compiled | 11 / 13 | 11 / 13 | **11 / 13** |
| Pages word for word | 32 / 60 | 32 / 60 | 32 / 60 |
| Cold per project | 28–46 s | 5.6–14.2 s | **3.0–8.6 s** |

Three configurations, the same eleven documents, the same fidelity to the
digit. What changes is where the bytes come from and how many of them there
are.

The total fetched *rises* from 9.06 MB to 29.70 MB, and that is not a
regression: with only the boot set mounted, fonts and maps cross the wire too,
where the `basic` tier had them on disk already. The number that matters is the
first compile, and it falls:

| | engine | preloaded | document | total |
|---|---:|---:|---:|---:|
| `basic` + endpoint | 32.5 MB | 92.8 MB | 1.35 MB | 126.7 MB |
| boot set + endpoint | 32.5 MB | 33.84 MB | 3.07 MB | **69.4 MB** |

`presentation-beamer` is the document in both rows, and it is this ADR's own
reference case: Siglum fetched **118.9 MB** of bundles for it. It now costs
3.07 MB over 171 requests on top of a boot set every document shares.

### ICU is 22 MB and there is no way around it

Two thirds of the boot set is one file, so it was worth asking whether XeTeX
really needs it. It does: without `icudt78l.dat` the boot set is **11.89 MB**
and the corpus compiles **0 of 13**, every document dying on

```
internal error; cannot read font names
```

before it reads a line of the document. It cannot be served either — XeTeX
opens it from inside the binary, so no amount of resolver improvement reaches
it. 33.84 MB is the floor for xelatex, and 22 MB of it is ICU.

That also bounds what is left. Of a 69.4 MB first compile, 32.5 MB is the engine
(7 MB brotli, per this ADR's own measurement), 22 MB is ICU and 5.9 MB is the
format file — **60.4 MB of 69.4 MB is four artifacts**, none of which the
delivery model can touch. The 17–21 MB this ADR set out to reach is not
reachable by indexing files, because files are no longer the cost.

### Measured: pre-compressing what is left

The floor analysis above ends by saying the remaining bytes are four artifacts
delivery cannot touch, and that the lever on them is the transport rather than
the index. Applied, on `presentation-beamer`:

| | uncompressed | brotli |
|---|---:|---:|
| app | 0.1 MB | 0.1 MB |
| tex engine | 31.1 MB | **8.2 MB** |
| boot set | 13.8 MB | **9.9 MB** |
| endpoint files | 3.0 MB | **1.0 MB** |
| pdf renderer | 10.0 MB | **3.5 MB** |
| **total** | **57.8 MB** | **22.6 MB** |
| time | 11.1 s | 6.7 s |

At quality 11: the engine 32.51 MB → 8.50 MB (26%), the boot package
33.85 MB → 10.28 MB (30%), MuPDF 10.41 MB → 3.60 MB (35%). Compression is
precomputed, because quality 11 on 33 MB takes around 100 s — once in a build,
absurd per request.

Two things the measurement found rather than confirmed. Once the engine was
compressed **the largest single response was MuPDF**, which Vite emits hashed
into `dist/assets` where nothing was compressing it; and the endpoint's 3.0 MB
was uncompressed for no better reason than that nobody had looked. The endpoint
now compresses at **quality 4, not 11** — its files are read by a *synchronous*
XHR inside the worker, so compression time is time TeX is blocked, and a better
ratio is the wrong trade.

What is deliberately *not* compressed is as load-bearing. `texlive-extra.data`
is read by byte offset, and a transport encoding would make it unseekable, so
the middleware also refuses the pre-compressed path for any request carrying a
`Range` header: `Range` and `Content-Encoding` together describe a range of the
*encoded* stream, which is not what any caller here means. Siglum's `.data.gz`
keeps its raw path, and `Content-Type: application/wasm` is set explicitly —
ADR-003 records two deployments broken on exactly these two points, both
invisibly.

### Result: the whole corpus, first compile

| | ADR-011 as written | now |
|---|---:|---:|
| First compile, range | 41–135 MB | **21.8–23.4 MB** |
| Spread across documents | 94 MB | **1.6 MB** |
| Compiled | 9/13 (CTAN on) | 12/14 (no network) |

The range is the more interesting half. **22.66 MB of every successful first
load is fixed** — 8.2 MB of engine, 9.9 MB of boot set, 3.6 MB of renderer and
the app — identical for every document, with only 0.2–1.8 MB varying with what
the document actually uses. Before a PDF exists the fixed part is 19.03 MB: the
renderer is fetched only once there is something to show, which is why
`paper-acm` and `paper-ieee` stop there. The delivery
problem this ADR opened with was that `presentation-beamer` cost 118.9 MB and
`blank` cost 41 MB, a 3× spread driven entirely by which bundles happened to be
pulled. That spread is gone: the two documents now differ by 0.8 MB.

`paper-acm` and `paper-ieee` appear at 18.2 MB because they fail before the
renderer loads; they are not a smaller first load, they are an incomplete one.

**Against the target.** This ADR set out to reach 17–21 MB. A first compile is
21.8–23.4 MB, which is *just* above it, and the honest reading is that the
target was set against a different cost structure — it assumed the variable
part, TeX files, was the problem. It no longer is: files are 0.2–1.7 MB of a
22 MB load. Getting under 17 MB now means a smaller engine or dropping ICU,
which are engine build questions, not delivery ones, and they are recorded in
ADR-003 rather than here.

### The endpoint is a kpathsea implementation, not a file server

Three separate failures during this work were the same defect — the resolver
knowing fewer of kpathsea's conventions than the engine assumes — and not one
of them named the endpoint:

| Symptom | Reported as | Actually |
|---|---|---|
| `presentation-beamer` stops | `missing-file` | asked for `beamerbasenavigationsymbols`, file is `…​.tex` |
| `thesis-standard` stops | `syntax` | asked for `lipsum.ltd`, file is `lipsum.ltd.tex` |
| every document stops | `! Font …​ not loadable` | asked for `lmroman12-regular` under formats 47, 36 and 32, file is `…​.otf` |

kpathsea resolves a name by trying it and then trying the extensions its
*format* implies, and the engine asks a remote resolver exactly as it asks a
local tree. The format code is the only thing that says which file is meant, so
the endpoint now carries a table keyed by `kpse_file_format_type`. Anything the
local resolver does implicitly has to be done here explicitly, and a gap shows
up as a document failing somewhere unrelated rather than as a 404 anybody
notices. That is the standing cost of this model and it belongs in the decision,
not in a changelog.

### What this does not yet solve

`paper-acm` and `paper-ieee` are unchanged: `acmart.cls` and `IEEEtran.cls` are
in no tier, so the endpoint correctly 404s them. They are in `texmfrepo.txt`,
which indexes the full 8,418-package TeX Live archive — a different source from
the one indexed here, and the remaining gap.

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
- [x] Index the TeX Live 2026 tree and measure a first load. **11/13 at 92.8 MB
      preloaded plus 9.06 MB fetched**, the same coverage and the same fidelity
      as 636 MB of tiers. See above.
- [x] Cut the preload floor below the `basic` tier. **33.84 MB, 110 files**,
      compiling the same 11/13 — and a first compile of 69.4 MB against 126.7.
      Established why it cannot go lower: 60.4 MB of that is the engine, ICU and
      the format file, none of which this model can address.
- [x] Apply brotli. **A first compile is 21.8–23.4 MB, from 57.8 MB**, and the
      spread across the corpus fell from 94 MB to 1.6 MB. See above.
- [ ] Shrink the engine and ICU, which are what is left: of 22.66 MB fixed,
      8.2 MB is the engine and 9.9 MB the boot set (22 MB of it ICU). Both are
      engine *build* questions rather than delivery ones — `engineMode` already
      selects `<mode>.wasm`, but only the combined `busytex.wasm` ships, so a
      xetex-only binary is a supported configuration with no artifact behind it
      (ADR-003).
- [ ] Serve `acmart` and `IEEEtran` from the `texmfrepo` archive, which is a
      different and larger source than the tiers indexed here.
- [ ] Measure `kpse_remote_register_misses` with a set of misses, against the
      one-file-per-pass cost recorded above.
- [x] Whether a tree scoped to plausible documents is small enough to serve from
      the same static host as the app. **Only the narrowest tier is.** Measured
      from the pinned tree's index: corpus 4.8 MB, all runtime macros 249 MB,
      macros plus Latin-script fonts 399 MB, the whole tree 2.6 GB. A tier that
      ends discovery is hundreds of megabytes, so it needs object storage, as
      this ADR's consequences already assumed.

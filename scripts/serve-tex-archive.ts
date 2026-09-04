/**
 * Serve the indexed TeX archive as a measurement rig (ADR-011's open risk).
 *
 * The delivery model trades one large download for one range request per file,
 * so what it costs is round trips, and round trips depend on two things this
 * serves in order to control: the protocol, and the latency.
 *
 * **Protocol.** Over HTTP/1.1 a browser opens at most six connections per
 * origin, which caps a 145-file document at six requests in flight however many
 * the client asks for. Over HTTP/2 they are streams on one connection and the
 * limit is the server's. Measuring against `vite preview`, which is HTTP/1.1,
 * would find that cap and report it as a plateau. `--protocol` serves either
 * from the same code, so the comparison is of protocols and nothing else.
 * Browsers speak HTTP/2 only over TLS, so both are TLS with a self-signed
 * certificate the spike is told to accept.
 *
 * **Latency.** Chrome's CDP throttling queues requests before delaying them,
 * which serialises exactly the parallelism under test: six streams at 50 ms
 * measured 423 ms rather than one round trip. So delay is applied here instead,
 * per request, after the range is resolved. A client asking for `x-delay-ms`
 * gets that many milliseconds added to each response, and concurrent requests
 * overlap the way they would over a real link.
 *
 * A rig, not a deployment. Real hosting is object storage with range support.
 *
 * Usage: pnpm serve:tex-archive [--port 4443] [--protocol h2|h1]
 */
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import {
  createSecureServer,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TEX_DIR = resolve("public/tex");
const TLS_DIR = resolve(".cache/tls");
const KEY = resolve(TLS_DIR, "key.pem");
const CERT = resolve(TLS_DIR, "cert.pem");

/** A throwaway certificate for localhost, generated once and cached. */
function ensureCertificate(): void {
  if (existsSync(KEY) && existsSync(CERT)) return;
  mkdirSync(TLS_DIR, { recursive: true });
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      KEY,
      "-out",
      CERT,
      "-days",
      "30",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(
      `openssl failed (${result.status}): ${result.stderr?.toString() ?? ""}`,
    );
  }
}

/** `bytes=<start>-<end>`, the only form `indexed-bundle.ts` sends. */
function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match?.[1]) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (start > end || start >= size) return undefined;
  return [start, Math.min(end, size - 1)];
}

/** Milliseconds the client asked to have added to this response. */
function requestedDelay(headers: IncomingHttpHeaders): number {
  const raw = Number(headers["x-delay-ms"]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5_000) : 0;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>tex archive</title>
<p>Range-request measurement origin. See scripts/serve-tex-archive.ts.</p>`;

/** What to send: the landing page, a 404, or all or part of a file. */
type Reply =
  | { kind: "page" }
  | { kind: "missing" }
  | { kind: "file"; file: string; size: number; range?: [number, number] };

function route(rawPath: string, headers: IncomingHttpHeaders): Reply {
  const path = rawPath.split("?")[0] ?? "/";
  if (path === "/" || path === "/index.html") return { kind: "page" };
  if (!path.startsWith("/tex/") || path.includes("..")) {
    return { kind: "missing" };
  }
  const file = resolve(TEX_DIR, path.slice("/tex/".length));
  if (!file.startsWith(TEX_DIR) || !existsSync(file))
    return { kind: "missing" };
  const size = statSync(file).size;
  const range = parseRange(headers.range as string | undefined, size);
  return range
    ? { kind: "file", file, size, range }
    : { kind: "file", file, size };
}

/** Headers for a whole file or one slice of it, shared by both protocols. */
function fileHeaders(reply: Extract<Reply, { kind: "file" }>): {
  status: number;
  headers: Record<string, string | number>;
} {
  const common = {
    "accept-ranges": "bytes",
    "content-type": "application/octet-stream",
    // Every measurement wants a cold fetch; a revalidated 304 would time the
    // cache rather than the delivery model.
    "cache-control": "no-store",
  };
  if (!reply.range) {
    return {
      status: 200,
      headers: { ...common, "content-length": reply.size },
    };
  }
  const [start, end] = reply.range;
  return {
    status: 206,
    headers: {
      ...common,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${reply.size}`,
    },
  };
}

/** Read options for a reply, whole file or slice. */
function readOptions(
  reply: Extract<Reply, { kind: "file" }>,
): { start: number; end: number } | undefined {
  return reply.range
    ? { start: reply.range[0], end: reply.range[1] }
    : undefined;
}

function startHttp2(port: number): void {
  const server = createSecureServer({
    key: readFileSync(KEY),
    cert: readFileSync(CERT),
    // Concurrent streams are the thing under test, so this must not be the
    // server's default rather than what the client asked for.
    settings: { maxConcurrentStreams: 256 },
  });
  server.on(
    "stream",
    (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      const reply = route(String(headers[":path"] ?? "/"), headers);
      void (async () => {
        await delay(requestedDelay(headers));
        if (reply.kind === "page") {
          stream.respond({ ":status": 200, "content-type": "text/html" });
          stream.end(PAGE);
          return;
        }
        if (reply.kind === "missing") {
          stream.respond({ ":status": 404 });
          stream.end();
          return;
        }
        const { status, headers: out } = fileHeaders(reply);
        stream.respond({ ":status": status, ...out });
        createReadStream(reply.file, readOptions(reply)).pipe(stream);
      })();
    },
  );
  server.listen(port, () => {
    console.log(`HTTP/2 on https://localhost:${port} (self-signed)`);
  });
}

function startHttp1(port: number): void {
  const server = createServer(
    { key: readFileSync(KEY), cert: readFileSync(CERT) },
    (request, response: ServerResponse) => {
      const headers = request.headers as IncomingHttpHeaders;
      const reply = route(request.url ?? "/", headers);
      void (async () => {
        await delay(requestedDelay(headers));
        if (reply.kind === "page") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(PAGE);
          return;
        }
        if (reply.kind === "missing") {
          response.writeHead(404);
          response.end();
          return;
        }
        const { status, headers: out } = fileHeaders(reply);
        response.writeHead(status, out);
        createReadStream(reply.file, readOptions(reply)).pipe(response);
      })();
    },
  );
  server.listen(port, () => {
    console.log(`HTTP/1.1 on https://localhost:${port} (self-signed)`);
  });
}

function main(): void {
  const arg = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const port = Number(arg("--port") ?? 4443);
  const protocol = arg("--protocol") ?? "h2";

  if (!existsSync(TEX_DIR)) {
    throw new Error("No archive; run pnpm spike:tex-archive first");
  }
  ensureCertificate();

  if (protocol === "h2") startHttp2(port);
  else if (protocol === "h1") startHttp1(port);
  else throw new Error(`Unknown protocol ${protocol}; use h2 or h1`);
  console.log("Delay per request comes from the client's x-delay-ms header.");
}

main();

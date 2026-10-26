/**
 * server.js — a zero-dependency Node demo of how to use the ds-pow library
 * from the *issuing* side.
 *
 * The library's job is to solve a challenge. This server is the other half:
 * it issues challenges, hands them to a browser page, and verifies the answer
 * that comes back. Together they exercise both directions of the protocol, and
 * the code in here doubles as the reference for how a server should construct
 * a challenge — which is the one thing that isn't obvious from the client side.
 *
 * Run it:
 *   node server.js            # http://localhost:8787
 *   PORT=3000 node server.js
 *
 * The interesting bits, in order:
 *   GET  /api/challenge  -> mint a challenge (see issueChallenge)
 *   POST /api/verify     -> check the answer the page computed
 *   GET  /api/selfcheck  -> solve the known vectors against the vendored WASM
 *   GET  /sha3_wasm_bg.wasm -> the module itself, served as application/wasm
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomInt, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

import { createPow, ALGORITHM } from './ds-pow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const WASM_PATH = join(HERE, 'sha3_wasm_bg.wasm');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

/** How long a challenge stays valid. DeepSeek uses ~30s; 60s is friendlier to a demo. */
const CHALLENGE_TTL_MS = 60_000;
/** Search-space bound, matching the difficulty DeepSeek itself advertises. */
const DEFAULT_DIFFICULTY = 144_000;
/** Ceiling so a `?difficulty=` query param can't ask for a minutes-long solve. */
const MAX_DIFFICULTY = 5_000_000;
/** Cap on outstanding challenges, so this demo cannot grow unbounded. */
const MAX_PENDING = 1_000;

/**
 * Challenges we handed out and have not seen a valid answer for yet.
 * In-memory and per-process: a real deployment needs a shared store, but the
 * point here is to show *that* the issuer must remember what it issued.
 * @type {Map<string, {salt: string, expireAt: number, difficulty: number, nonce: number, targetPath: string}>}
 */
const pending = new Map();

/** Lazily created so `node server.js` fails on a bad WASM at startup, not on first request. */
let pow;

// ── Challenge issuance ──────────────────────────────────────────────────────

/**
 * Mints a challenge, given the answer it should have.
 *
 * The whole trick of the protocol: the issuer picks the nonce *first* (here
 * uniformly from `[0, difficulty)`), hashes `salt_expireAt_nonce`, and sends
 * the hash out as `challenge`. The client then has to search the same space to
 * recover the nonce. Because the issuer's nonce is drawn from below
 * `difficulty`, and the client searches exactly `[0, difficulty)`, every
 * challenge issued this way is solvable — and the answer is unique.
 *
 * The answer never leaves the server, so `challenge` reveals nothing about it
 * beyond its hash.
 */
function issueChallenge({ targetPath = '/api/v0/chat/completion', difficulty = DEFAULT_DIFFICULTY } = {}) {
  const salt = randomBytes(10).toString('hex'); // 20 hex chars, same length as DeepSeek's
  const expireAt = Date.now() + CHALLENGE_TTL_MS;
  const nonce = randomInt(0, difficulty); // must be < difficulty, see above
  const challenge = pow.hash(`${salt}_${expireAt}_${nonce}`);

  if (pending.size >= MAX_PENDING) {
    // Drop whatever has expired; if nothing has, refuse rather than evict a
    // live challenge and hand out an answer nobody can submit.
    for (const [key, entry] of pending) {
      if (entry.expireAt < Date.now()) pending.delete(key);
    }
    if (pending.size >= MAX_PENDING) {
      throw Object.assign(new Error('too many outstanding challenges'), { status: 503 });
    }
  }
  pending.set(challenge, { salt, expireAt, difficulty, nonce, targetPath });

  return { challenge, salt, expireAt, difficulty, targetPath };
}

/**
 * Checks a submitted answer.
 *
 * Two independent checks, and both matter:
 *   1. `pow.verify()` re-hashes the answer and compares it to the challenge —
 *      this is what makes the work verifiable in one hash call.
 *   2. `pending` + `expireAt` — because re-hashing alone would accept the same
 *      correct answer forever, letting one solve be replayed indefinitely.
 *      Deleting on success makes each challenge single-use.
 */
function verifyAnswer({ challenge, answer }) {
  const started = Date.now();
  const entry = pending.get(challenge);
  if (!entry) {
    return { ok: false, reason: 'unknown-or-already-used-challenge' };
  }
  if (entry.expireAt < Date.now()) {
    pending.delete(challenge);
    return { ok: false, reason: 'expired' };
  }

  const ok = pow.verify({ challenge, salt: entry.salt, expireAt: entry.expireAt, answer });
  if (!ok) {
    // Deliberately leaves the challenge pending: a client that mis-solved once
    // may retry, and a real implementation wants a wrong-answer counter here.
    return { ok: false, reason: 'wrong-answer', verifyMs: Date.now() - started };
  }

  pending.delete(challenge); // single-use
  return {
    ok: true,
    answerMatchesIssuedNonce: answer === entry.nonce,
    verifyMs: Date.now() - started,
    targetPath: entry.targetPath,
  };
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', // exact type required for WebAssembly.instantiateStreaming
  '.json': 'application/json; charset=utf-8',
});

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Reads a JSON request body, refusing anything implausibly large for this API. */
async function readJson(req, limit = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error('request body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400 });
  }
}

/**
 * Maps a URL path onto a file under public/, or null if it isn't one.
 *
 * The normalization + `sep` prefix check is the important part: without it a
 * request for `/../../server.js` escapes the directory. Serving static files
 * from a user-controlled path is the classic way to leak a source tree.
 */
function resolveStatic(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const resolved = normalize(join(PUBLIC_DIR, relative));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + sep)) return null;
  return resolved;
}

async function serveStatic(res, pathname) {
  const filePath = resolveStatic(decodeURIComponent(pathname));
  if (!filePath) return sendJson(res, 403, { error: 'forbidden' });

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not found', path: pathname });
  }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    // The WASM is content-addressed by its own hash in practice; during a demo
    // it should never be cached, so a re-vendored module is picked up at once.
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname.startsWith('/api/')) await ensurePow();

    if (pathname === '/api/challenge') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'use GET' });
      const requested = Number(url.searchParams.get('difficulty') ?? DEFAULT_DIFFICULTY);
      const difficulty = Math.min(
        MAX_DIFFICULTY,
        Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_DIFFICULTY)
      );
      const targetPath = url.searchParams.get('targetPath') ?? '/api/v0/chat/completion';
      const challenge = issueChallenge({ targetPath, difficulty });
      return sendJson(res, 200, {
        algorithm: ALGORITHM,
        // Echoed for the benefit of clients that expect the full DeepSeek shape.
        challenge: challenge.challenge,
        salt: challenge.salt,
        expire_at: challenge.expireAt,
        difficulty: challenge.difficulty,
        target_path: challenge.targetPath,
        signature: '',
        expires_in_ms: CHALLENGE_TTL_MS,
        pending_count: pending.size,
      });
    }

    if (pathname === '/api/verify') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
      const body = await readJson(req);
      if (typeof body.challenge !== 'string' || !Number.isFinite(body.answer)) {
        return sendJson(res, 400, { error: 'expected { challenge: string, answer: number }' });
      }
      const result = verifyAnswer(body);
      return sendJson(res, 200, { ...result, pending_count: pending.size });
    }

    if (pathname === '/api/selfcheck') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'use GET' });
      const started = Date.now();
      try {
        await pow.selfCheck();
        return sendJson(res, 200, { ok: true, vectors: 2, ms: Date.now() - started });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message, ms: Date.now() - started });
      }
    }

    if (pathname === '/sha3_wasm_bg.wasm' || pathname === '/ds-pow.js') {
      // Served from the library directory rather than public/, so each file
      // lives in exactly one place and this demo can never drift from the lib.
      const body = await readFile(join(HERE, pathname.slice(1)));
      res.writeHead(200, {
        'content-type': MIME[pathname.slice(pathname.lastIndexOf('.'))],
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: `unsupported method ${req.method}` });
    }
    return await serveStatic(res, pathname);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`${req.method} ${pathname} failed:`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
});

/**
 * Loads the module and starts listening.
 *
 * Kept out of module scope so importing this file (from a test, or to reuse
 * `issueChallenge`) does not bind a port as a side effect.
 */
async function start() {
  const wasmBytes = await readFile(WASM_PATH);
  pow = await createPow(wasmBytes);
  // Self-check before binding the port: a demo server that comes up and then
  // serves wrong answers is worse than one that refuses to start.
  await pow.selfCheck();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log(`ds-pow demo server listening on http://${HOST}:${PORT}`);
  console.log(`  wasm self-check passed (${ALGORITHM}, ${wasmBytes.length} byte module)`);
  console.log(`  open the page above, or: curl http://${HOST}:${PORT}/api/challenge`);
  return server;
}

/** Loads the WASM if it isn't loaded yet, for tests that call the handlers directly. */
async function ensurePow() {
  if (!pow) pow = await createPow(await readFile(WASM_PATH));
  return pow;
}

export { server, start, ensurePow, issueChallenge, verifyAnswer, pending, DEFAULT_DIFFICULTY, MAX_DIFFICULTY };

// Only bind a port when this file is the entry point (`node server.js`).
// pathToFileURL is used so the comparison holds when launched via a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n${signal} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
  await start();
}

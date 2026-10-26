/**
 * ds-pow.js — DeepSeek's `DeepSeekHashV1` proof-of-work, as a standalone
 * library that runs in a browser page, a Web Worker, or plain Node.
 *
 * It contains **no Node built-ins at all** — `node:fs`, `import.meta.url` and
 * `Buffer` are all absent — so the same file can be served straight to a
 * browser as an ES module. The caller supplies the WASM bytes (or a URL to
 * fetch them from) rather than the library reading a path off disk.
 *
 * ── What this solves ────────────────────────────────────────────────────────
 *
 * chat.deepseek.com gates `chat/completion` and `file/upload_file` behind a
 * proof-of-work challenge, solved in the real client by a Web Worker wrapping
 * `sha3_wasm_bg.<hash>.wasm`. That module has **zero WASM imports** — it needs
 * nothing from its host beyond what `WebAssembly.instantiate()` provides by
 * default — so it runs identically in a page, a Worker, and Node. No Worker,
 * no DOM, no glue JS is required; a Worker is still a good idea on a page for
 * the *blocking* reason described under "In a Web Worker" in the README.
 *
 * The vendored binary (`./sha3_wasm_bg.wasm`, byte-for-byte from
 * `https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`,
 * captured 2026-09-09, sha256 b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d)
 * is checked in beside this file. DeepSeek may rotate it at any time — see
 * "The vendored WASM" in the README.
 *
 * ── The algorithm ──────────────────────────────────────────────────────────
 *
 *   prefix = `${salt}_${expireAt}_`
 *   solve(challenge, prefix, difficulty):
 *     for nonce in 0, 1, 2, ... < difficulty:
 *       if hex(deepseek_hash_v1(prefix + nonce)) === challenge:
 *         return nonce
 *
 * An **exact-match search** against a server-chosen target string — not
 * leading zero bits, not `hash mod difficulty`, not a difficulty threshold.
 * The issuer picks a secret nonce, hashes `prefix + nonce`, and hands out the
 * result as `challenge`; the client has to search for the nonce that produced
 * it, and the issuer can verify any submitted answer with a single hash.
 *
 * `difficulty` is the **upper bound of the nonce search space** (the search
 * covers `[0, difficulty)`). That was measured, not inferred — see the
 * "difficulty" section of the README for the probe results — and it has two
 * consequences worth knowing:
 *   - A challenge is only solvable if the issuer's secret nonce is below the
 *     `difficulty` it advertises. Both captured DeepSeek vectors satisfy this
 *     (answers 98797 and 61041, both difficulty 144000).
 *   - Solve cost is linear and predictable: the search walks every integer in
 *     `[0, difficulty)`, so ~difficulty/2 hashes on average and `difficulty`
 *     in the worst case. Measured at ~0.19µs per candidate (~5.3M/s) here, i.e.
 *     ~14ms average and ~27ms worst case at difficulty 144000.
 *
 * ── Calling convention (measured against the vendored binary) ──────────────
 *
 * wasm-bindgen's ABI, verified by parsing the WASM type/export sections and
 * then confirming each rule by experiment (see README "Memory ownership"):
 *
 *   __wbindgen_export_0  (size, align) -> ptr                 // malloc
 *   __wbindgen_export_1  (ptr, old, new, align) -> ptr        // realloc
 *   __wbindgen_export_2  (ptr, size, align) -> void           // free
 *   __wbindgen_add_to_stack_pointer(delta) -> retptr          // scratch area
 *   wasm_deepseek_hash_v1(retptr, msgPtr, msgLen)             // writes {ptr,len}
 *   wasm_solve(retptr, cPtr, cLen, pPtr, pLen, difficulty)    // writes {status,answer}
 *
 * Ownership rules, both load-bearing:
 *   - **String arguments are owned by the WASM.** It frees them itself. Do not
 *     free them from JS: doing so double-frees and the next `wasm_solve` call
 *     traps with `RuntimeError: unreachable`.
 *   - **The buffer `wasm_deepseek_hash_v1` returns is owned by the caller.**
 *     Nothing frees it for us at this level (the glue JS that normally would
 *     is exactly what we're replacing), so we free it — otherwise every hash
 *     leaks ~72 bytes and 20k calls grow WASM memory by 1.4MB.
 *
 * @see README.md in this directory for the full writeup and the probe results.
 */

/** The only PoW algorithm variant this library implements. */
const ALGORITHM = 'DeepSeekHashV1';

/**
 * Challenge/answer pairs captured live from chat.deepseek.com and cross-checked
 * against the actual `x-ds-pow-response` header a real browser client sent on
 * an accepted (HTTP 200) request. Exported so callers can self-test a vendored
 * WASM build offline; if DeepSeek rotates the module, these are the first thing
 * that starts failing.
 */
const KNOWN_VECTORS = Object.freeze([
  Object.freeze({
    targetPath: '/api/v0/chat/completion',
    challenge: '0758468698a51f743ed2b20955b814e646c1676b9a2c71d83f5c256cdabacf4f',
    salt: '6e57c84af19979788e44',
    expireAt: 1788969010439,
    difficulty: 144000,
    answer: 98797,
  }),
  Object.freeze({
    targetPath: '/api/v0/file/upload_file',
    challenge: '37bc8f993832fdd21b27cae76513b40068fa2e35c82ea24d8858329c5d707f72',
    salt: 'b4a6124d53ed34c4401c',
    expireAt: 1788969010602,
    difficulty: 144000,
    answer: 61041,
  }),
]);

/** Exports this library calls, with what each one is for in the failure message. */
const REQUIRED_EXPORTS = Object.freeze({
  memory: 'linear memory',
  wasm_deepseek_hash_v1: 'the DeepSeekHashV1 hash primitive',
  wasm_solve: 'the nonce search',
  __wbindgen_add_to_stack_pointer: 'wasm-bindgen scratch-space helper',
  __wbindgen_export_0: 'wasm-bindgen allocator (malloc)',
  __wbindgen_export_2: 'wasm-bindgen deallocator (free)',
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── WASM loading ────────────────────────────────────────────────────────────

/**
 * Builds a `WebAssembly.Instance` from any of the sources a browser or Node
 * caller might reasonably have.
 */
async function instantiateFrom(source) {
  // A promise for any of the below (e.g. an in-flight fetch) — unwrap first.
  if (source && typeof source.then === 'function') {
    return instantiateFrom(await source);
  }
  if (typeof WebAssembly.Module === 'function' && source instanceof WebAssembly.Module) {
    return new WebAssembly.Instance(source);
  }
  if (typeof Response === 'function' && source instanceof Response) {
    return instantiateFromResponse(source);
  }
  if (typeof source === 'string' || (typeof URL === 'function' && source instanceof URL)) {
    return instantiateFromResponse(await fetchWasm(source));
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance;
  }
  throw new TypeError(
    'ds-pow: createPow() needs the sha3_wasm_bg.wasm as a URL/string to fetch, a Response, ' +
      'an ArrayBuffer/TypedArray of bytes, a WebAssembly.Module, or a Promise for one of those. ' +
      `Got ${describe(source)}.`
  );
}

async function fetchWasm(url) {
  if (typeof fetch !== 'function') {
    throw new Error(
      `ds-pow: cannot load the PoW module from "${url}" — no global fetch() in this environment. ` +
        'Read the file yourself and pass the bytes instead: createPow(await readFile("sha3_wasm_bg.wasm")).'
    );
  }
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      `ds-pow: fetching the PoW module from "${url}" failed: ${err.message}. ` +
        'In a browser this must be served over http(s) — a relative path resolves against the page. ' +
        'In Node, fetch() cannot read a filesystem path: pass the bytes instead, e.g. ' +
        'createPow(await readFile(new URL("./sha3_wasm_bg.wasm", import.meta.url))).'
    );
  }
  if (!response.ok) {
    throw new Error(`ds-pow: fetching the PoW module from "${url}" failed: HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

/**
 * Prefers `instantiateStreaming` (starts compiling while the body is still
 * arriving) but falls back to buffering when the server doesn't label the
 * response `application/wasm` — the single most common reason a working WASM
 * fetch fails in a browser, and exactly the kind of deployment detail a
 * library shouldn't push onto its callers.
 */
async function instantiateFromResponse(response) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (typeof WebAssembly.instantiateStreaming === 'function' && /application\/wasm/.test(contentType)) {
    try {
      // Clone: streaming consumes the body, and a failed attempt must not
      // leave us with a used-up Response for the fallback path.
      const { instance } = await WebAssembly.instantiateStreaming(response.clone(), {});
      return instance;
    } catch {
      // MIME was right but streaming still failed (bad length, truncated body,
      // …). Fall through and let the buffered path surface a real error.
    }
  }
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  return instance;
}

// ── wasm-bindgen ABI bridge ─────────────────────────────────────────────────

/**
 * Wraps an instance's raw exports in the handful of primitives this library
 * needs, so no calling convention leaks into the public API.
 */
function bind(instance) {
  const exports = instance?.exports ?? {};
  const missing = Object.keys(REQUIRED_EXPORTS).filter((name) => !(name in exports));
  if (missing.length > 0) {
    throw new Error(
      `ds-pow: the WASM module is missing expected export(s): ${missing
        .map((name) => `${name} (${REQUIRED_EXPORTS[name]})`)
        .join(', ')}. ` +
        'DeepSeek likely shipped a new sha3_wasm_bg.wasm build — this library needs to be re-vendored ' +
        'against it (see README.md).'
    );
  }

  const { memory, wasm_deepseek_hash_v1: hashFn, wasm_solve: solveFn } = exports;
  const malloc = exports.__wbindgen_export_0;
  const free = exports.__wbindgen_export_2;
  const addToStackPointer = exports.__wbindgen_add_to_stack_pointer;

  /**
   * Copies `s` into WASM linear memory and returns `[ptr, len]`.
   *
   * The Uint8Array view is created *after* malloc because malloc can grow
   * memory, which detaches and replaces `memory.buffer`. Ownership of the
   * returned bytes passes to the WASM — callers must not free them.
   */
  function passString(s) {
    const bytes = textEncoder.encode(s);
    const ptr = malloc(bytes.length, 1) >>> 0;
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  }

  /** DeepSeekHashV1 over `message`, as the 64-hex-character string the wasm emits. */
  function hash(message) {
    const [msgPtr, msgLen] = passString(message);
    const retptr = addToStackPointer(-16);
    let outPtr;
    let outLen;
    try {
      hashFn(retptr, msgPtr, msgLen);
      const view = new DataView(memory.buffer);
      outPtr = view.getInt32(retptr, true);
      outLen = view.getInt32(retptr + 4, true);
      return textDecoder.decode(new Uint8Array(memory.buffer, outPtr, outLen));
    } finally {
      addToStackPointer(16);
      // The hash's return value is a caller-owned Vec<u8>; decode() above has
      // already copied it into a JS string, so it is safe to release now.
      if (outPtr !== undefined) free(outPtr, outLen, 1);
    }
  }

  /** Runs the nonce search, returning the raw `{status, answer}` out-params. */
  function solveRaw(challenge, prefix, difficulty) {
    const [challengePtr, challengeLen] = passString(challenge);
    const [prefixPtr, prefixLen] = passString(prefix);
    const retptr = addToStackPointer(-16);
    try {
      solveFn(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty);
      const view = new DataView(memory.buffer);
      return { status: view.getInt32(retptr, true), answer: view.getFloat64(retptr + 8, true) };
    } finally {
      // Only the scratch area is released here. The two strings are owned by
      // the WASM, which frees them itself — freeing them here double-frees and
      // traps the *next* wasm_solve call with "unreachable".
      addToStackPointer(16);
    }
  }

  return { hash, solveRaw, memory };
}

// ── Input validation ────────────────────────────────────────────────────────

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof ArrayBuffer) return 'an ArrayBuffer';
  if (ArrayBuffer.isView(value)) return `a ${value.constructor?.name ?? 'TypedArray'}`;
  if (typeof value === 'object') return `an object (${Object.keys(value).join(', ') || 'no keys'})`;
  return `${typeof value} ${String(value)}`;
}

/**
 * Validates the fields needed to build the hash prefix, and returns it.
 *
 * `difficulty` is deliberately *not* required here: it bounds the search, so
 * only `solve()` needs it. `verify()` is a single hash against
 * `prefix + answer` and must work without it — a verifier that only knows the
 * challenge, salt, expiry and answer can still check the answer.
 *
 * @param {{challenge: string, salt: string, expireAt: number}} params
 * @param {string} fnName for the error messages
 */
function prefixFor({ challenge, salt, expireAt }, fnName) {
  if (typeof challenge !== 'string' || !challenge) {
    throw new TypeError(`ds-pow: ${fnName}() requires a non-empty \`challenge\` string`);
  }
  if (typeof salt !== 'string' || !salt) {
    throw new TypeError(`ds-pow: ${fnName}() requires a non-empty \`salt\` string`);
  }
  if (!Number.isFinite(expireAt)) {
    throw new TypeError(`ds-pow: ${fnName}() requires a numeric \`expireAt\` (epoch milliseconds)`);
  }
  return `${salt}_${expireAt}_`;
}

/**
 * Normalizes a raw DeepSeek `create_pow_challenge` challenge object (snake_case,
 * as the API returns it) into the `{challenge, salt, expireAt, difficulty}`
 * shape this library's methods take.
 *
 * @param {object} raw
 * @returns {{challenge: string, salt: string, expireAt: number, difficulty: number, targetPath?: string}}
 */
function normalizeChallenge(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError(`ds-pow: normalizeChallenge() requires a challenge object; got ${describe(raw)}`);
  }
  const algorithm = raw.algorithm ?? ALGORITHM;
  if (algorithm !== ALGORITHM) {
    // Checked as early as possible: an unknown algorithm is the one failure
    // that would otherwise look like a wrong answer rather than a clean error.
    throw new Error(`ds-pow: unsupported PoW algorithm "${algorithm}" — this library implements ${ALGORITHM} only`);
  }
  const expireAt = raw.expireAt ?? raw.expire_at;
  if (expireAt === undefined) {
    throw new TypeError('ds-pow: challenge is missing `expire_at` (epoch milliseconds)');
  }
  return {
    challenge: raw.challenge,
    salt: raw.salt,
    expireAt,
    difficulty: raw.difficulty,
    targetPath: raw.target_path ?? raw.targetPath,
  };
}

/**
 * Encodes the `x-ds-pow-response` header value DeepSeek expects: base64 of the
 * JSON answer payload. `signature` is passed through untouched — it is opaque
 * to the client and unrelated to the PoW.
 *
 * @param {object} challenge raw challenge object (as returned by the API)
 * @param {number} answer nonce from solve()
 * @returns {string} base64, ready to send as the header value
 */
function buildPowResponse(challenge, answer) {
  if (typeof btoa !== 'function') {
    throw new Error('ds-pow: buildPowResponse() needs a global btoa (any browser, Worker, or Node >= 16)');
  }
  const payload = {
    algorithm: challenge.algorithm ?? ALGORITHM,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path ?? challenge.targetPath,
  };
  let binary = '';
  for (const byte of textEncoder.encode(JSON.stringify(payload))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Loads the vendored PoW module and returns a solver bound to it.
 *
 * @param {string|URL|Response|ArrayBuffer|ArrayBufferView|WebAssembly.Module|Promise} source
 *   Where to get `sha3_wasm_bg.wasm`. A browser page passes a URL to fetch
 *   (`'./sha3_wasm_bg.wasm'`); Node passes the bytes (`await readFile(path)`),
 *   since `fetch()` cannot read a filesystem path.
 * @returns {Promise<Pow>}
 */
async function createPow(source) {
  const instance = await instantiateFrom(source);
  const { hash, solveRaw, memory } = bind(instance);
  const wasm = Object.freeze({ instance, exports: instance.exports, memory });

  const pow = {
    /** The algorithm string, for callers that need to echo it back. */
    algorithm: ALGORITHM,

    /**
     * DeepSeekHashV1 over an arbitrary string, as 64 lowercase hex characters.
     * Synchronous: it is a single hash call, always sub-millisecond.
     *
     * This is the primitive `solve()` searches with, so it doubles as a
     * verifier — `hash(prefix + answer) === challenge` is the exact predicate.
     *
     * @param {string} message
     * @returns {string}
     */
    hash(message) {
      if (typeof message !== 'string') {
        throw new TypeError(`ds-pow: hash() requires a string; got ${describe(message)}`);
      }
      return hash(message);
    },

    /**
     * Searches for the nonce whose hash matches `challenge`.
     *
     * Async so that callers do not have to change when a solve is offloaded to
     * a Worker or partitioned across threads; today the search runs
     * synchronously on the calling thread. The search is a brute-force scan of
     * `[0, difficulty)` — ~difficulty/2 hashes on average, `difficulty` worst
     * case, ~0.19µs each — so ~14ms average and ~27ms worst case at
     * DeepSeek's difficulty of 144000. See "In a Web Worker" in the README.
     *
     * @param {{challenge: string, salt: string, expireAt: number, difficulty: number}} params
     * @returns {Promise<number>} the answer nonce, guaranteed `< difficulty`
     */
    async solve(params = {}) {
      const prefix = prefixFor(params, 'solve');
      const { difficulty } = params;
      if (!Number.isFinite(difficulty) || difficulty <= 0) {
        // Only solve() cares: a NaN or non-positive bound would mean an unbounded
        // or nonsensical search rather than a clean error.
        throw new TypeError('ds-pow: solve() requires a positive numeric `difficulty` (the nonce search bound)');
      }
      const started = Date.now();
      const { status, answer } = solveRaw(params.challenge, prefix, params.difficulty);
      if (status === 0) {
        const elapsed = Date.now() - started;
        // status 0 means "no nonce in [0, difficulty) matched" — the search
        // space was exhausted, so this is unsolvable as given rather than a
        // transient failure. The `answer` out-param is meaningless in that case.
        throw new Error(
          `ds-pow: no solution found after ${elapsed}ms. wasm_solve only searches nonces in ` +
            `[0, difficulty), so this means no nonce below difficulty=${params.difficulty} produces ` +
            'this challenge — the challenge, salt, expireAt, or difficulty does not match what the ' +
            'issuer used to create it (or the issuer chose its nonce outside the advertised range).'
        );
      }
      return answer;
    },

    /**
     * Recomputes the hash for `answer` and reports whether it matches
     * `challenge` — the whole verification DeepSeek needs, in one hash call.
     *
     * Purely a hash comparison: it does **not** check whether the challenge has
     * expired. That is a policy decision belonging to whoever issued the
     * challenge (compare `expireAt` against your own clock).
     *
     * @param {{challenge: string, salt: string, expireAt: number, answer: number}} params
     * @returns {boolean} true when the answer is correct for this challenge
     */
    verify(params = {}) {
      const { answer } = params;
      const prefix = prefixFor(params, 'verify');
      if (!Number.isFinite(answer) || answer < 0) {
        throw new TypeError('ds-pow: verify() requires a non-negative numeric `answer`');
      }
      return hash(`${prefix}${answer}`) === params.challenge;
    },

    /**
     * Solves a challenge object in DeepSeek's raw API shape (snake_case,
     * including `algorithm`).
     *
     * @param {object} rawChallenge
     * @returns {Promise<number>}
     */
    async solveChallenge(rawChallenge) {
      return pow.solve(normalizeChallenge(rawChallenge));
    },

    /**
     * Verifies an answer against a challenge object in DeepSeek's raw API
     * shape. Hash comparison only — expiry is the caller's business.
     *
     * @param {object} rawChallenge
     * @param {number} answer
     * @returns {boolean}
     */
    verifyChallenge(rawChallenge, answer) {
      const normalized = normalizeChallenge(rawChallenge);
      return pow.verify({ ...normalized, answer });
    },

    /**
     * Solves every known-good vector captured from chat.deepseek.com and
     * compares against the recorded answers. Throws on the first mismatch.
     * Fully offline (~40ms for the two vectors) — cheap enough to run at
     * startup so a stale or corrupted vendored WASM fails loudly and
     * immediately instead of as a mysterious bad-answer later.
     *
     * @returns {Promise<void>}
     */
    async selfCheck() {
      for (const vector of KNOWN_VECTORS) {
        let answer;
        try {
          answer = await pow.solve(vector);
        } catch (err) {
          // The common stale-module failure: a rotated or rewritten module
          // finds *no* nonce, so solve() throws before the comparison below is
          // ever reached. Passing that message through would blame the
          // challenge for what is a module problem, which is the exact
          // ambiguity this check exists to remove.
          throw new Error(
            `ds-pow: self-check failed for ${vector.targetPath}: ${err.message} ` +
              'The vendored sha3_wasm_bg.wasm may be stale or corrupted, or may implement a ' +
              'different algorithm than these vectors were captured with.'
          );
        }
        if (answer !== vector.answer) {
          throw new Error(
            `ds-pow: self-check failed for ${vector.targetPath}: expected answer=${vector.answer}, got ${answer}. ` +
              'The vendored sha3_wasm_bg.wasm may be stale or corrupted.'
          );
        }
      }
    },

    /** The underlying instance, for callers that want to call the WASM directly. */
    wasm,
  };

  return pow;
}

export { createPow, normalizeChallenge, buildPowResponse, KNOWN_VECTORS, ALGORITHM };

/**
 * ds-pow.test.js — `node --test libpow/test/`
 *
 * Covers the library (both against the known-good vectors and against
 * challenges this test mints itself), plus the demo server's issue/verify
 * cycle. The WASM path is resolved with `import.meta.url`, which is exactly
 * the pattern the library deliberately avoids internally (esbuild --format=cjs
 * empties it) but which is fine — and clearest — in a test runner.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomInt, randomBytes } from 'node:crypto';

import {
  createPow,
  normalizeChallenge,
  buildPowResponse,
  KNOWN_VECTORS,
  ALGORITHM,
} from '../ds-pow.js';
import { issueChallenge, verifyAnswer, ensurePow, pending } from '../server.js';

const WASM_PATH = new URL('../sha3_wasm_bg.wasm', import.meta.url);

/** @type {Awaited<ReturnType<typeof createPow>>} */
let pow;

before(async () => {
  pow = await createPow(await readFile(WASM_PATH));
  await ensurePow(); // the server module's own instance, for issueChallenge
});

// ── The hash primitive ──────────────────────────────────────────────────────

describe('hash', () => {
  test('returns 64 lowercase hex characters', () => {
    const digest = pow.hash('anything');
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test('is deterministic', () => {
    assert.equal(pow.hash('repeatable'), pow.hash('repeatable'));
  });

  test('different inputs give different digests', () => {
    assert.notEqual(pow.hash('a'), pow.hash('b'));
    assert.notEqual(pow.hash('abc'), pow.hash('abc '));
  });

  test('handles the empty string', () => {
    assert.match(pow.hash(''), /^[0-9a-f]{64}$/);
  });

  test('handles non-ASCII without corrupting the length', () => {
    // The ABI passes byte length, not UTF-16 length. A regression here would
    // silently truncate multibyte input, so exercise it explicitly.
    const digest = pow.hash('héllo 🌍 汉字');
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(digest, pow.hash('héllo 🌍 汉'));
  });

  test('rejects non-string input', () => {
    for (const bad of [null, undefined, 1, {}, [], new Uint8Array(1)]) {
      assert.throws(() => pow.hash(bad), TypeError, `hash(${String(bad)}) should throw`);
    }
  });

  test('does not leak: 20k hashes stay in the same memory ballpark', () => {
    // Regression guard for the ownership bug: the returned Vec<u8> is ours to
    // free. Without the free, this grows WASM memory by ~1.4MB.
    for (let i = 0; i < 1_000; i++) pow.hash(`warmup-${i}`);
    const before = pow.wasm.memory.buffer.byteLength;
    for (let i = 0; i < 20_000; i++) pow.hash(`leak-probe-${i}`);
    const growthKiB = (pow.wasm.memory.buffer.byteLength - before) / 1024;
    assert.ok(growthKiB < 256, `memory grew ${growthKiB}KiB over 20k hashes — likely a leak`);
  });
});

// ── Known-good vectors captured from chat.deepseek.com ─────────────────────

describe('known vectors', () => {
  test('both captured challenges reproduce their recorded answers', async () => {
    for (const vector of KNOWN_VECTORS) {
      const answer = await pow.solve(vector);
      assert.equal(answer, vector.answer, `${vector.targetPath}: wrong answer`);
    }
  });

  test('each recorded answer verifies by re-hashing', () => {
    for (const vector of KNOWN_VECTORS) {
      assert.equal(pow.hash(`${vector.salt}_${vector.expireAt}_${vector.answer}`), vector.challenge);
      assert.ok(pow.verify(vector));
    }
  });

  test('selfCheck() resolves against the vendored module', async () => {
    await pow.selfCheck();
  });

  test('a wrong answer does not verify', () => {
    const [vector] = KNOWN_VECTORS;
    const offByOne = { ...vector, answer: vector.answer + 1 };
    assert.equal(pow.verify(offByOne), false);
  });
});

// ── The solver, against challenges minted here ─────────────────────────────

describe('solve', () => {
  /** Mints a solvable challenge the same way the demo server does. */
  function mint(difficulty = 2_000) {
    const salt = randomBytes(10).toString('hex');
    const expireAt = Date.now() + 60_000;
    const nonce = randomInt(0, difficulty);
    return { challenge: pow.hash(`${salt}_${expireAt}_${nonce}`), salt, expireAt, difficulty, nonce };
  }

  test('recovers the nonce the issuer chose', async () => {
    for (const difficulty of [1, 2, 50, 2_000]) {
      const minted = mint(difficulty);
      const answer = await pow.solve(minted);
      assert.equal(answer, minted.nonce, `difficulty ${difficulty}`);
    }
  });

  test('a nonce just below the bound is still reachable', async () => {
    // The search is [0, difficulty): difficulty-1 is the last candidate tried,
    // so this is the exact off-by-one that a `<` vs `<=` mistake would break.
    const difficulty = 1_000;
    const salt = 'boundary-case';
    const expireAt = 1_700_000_000_000;
    const nonce = difficulty - 1;
    const minted = { challenge: pow.hash(`${salt}_${expireAt}_${nonce}`), salt, expireAt, difficulty };
    assert.equal(await pow.solve(minted), nonce);
  });

  test('reports an unsolvable challenge instead of hanging', async () => {
    // The issuer used a nonce outside the advertised range — exactly the case
    // that a status-0 return signals. Must throw, and must say why.
    const salt = 'unsolvable';
    const expireAt = 1_700_000_000_000;
    const nonce = 5_000;
    const challenge = pow.hash(`${salt}_${expireAt}_${nonce}`);
    await assert.rejects(pow.solve({ challenge, salt, expireAt, difficulty: 100 }), /no solution found after/);
  });

  test('rejects malformed parameters', async () => {
    const good = { challenge: 'ab', salt: 'cd', expireAt: 1, difficulty: 10 };
    await assert.rejects(pow.solve({ ...good, challenge: '' }), TypeError);
    await assert.rejects(pow.solve({ ...good, salt: '' }), TypeError);
    await assert.rejects(pow.solve({ ...good, expireAt: NaN }), TypeError);
    await assert.rejects(pow.solve({ ...good, expireAt: undefined }), TypeError);
    await assert.rejects(pow.solve({ ...good, difficulty: 0 }), TypeError);
    await assert.rejects(pow.solve({ ...good, difficulty: -1 }), TypeError);
    await assert.rejects(pow.solve({ ...good, difficulty: NaN }), TypeError);
    assert.throws(() => pow.verify({ ...good, answer: -1 }), TypeError);
    assert.throws(() => pow.verify({ ...good, answer: NaN }), TypeError);
  });

  test('solve() is async and returns a number', async () => {
    const minted = mint(100);
    const pendingSolve = pow.solve(minted);
    assert.ok(pendingSolve instanceof Promise);
    assert.equal(typeof (await pendingSolve), 'number');
  });
});

// ── Challenge normalization / header encoding ──────────────────────────────

describe('normalizeChallenge', () => {
  test('maps snake_case to camelCase', () => {
    const raw = {
      algorithm: ALGORITHM,
      challenge: 'aa',
      salt: 'bb',
      expire_at: 123,
      difficulty: 10,
      target_path: '/api/v0/chat/completion',
    };
    assert.deepEqual(normalizeChallenge(raw), {
      challenge: 'aa',
      salt: 'bb',
      expireAt: 123,
      difficulty: 10,
      targetPath: '/api/v0/chat/completion',
    });
  });

  test('accepts camelCase too', () => {
    const normalized = normalizeChallenge({ challenge: 'aa', salt: 'bb', expireAt: 5, difficulty: 1 });
    assert.equal(normalized.expireAt, 5);
  });

  test('defaults the algorithm when absent, rejects an unknown one', () => {
    assert.doesNotThrow(() => normalizeChallenge({ challenge: 'a', salt: 'b', expire_at: 1, difficulty: 1 }));
    assert.throws(
      () => normalizeChallenge({ algorithm: 'SomethingElse', challenge: 'a', salt: 'b', expire_at: 1, difficulty: 1 }),
      /unsupported PoW algorithm/
    );
  });

  test('rejects a missing expiry and a non-object', () => {
    assert.throws(() => normalizeChallenge({ challenge: 'a', salt: 'b', difficulty: 1 }), TypeError);
    assert.throws(() => normalizeChallenge(null), TypeError);
    assert.throws(() => normalizeChallenge('challenge'), TypeError);
  });

  test('a normalized real challenge solves', async () => {
    const raw = {
      algorithm: ALGORITHM,
      challenge: KNOWN_VECTORS[0].challenge,
      salt: KNOWN_VECTORS[0].salt,
      expire_at: KNOWN_VECTORS[0].expireAt,
      difficulty: KNOWN_VECTORS[0].difficulty,
      target_path: KNOWN_VECTORS[0].targetPath,
    };
    assert.equal(await pow.solveChallenge(raw), KNOWN_VECTORS[0].answer);
    assert.equal(pow.verifyChallenge(raw, KNOWN_VECTORS[0].answer), true);
  });
});

describe('buildPowResponse', () => {
  test('produces base64 of the payload DeepSeek expects', () => {
    const raw = {
      algorithm: ALGORITHM,
      challenge: 'abc',
      salt: 'def',
      expire_at: 42,
      difficulty: 10,
      signature: 'sig-value',
      target_path: '/api/v0/chat/completion',
    };
    const header = buildPowResponse(raw, 7);

    assert.match(header, /^[A-Za-z0-9+/]+={0,2}$/);
    // Decode with the same ASCII/UTF-8 trick the encoder uses.
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(header), (ch) => ch.charCodeAt(0))
    );
    assert.deepEqual(JSON.parse(json), {
      algorithm: ALGORITHM,
      challenge: 'abc',
      salt: 'def',
      answer: 7,
      signature: 'sig-value',
      target_path: '/api/v0/chat/completion',
    });
  });
});

// ── The demo server's issue → verify cycle ─────────────────────────────────

describe('demo server', () => {
  before(async () => {
    await ensurePow();
  });

  test('issues a challenge that solves and verifies, then is spent', async () => {
    const issued = issueChallenge({ difficulty: 3_000 });

    assert.equal(issued.challenge.length, 64);
    assert.equal(issued.salt.length, 20);
    assert.ok(issued.expireAt > Date.now());
    // The answer is deliberately not in the response — only in the pending map.
    assert.equal('nonce' in issued, false, 'issueChallenge must not leak the nonce');
    assert.ok(pending.has(issued.challenge), 'issued challenge should be tracked');

    const answer = await pow.solve(issued);
    assert.equal(answer, pending.get(issued.challenge).nonce, 'the client should recover the issuer nonce');

    const rejectedFirst = verifyAnswer({ challenge: issued.challenge, answer: answer + 1 });
    assert.equal(rejectedFirst.ok, false);
    assert.equal(rejectedFirst.reason, 'wrong-answer');

    const accepted = verifyAnswer({ challenge: issued.challenge, answer });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.answerMatchesIssuedNonce, true);

    // Single-use: the same answer must not work twice.
    const replayed = verifyAnswer({ challenge: issued.challenge, answer });
    assert.equal(replayed.ok, false);
    assert.equal(replayed.reason, 'unknown-or-already-used-challenge');
  });

  test('rejects a challenge it never issued', () => {
    const result = verifyAnswer({ challenge: 'f'.repeat(64), answer: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown-or-already-used-challenge');
  });

  test('every issued challenge is solvable within its advertised bound', async () => {
    // The issuer draws its nonce from [0, difficulty) and the solver searches
    // exactly that range, so this must hold for any draw. Five rounds at a
    // small difficulty is cheap and would catch an off-by-one at the bound.
    for (let i = 0; i < 5; i++) {
      const issued = issueChallenge({ difficulty: 500 });
      const answer = await pow.solve(issued);
      assert.ok(answer >= 0 && answer < issued.difficulty);
      assert.equal(pow.verify({ ...issued, answer }), true);
    }
  });
});

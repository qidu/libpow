/**
 * app.js — the browser half of the demo.
 *
 * Imports the same `ds-pow.js` that Node imports, with no bundler, no build
 * step, and no Node compatibility shim. That is the point of the library's
 * layout: the file has no Node built-ins, so the browser can take it verbatim.
 */

import { createPow, KNOWN_VECTORS } from '/ds-pow.js';

const $ = (id) => document.getElementById(id);

const ui = {
  moduleStatus: $('module-status'),
  selfcheckBtn: $('btn-selfcheck'),
  selfcheckHint: $('selfcheck-hint'),
  difficulty: $('difficulty'),
  challengeBtn: $('btn-challenge'),
  solveBtn: $('btn-solve'),
  verifyBtn: $('btn-verify'),
  challengeJson: $('challenge-json'),
  verifyJson: $('verify-json'),
  cChallenge: $('c-challenge'),
  cSalt: $('c-salt'),
  cExpiry: $('c-expiry'),
  sAnswer: $('s-answer'),
  sTime: $('s-time'),
  sRate: $('s-rate'),
  verdict: $('verdict'),
};

/** Current state: the loaded library, the challenge, and the answer we computed. */
let pow = null;
let challenge = null;
let answer = null;

function setVerdict(text, ok) {
  ui.verdict.textContent = text;
  ui.verdict.className = `verdict ${ok ? 'ok' : 'bad'}`;
}

function clearVerdict() {
  ui.verdict.className = 'verdict';
  ui.verdict.textContent = '';
}

function formatMs(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

// ── 1. Load the WASM ────────────────────────────────────────────────────────

try {
  const started = performance.now();
  // A URL: the library streams it, so compilation overlaps the download. The
  // server sends `application/wasm`, which is what instantiateStreaming wants.
  pow = await createPow('/sha3_wasm_bg.wasm');
  const elapsed = performance.now() - started;

  ui.moduleStatus.textContent = `ready — compiled and instantiated in ${formatMs(elapsed)}`;
  ui.moduleStatus.style.color = 'var(--ok)';
  ui.selfcheckBtn.disabled = false;
  ui.challengeBtn.disabled = false;

  // Sanity-check the hash primitive against a value we can reason about: the
  // hash is deterministic, so hashing the same string twice must agree.
  const probe = pow.hash('hello');
  ui.selfcheckHint.textContent = `hash("hello") = ${probe.slice(0, 16)}… (${probe.length} hex chars)`;
} catch (err) {
  ui.moduleStatus.textContent = `failed — ${err.message}`;
  ui.moduleStatus.style.color = 'var(--bad)';
  throw err;
}

// ── 2. Known-answer self-check ──────────────────────────────────────────────

ui.selfcheckBtn.addEventListener('click', async () => {
  ui.selfcheckBtn.disabled = true;
  ui.selfcheckHint.textContent = 'solving two captured DeepSeek challenges…';
  try {
    const started = performance.now();
    await pow.selfCheck(); // throws if either vector does not reproduce its answer
    const elapsed = performance.now() - started;
    ui.selfcheckHint.textContent =
      `✓ ${KNOWN_VECTORS.length} vectors reproduced exactly (answers ` +
      `${KNOWN_VECTORS.map((v) => v.answer).join(', ')}) in ${formatMs(elapsed)}`;
    ui.selfcheckHint.style.color = 'var(--ok)';
  } catch (err) {
    ui.selfcheckHint.textContent = `✗ ${err.message}`;
    ui.selfcheckHint.style.color = 'var(--bad)';
  } finally {
    ui.selfcheckBtn.disabled = false;
  }
});

// ── 3. Fetch a challenge ────────────────────────────────────────────────────

ui.challengeBtn.addEventListener('click', async () => {
  ui.challengeBtn.disabled = true;
  ui.solveBtn.disabled = true;
  ui.verifyBtn.disabled = true;
  answer = null;
  clearVerdict();
  ui.sAnswer.textContent = '—';
  ui.sTime.textContent = '—';
  ui.sRate.textContent = '—';
  ui.verifyJson.textContent = '';

  try {
    const difficulty = Number(ui.difficulty.value) || 144000;
    const response = await fetch(`/api/challenge?difficulty=${encodeURIComponent(difficulty)}`);
    challenge = await response.json();
    if (!response.ok) throw new Error(challenge.error ?? `HTTP ${response.status}`);

    ui.cChallenge.textContent = challenge.challenge;
    ui.cSalt.textContent = challenge.salt;
    const seconds = Math.round((challenge.expire_at - Date.now()) / 1000);
    ui.cExpiry.textContent = new Date(challenge.expire_at).toLocaleTimeString() + ` (${seconds}s from now)`;
    ui.challengeJson.textContent = JSON.stringify(challenge, null, 2);
    ui.solveBtn.disabled = false;
  } catch (err) {
    ui.cChallenge.textContent = `error: ${err.message}`;
  } finally {
    ui.challengeBtn.disabled = false;
  }
});

// ── 4. Solve, in this tab ───────────────────────────────────────────────────

ui.solveBtn.addEventListener('click', async () => {
  if (!challenge) return;
  ui.solveBtn.disabled = true;
  ui.solveBtn.textContent = 'solving…';
  clearVerdict();

  try {
    // Yield a frame first so the button's "solving…" state paints before the
    // solve blocks the main thread. At difficulty 144000 this takes ~20ms and
    // is imperceptible; at 5,000,000 it is ~1s of a frozen tab, which is
    // exactly why the notes in README.md suggest moving this to a Worker.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    const started = performance.now();
    // normalizeChallenge maps the server's snake_case `expire_at` to expireAt.
    answer = await pow.solveChallenge(challenge);
    const elapsed = performance.now() - started;

    ui.sAnswer.textContent = String(answer);
    ui.sTime.textContent = formatMs(elapsed);
    // The search is sequential from 0, so exactly answer+1 candidates were hashed.
    const rate = elapsed > 0 ? (answer + 1) / elapsed : 0;
    ui.sRate.textContent = `${Math.round(rate).toLocaleString()} candidates/s (${answer + 1} hashed)`;

    // Verify locally too: one hash, no network. If this is false something is
    // badly wrong with the module, and the server would say the same.
    const locally = pow.verifyChallenge(challenge, answer);
    setVerdict(locally ? '✓ answer verifies locally — send it to the server' : '✗ local verification failed', locally);
    ui.verifyBtn.disabled = !locally;
  } catch (err) {
    setVerdict(`✗ ${err.message}`, false);
  } finally {
    ui.solveBtn.disabled = false;
    ui.solveBtn.textContent = 'Solve in this tab';
  }
});

// ── 5. Verify against the server ────────────────────────────────────────────

ui.verifyBtn.addEventListener('click', async () => {
  if (!challenge || answer === null) return;
  ui.verifyBtn.disabled = true;
  clearVerdict();

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: challenge.challenge, answer }),
    });
    const result = await response.json();
    ui.verifyJson.textContent = JSON.stringify(result, null, 2);

    if (result.ok) {
      setVerdict(`✓ server accepted the answer in ${formatMs(result.verifyMs)} — challenge is now spent`, true);
    } else {
      setVerdict(`✗ server rejected: ${result.reason}`, false);
    }
  } catch (err) {
    setVerdict(`✗ request failed: ${err.message}`, false);
  } finally {
    ui.verifyBtn.disabled = false;
  }
});

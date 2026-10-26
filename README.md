# libpow — DeepSeekHashV1 proof-of-work for the browser and Node

A standalone JavaScript library for the proof-of-work that `chat.deepseek.com` puts in front of
its `chat/completion` and `file/upload_file` endpoints, plus a demo server that issues and
verifies real challenges so you can watch the whole cycle in one tab.

**In one sentence:** the server picks a random number in `[0, difficulty)` — the nonce — appends
it to a known prefix (`salt_expireAt_`) and hashes the result, sending the client that hash but not
the nonce, so the client has to try numbers in that range one at a time, hashing each candidate,
until one of them reproduces the hash it was given.

It has **no Node built-ins at all** — no `node:fs`, no `import.meta.url`, no `Buffer` — so the
browser can load the same file verbatim, with no bundler and no build step.

```
libpow/
  ds-pow.js                 the library (browser + Worker + Node, zero dependencies)
  sha3_wasm_bg.wasm          the vendored DeepSeek module (26,612 bytes, zero imports)
  server.js                  demo server: issues challenges, verifies answers
  public/index.html          the demo page
  public/app.js              the page's module: imports ds-pow.js directly
  test/ds-pow.test.js        node --test suite (25 tests)
```

## Quick start

```bash
cd libpow
node server.js          # http://127.0.0.1:8787
```

Open the page, then: run the known-answer self-check, fetch a challenge, solve it in the tab,
and send the answer back for verification. The server logs nothing per request — the page shows
the solve time, the hash rate, and the server's verdict.

```bash
node --test             # 25 tests, no network, ~150ms
```

## Using the library

### In a browser page

```html
<script type="module">
  import { createPow } from './ds-pow.js';

  const pow = await createPow('./sha3_wasm_bg.wasm');   // URL → fetch → instantiateStreaming

  // A challenge object as the DeepSeek API returns it:
  //   { algorithm, challenge, salt, expire_at, difficulty, signature, target_path }
  const answer = await pow.solveChallenge(challenge);
  console.log(answer);                                  // the nonce, < difficulty
</script>
```

`createPow()` takes the module source in whatever shape you have it:

| Argument | When to use it |
| --- | --- |
| `string` / `URL` | a browser page: `'./sha3_wasm_bg.wasm'` — streamed and compiled while downloading |
| `Response` | you fetched it yourself, or got it from a service worker / cache API |
| `ArrayBuffer` / `Uint8Array` | Node, or bytes you already have in memory |
| `WebAssembly.Module` | you compiled it once and share it (a `Module` is reusable across `Instance`s) |
| `Promise` of any of the above | an in-flight fetch, so loading and wiring stay in one step |

The URL form needs the response labelled `application/wasm` to stream; if the server sends
`application/octet-stream` the library silently buffers and compiles instead, which works but
starts compiling only after the download finishes. `server.js` gets this right.

### In Node

`fetch()` cannot read a filesystem path, so pass bytes:

```js
import { readFile } from 'node:fs/promises';
import { createPow } from './ds-pow.js';

const pow = await createPow(await readFile(new URL('./sha3_wasm_bg.wasm', import.meta.url)));
const answer = await pow.solve({ challenge, salt, expireAt, difficulty });
```

Node 18+ is enough: `fetch`, `btoa`, and `node --test` are all it needs. There are no
dependencies, and nothing to install.

### In a Web Worker

No changes are needed — the library uses no DOM APIs. The reason to bother is not correctness
but responsiveness: `solve()` blocks whatever thread it runs on. At DeepSeek's `difficulty`
(144,000) that is ~14ms on average and ~27ms in the worst case, which nobody will notice. At
5,000,000 it is ~0.5s average and ~1.0s worst case of a frozen page, which is why the challenge
demo lets you raise the difficulty and feel it.

```js
// worker.js
import { createPow } from './ds-pow.js';
const pow = await createPow('./sha3_wasm_bg.wasm');
onmessage = async ({ data }) => postMessage(await pow.solveChallenge(data));
```

## API

```js
const pow = await createPow(source);
```

| Member | Signature | Notes |
| --- | --- | --- |
| `pow.hash` | `(message: string) => string` | 64 lowercase hex chars. Synchronous — a single hash call. |
| `pow.solve` | `async ({challenge, salt, expireAt, difficulty}) => number` | Searches nonces in `[0, difficulty)`. Async so callers don't change if you later move it to a Worker. |
| `pow.verify` | `({challenge, salt, expireAt, answer}) => boolean` | One hash: `hash(prefix + answer) === challenge`. No `difficulty` needed. |
| `pow.solveChallenge` | `async (rawChallenge) => number` | Takes DeepSeek's snake_case shape, including `algorithm`. |
| `pow.verifyChallenge` | `(rawChallenge, answer) => boolean` | Same, for the raw shape. |
| `pow.selfCheck` | `async () => void` | Solves both captured vectors and compares. ~40ms. Throws on mismatch. |
| `pow.wasm` | `{instance, exports, memory}` | Escape hatch for calling the module directly. |

Also exported: `ALGORITHM` (`'DeepSeekHashV1'`), `KNOWN_VECTORS`, `normalizeChallenge(raw)`
(snake_case → the camelCase shape `solve`/`verify` take), and `buildPowResponse(challenge,
answer)` (the base64 `x-ds-pow-response` header DeepSeek expects).

`solve()` throws if the search space is exhausted, and `verify()` throws on malformed input
rather than returning `false` — a `TypeError` for a programming mistake, `false` for a wrong
answer.

## The protocol, and why the server half is the interesting half

The algorithm is an **exact-match search**, not a leading-zero-bits puzzle:

```
prefix = `${salt}_${expireAt}_`
solve(challenge, prefix, difficulty):
  for nonce in 0, 1, 2, ... < difficulty:
    if deepseek_hash_v1(prefix + nonce) === challenge:
      return nonce
```

Which means the issuer mints a challenge by choosing the answer *first*:

```js
const salt = randomBytes(10).toString('hex');
const expireAt = Date.now() + 60_000;
const nonce = randomInt(0, difficulty);          // ← the answer, picked up front
const challenge = pow.hash(`${salt}_${expireAt}_${nonce}`);   // ← what the client gets
```

The client then recovers `nonce` by searching, and the server confirms it in a single hash.
That is the whole design: the work is only verifiable if the issuer knew the answer when it
issued the challenge. `server.js` shows both halves, including the two things a real issuer
must not skip:

1. **Track what you issued.** The server keeps a `Map` keyed by challenge, so a correct answer
   for a challenge it never handed out is rejected. Re-hashing alone would accept that.
2. **Expire and spend.** Each challenge is valid for 60s and is deleted on success, so one
   solved answer cannot be replayed. The test suite asserts the replay is rejected.

## `difficulty` is the nonce search-space bound

This was measured against the vendored binary, not inferred from the name:

```
secret nonce 98797:  difficulty= 98797 → status 0 (not found)
                     difficulty= 98798 → status 1, answer 98797
secret nonce   999:  difficulty=  1000 → status 1, answer 999
                     difficulty=   999 → status 0
```

So `wasm_solve` scans `nonce ∈ [0, difficulty)` and returns `status = 0` when it finds nothing.
Two consequences:

- **A challenge is only solvable if the issuer's nonce is below the `difficulty` it advertises.**
  Both captured DeepSeek vectors satisfy this (answers 98,797 and 61,041 against 144,000), and
  `server.js`/the tests draw their nonce from `[0, difficulty)` so every minted challenge is
  reachable. Drawing the nonce outside that range is the one bug that produces challenges no
  client can ever solve — and it is exactly what the `status 0` error message points at.
- **Cost is bounded and predictable**, because the search is linear in `difficulty` — see
  [Measured cost](#measured-cost) below.

`status 0` carries a meaningless `answer` (it is `0`), so the library throws rather than
returning it.

### What the client does with that promise: brute force

The issuer's response is really two things: a **promise** ("the nonce I used is somewhere in
`0 … difficulty-1`") and a **puzzle** ("work out which one").

There is no shortcut on the puzzle. `challenge` is `hash(prefix + nonce)`, and recovering
`nonce` from it would mean inverting the hash — the exact thing a hash is built to prevent. So
the only method is to hash candidates and compare, one integer at a time:

```js
for (let nonce = 0; nonce < difficulty; nonce++) {
  if (hash(prefix + nonce) === challenge) return nonce;   // one hash, one string comparison
}
```

Nothing cleverer exists and nothing cleverer is coming: the digest looks like noise for every
input, so a candidate can only be checked, not deduced.

Because the issuer draws its nonce uniformly from the range, the match is equally likely to be
anywhere in it. So on average you meet it halfway, and in the worst case you walk the entire
range:

```
average  ~difficulty/2 hashes
worst    difficulty hashes
```

The order makes no difference — ascending (what `wasm_solve` does) and random cost the same. A
random starting point would only defeat someone precomputing the low end of the range.

**That cost is the entire point.** The issuer pays one hash to mint a challenge (it picked the
nonce first, then hashed it once) and one hash to verify an answer, while the client pays up to
`difficulty`:

| | hashes computed |
| --- | --- |
| server minting a challenge | 1 |
| server verifying an answer | 1 |
| client solving it | ~difficulty/2 average, `difficulty` worst case |

At DeepSeek's difficulty that is about one frame of animation on average and ~27ms at worst —
invisible to a person — but a script has to pay it on *every* request, which is the cost floor
DeepSeek is buying. It is a speed bump, not a security barrier: it prices abuse rather than
preventing it.

And this is why the promise has to be true. Nothing *stops* a client from searching past
`difficulty` — the bound is a loop bound inside `wasm_solve`, not a rule of the protocol, and the
server never checks `answer < difficulty` when verifying. But a client has no way to know how
much further to look: one more nonce? A thousand? A million? Every step costs another hash and
there is still no signal until one matches. **The advertised bound is the only thing that tells
the search when to stop.** So an issuer that draws its nonce outside the range does not make its
challenge unsolvable in principle — it makes it unfindable within the agreed budget, which from
the client's side is indistinguishable from impossible.

### Measured cost

Measured on this machine — Apple M6, Mac18,5 (12 cores), Node v22.23.3, arm64 — solving
challenges minted by this library's own server. *Average* is the mean of repeated solves with a
uniformly random nonce, which lands halfway on average (200 draws up to difficulty 500,000, 40
above that). *Worst* pins the nonce at `difficulty - 1` so the scan runs the entire range; it is
the max of 5 runs, and unlike the average it repeats almost identically every time:

| difficulty | hashes (avg) | time (avg) | hashes (worst) | time (worst) | i7 estimate (worst) |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 5,000 | 1.2ms | 10,000 | 1.9ms | 1.9 – 3.8ms |
| **144,000** (DeepSeek's) | 72,000 | **14.2ms** | 144,000 | **27.1ms** | **27 – 54ms** |
| 500,000 | 250,000 | 47.9ms | 500,000 | 93.7ms | 94 – 187ms |
| 1,000,000 | 500,000 | 91.9ms | 1,000,000 | 187.7ms | 0.19 – 0.38s |
| 1,500,000 | 750,000 | 149ms | 1,500,000 | 282ms | 0.28 – 0.56s |
| 2,000,000 | 1,000,000 | 187ms | 2,000,000 | 377ms | 0.38 – 0.75s |
| 3,000,000 | 1,500,000 | 287ms | 3,000,000 | 568ms | 0.57 – 1.14s |
| 4,000,000 | 2,000,000 | 383ms | 4,000,000 | 759ms | 0.76 – 1.52s |
| 5,000,000 (demo cap) | 2,500,000 | 510ms | 5,000,000 | 968ms | 0.97 – 1.94s |

One caveat, and it is the only one: the **average** column is intrinsically noisy, because a
single solve can land anywhere in the range. At difficulty 10,000 the 200 draws spanned 0.0ms to
4.1ms, so its mean (1.2ms) sits visibly above the `difficulty/2 ÷ rate` prediction (0.94ms) even
though the larger rows track the model within a few percent. The **worst** column has none of
that ambiguity.

**The i7 column is an extrapolation, not a measurement.** The worst-case column implies a flat
**~5.2–5.3M candidates/s** (0.19µs each) from 10,000 all the way to 5,000,000 — the cost tracks
`difficulty` with no visible curve — so anyone can re-derive it for their own hardware:

```
time ≈ candidates / rate
```

The estimate assumes a desktop-class i7 delivers 0.5×–1.0× this machine's single-thread WASM
throughput, giving 2.7M–5.3M candidates/s; a slower laptop i7 lands at or below the low end.
Measure your own rather than trusting the column: the benchmark is about a dozen lines over
`pow.solve()`, and the two boundary probes that establish the `[0, difficulty)` rule are
`a nonce just below the bound is still reachable` and `every issued challenge is solvable within
its advertised bound` in `test/ds-pow.test.js`.

## Memory ownership — the two rules that make this work

The vendored module is wasm-bindgen output with its glue JS stripped away, so this library
implements the ABI directly. Two conventions are load-bearing, both established by experiment:

- **The WASM owns the string arguments you pass in.** It frees them itself. Freeing them from
  JS is a double-free, and the *next* `wasm_solve` traps with `RuntimeError: unreachable`.
- **The caller owns the `Vec<u8>` that `wasm_deepseek_hash_v1` returns.** Nothing frees it at
  this level, so `hash()` releases it with `__wbindgen_free(ptr, len, 1)`. Without that, every
  hash leaks ~72 bytes and 20k calls grow WASM memory by ~1.4MB.

Both are covered by regression tests: 20,000 hashes must not grow memory by 256KiB, and the
suite would trap immediately if the input-freeing rule were reintroduced.

## The vendored WASM

`sha3_wasm_bg.wasm` is byte-identical to the module a browser fetches from
`https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm` (captured 2026-09-09):

```
26,612 bytes
sha256 b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d
```

It has **zero WASM imports**, which is why it runs unmodified in a page, a Worker and Node
alike — there is nothing for a host to supply.

It is also the one part of this that can break without warning: DeepSeek can rotate the module
at any time, and a new build may rename or re-sign its exports. `createPow()` validates the six
exports it needs at load and says so plainly if one is missing, and `selfCheck()` fails loudly
if the module still loads but computes different hashes. Running `selfCheck()` at startup (as
`server.js` does) turns "mysterious bad answers" into "refuses to start".

## Limitations

This is a demo of the protocol, not a production service.

- **Challenges live in process memory.** A restart loses them, and it cannot be scaled past one
  process without a shared store.
- **No authentication, no rate limiting.** `/api/challenge` mints challenges for anyone.
- **No CSRF or origin checks.** Fine for `127.0.0.1`, not for a public host. `HOST` defaults to
  `127.0.0.1` for that reason.
- **The PoW is not a security boundary by itself.** The search is linear in `difficulty` and costs
  a few dozen milliseconds at DeepSeek's — a speed bump for scripted abuse, not a defence against
  a determined client, which can simply call the same wasm. Treat it the way DeepSeek does: as a
  cheap cost floor.
- **`verify()` ignores expiry.** It is a hash comparison. Whether a challenge is still valid is a
  policy decision, and `server.js` makes it separately.

## Design notes

- `createPow(source)` takes the WASM as bytes, an `ArrayBuffer`, a `Response`, a promise for any
  of those, or a URL to fetch — so the caller decides where the bytes come from. That is the one
  thing that makes the same file work in a page, a Worker and Node alike.
- The load helpers use only `fetch` / `Response` / `WebAssembly`, and `import.meta.url` appears
  nowhere in the library: it is emptied by `esbuild --format=cjs`, which silently breaks
  URL-based loading in a bundle.
- `solve()` reports how long an exhausted search took, and its error explains the
  `[0, difficulty)` bound instead of just saying "no solution".
- Inputs are validated with messages that name the offending parameter, and `verify()` does not
  demand `difficulty`, since it never needs it.
- `normalizeChallenge()`, `solveChallenge()`, `verifyChallenge()` and `buildPowResponse()` save a
  caller holding the raw API object from reshaping it by hand.

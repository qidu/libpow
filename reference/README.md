# Reference: writing your own `ds-pow` engine

The library in `../ds-pow.js` talks to the WASM module through six exported names and nothing else.
Nothing in that contract mentions wasm-bindgen, DeepSeek, or Rust — an engine is simply any module
exporting those names. This directory holds the details that follow from that:

- **[`engine-skeleton/`](engine-skeleton/)** — a Rust crate that compiles to a drop-in engine. It is
  not a sketch: it was built and driven through `createPow()` end to end, covering `hash()`,
  `solve()`, `verify()` and the exhausted-search path.
- The rest of this file — the ABI in full, the two ownership rules, the build and verification
  recipe, and how to register a second algorithm.

The top-level [`../README.md`](../README.md) covers the library itself and the protocol. Read this
only if you are replacing or adding an engine.

## The ABI in full

| export | signature | used for |
| --- | --- | --- |
| `memory` | `WebAssembly.Memory` | every pointer below indexes it |
| `__wbindgen_export_0` | `(size, align) -> *mut u8` | allocating the string arguments |
| `__wbindgen_export_2` | `(ptr, size, align)` | freeing the hash result |
| `__wbindgen_add_to_stack_pointer` | `(delta: i32) -> i32` | carving the 16-byte `retptr` area; returns the address *after* applying `delta` |
| `wasm_deepseek_hash_v1` | `(retptr, msgPtr, msgLen)` | writes `{u32 ptr, u32 len}` at `retptr` |
| `wasm_solve` | `(retptr, chPtr, chLen, prePtr, preLen, difficulty: f64)` | writes `status: i32` at `retptr` and `answer: f64` at `retptr + 8` |

`bind()` in `../ds-pow.js` validates all six at load time and names the missing one if it is absent.

Three rules decide whether that works or traps:

- **Your function owns the string arguments.** JS allocates them, the callee frees them. That
  asymmetry is wasm-bindgen's, and it is why freeing them from JS is a double-free that traps the
  *next* call rather than the current one.
- **The caller owns the bytes you return** from the hash. Hand back a `Vec<u8>`, or `alloc` + copy,
  and let JS release it via `__wbindgen_export_2(ptr, len, 1)`.
- **`retptr` is 16 bytes and the `f64` sits at `+8`, not `+4`.** It is 8-byte aligned, so the return
  slot is `{ i32 status; i32 _pad; f64 answer; }`. The area also has to stay addressable until JS has
  read it, which is why it cannot simply be a stack local in your function — hence
  `__wbindgen_add_to_stack_pointer` and a scratch region behind it.

`difficulty` arrives as an `f64` and `answer` leaves as one, though both are integers. `status` is
`1` when a nonce was found and `0` when the whole `[0, difficulty)` range was exhausted — `0` is a
failure, not an answer of zero.

## Building the skeleton

You do not need the bindgen toolchain. Exporting the six names by hand is shorter than wiring it up,
and it keeps the zero-import property that lets one module run in a page, a Worker and Node alike.
The `Cargo.toml` in `engine-skeleton/` is only:

```toml
[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

```sh
rustup target add wasm32-unknown-unknown
cd engine-skeleton
cargo build --release --target wasm32-unknown-unknown
```

On rustc 1.99 that yields a ~19KB module with **no imports** and `memory` already exported, with no
linker flags. Check both properties before shipping it:

```sh
node -e 'const fs=require("fs"), m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
console.log(WebAssembly.Module.imports(m), WebAssembly.Module.exports(m))' \
  engine-skeleton/target/wasm32-unknown-unknown/release/ds_pow_engine.wasm
```

The first array must print `[]`, and the second must name all six exports.

If you keep `wasm-bindgen` instead, watch the imports: `wasm_bindgen(start)`, closures, `js_sys`,
`web_sys` and `console_error_panic_hook` all add host functions, and a module with imports needs glue
that a page, a Worker and Node each have to supply differently. Exporting
`#[no_mangle] pub extern "C"` functions sidesteps that class of problem entirely.

## Registering a second algorithm

The six exports give you a *replacement* engine. A *second* algorithm also needs something that
chooses between them, because right now both the export names and `ALGORITHM` are literals in
`../ds-pow.js`. The seams are small: `ALGORITHM` is what `normalizeChallenge()` accepts and what
`buildPowResponse()` echoes back, and `REQUIRED_EXPORTS` plus `bind()` assume a single pair of entry
points. A table and a parameter, about twenty lines:

```js
const ENGINES = {
  DeepSeekHashV1: { hash: 'wasm_deepseek_hash_v1', solve: 'wasm_solve', vectors: KNOWN_VECTORS },
  MyHashV2:       { hash: 'wasm_my_hash_v2',       solve: 'wasm_solve', vectors: MY_VECTORS },
};

async function createPow(source, { algorithm = ALGORITHM } = {}) {
  const engine = ENGINES[algorithm];
  if (!engine) throw new Error(`ds-pow: no engine registered for "${algorithm}"`);
  const { hash, solveRaw, memory } = bind(await instantiateFrom(source), engine);
  // …and `algorithm` replaces the constant in pow.algorithm / buildPowResponse.
}
```

`../ds-pow.js` ships the one engine; the table above is the shape to grow into, not something that
is already there.

Whichever way you register it, **your own vectors have to come with it.** `KNOWN_VECTORS` is a
record of DeepSeek's build, so `selfCheck()` against a new engine fails by design — verified, it
reports `self-check failed … may implement a different algorithm than these vectors were captured
with`. Capture two challenges from your own issuer and the nonces it accepted; that is what makes the
same `selfCheck()` meaningful for a rotated or replaced module.

## One warning about the algorithm itself

If you are targeting `chat.deepseek.com` and its algorithm changes, a new engine will not help you
guess it. `DeepSeekHashV1` is not standard SHA3-256 — hashing `salt_expireAt_nonce` with Node's own
`sha3-256` does not reproduce either recorded challenge — and there is no public spec for the
variant. That part has to come out of their binary, validated against vectors you capture.
Everything above only makes the result a drop-in engine.

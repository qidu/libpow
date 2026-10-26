//! A `ds-pow` engine built WITHOUT wasm-bindgen.
//!
//! Exports exactly the six names `bind()` in ../ds-pow.js requires, with no
//! imports, so it loads in a page, a Worker and Node alike. See
//! ../README.md for the ABI, the ownership rules and the build recipe.
//!
//! ─────────────────────────────────────────────────────────────────────────
//! `digest32` below is a STAND-IN, not DeepSeekHashV1. It exists so this
//! crate builds into something you can actually load and exercise — the ABI
//! plumbing around it is the part being demonstrated. It will never solve a
//! real challenge, and `selfCheck()` against it fails by design.
//!
//! Replace `digest32`/`hex32` with your issuer's hash, and capture two of its
//! challenges plus the nonces it accepted as your own `KNOWN_VECTORS`.
//! ─────────────────────────────────────────────────────────────────────────

use std::alloc::{alloc, dealloc, Layout};

fn layout_for(size: usize, align: usize) -> Layout {
    Layout::from_size_align(size.max(1), align.max(1)).expect("bad layout")
}

// ── the allocator half of the ABI ───────────────────────────────────────────

#[no_mangle]
pub extern "C" fn __wbindgen_export_0(size: usize, align: usize) -> *mut u8 {
    unsafe { alloc(layout_for(size, align)) }
}

#[no_mangle]
pub extern "C" fn __wbindgen_export_2(ptr: *mut u8, size: usize, align: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe { dealloc(ptr, layout_for(size, align)) }
}

// ── the retptr half of the ABI ──────────────────────────────────────────────
// JS carves scratch space with `addToStackPointer(-16)` and uses the RETURN
// value as the retptr, so this returns the post-delta address.

const SCRATCH_LEN: usize = 4096;
static mut SCRATCH: [u8; SCRATCH_LEN] = [0; SCRATCH_LEN];
static mut SCRATCH_SP: usize = SCRATCH_LEN;

#[no_mangle]
pub extern "C" fn __wbindgen_add_to_stack_pointer(delta: i32) -> i32 {
    unsafe {
        let sp = std::ptr::addr_of_mut!(SCRATCH_SP);
        let base = std::ptr::addr_of_mut!(SCRATCH) as usize;
        let next = (*sp as isize + delta as isize).clamp(0, SCRATCH_LEN as isize);
        *sp = next as usize;
        (base + *sp) as i32
    }
}

// ── the algorithm ───────────────────────────────────────────────────────────

/// Stand-in for the real hash. 32 bytes, lowercased to hex on the way out.
/// Deterministic and input-sensitive, which is all the ABI needs.
fn digest32(msg: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ (i as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        for &b in msg {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
            h ^= h >> 29;
        }
        *slot = (h ^ (h >> 32)) as u8;
    }
    out
}

fn hex32(digest: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, byte) in digest.iter().enumerate() {
        out[i * 2] = HEX[(byte >> 4) as usize];
        out[i * 2 + 1] = HEX[(byte & 0x0f) as usize];
    }
    out
}

/// The digest as 64 lowercase hex bytes — no NUL, no terminator.
fn hash_hex(msg: &[u8]) -> [u8; 64] {
    hex32(&digest32(msg))
}

// ── the two real entry points ───────────────────────────────────────────────

/// Allocates the hex digest on the wasm heap and hands the pointer to JS.
/// The CALLER (ds-pow's bind()) frees it via `__wbindgen_export_2(ptr, 64, 1)`,
/// which is the opposite of the arguments' ownership.
fn emit_hex(retptr: *mut i32, msg: &[u8]) {
    let hex = hash_hex(msg);
    let len = hex.len();
    let ptr = unsafe { alloc(layout_for(len, 1)) };
    unsafe {
        std::ptr::copy_nonoverlapping(hex.as_ptr(), ptr, len);
        *retptr = ptr as i32;        // ptr
        *retptr.add(1) = len as i32; // len
    }
}

/// `wasm_deepseek_hash_v1(retptr, msgPtr, msgLen)` — write `{ptr, len}` at retptr.
#[no_mangle]
pub extern "C" fn wasm_deepseek_hash_v1(retptr: *mut i32, msg_ptr: *const u8, msg_len: usize) {
    let msg = unsafe { std::slice::from_raw_parts(msg_ptr, msg_len) };
    emit_hex(retptr, msg);
    // String arguments are owned by the callee: JS allocated them with
    // __wbindgen_export_0 and will never free them itself.
    unsafe { dealloc(msg_ptr as *mut u8, layout_for(msg_len, 1)) };
}

/// `wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)`
/// — write `status: i32` at retptr and `answer: f64` at retptr + 8 (the f64 is
/// 8-byte aligned, hence the 4-byte hole).
#[no_mangle]
pub extern "C" fn wasm_solve(
    retptr: *mut i32,
    challenge_ptr: *const u8,
    challenge_len: usize,
    prefix_ptr: *const u8,
    prefix_len: usize,
    difficulty: f64,
) {
    let challenge = unsafe { std::slice::from_raw_parts(challenge_ptr, challenge_len) };
    let prefix = unsafe { std::slice::from_raw_parts(prefix_ptr, prefix_len) };

    let (status, answer) = search(challenge, prefix, difficulty);

    unsafe {
        dealloc(challenge_ptr as *mut u8, layout_for(challenge_len, 1));
        dealloc(prefix_ptr as *mut u8, layout_for(prefix_len, 1));
        *retptr = status;
        std::ptr::write_unaligned((retptr as *mut u8).add(8) as *mut f64, answer);
    }
}

/// `difficulty` is the exclusive upper bound of the search, so the range is
/// `[0, difficulty)` — the same contract the JS `solve()` honours.
fn search(challenge: &[u8], prefix: &[u8], difficulty: f64) -> (i32, f64) {
    if !difficulty.is_finite() || difficulty <= 0.0 {
        return (0, 0.0);
    }
    let bound = difficulty as u64;
    let mut buf = Vec::with_capacity(prefix.len() + 20);
    let mut digits = [0u8; 20];
    for nonce in 0..bound {
        buf.clear();
        buf.extend_from_slice(prefix);
        buf.extend_from_slice(itoa(nonce, &mut digits));
        if hash_hex(&buf) == challenge {
            return (1, nonce as f64);
        }
    }
    // Search space exhausted: 0 is a failure, not an answer of zero.
    (0, 0.0)
}

fn itoa(mut value: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    &buf[i..]
}

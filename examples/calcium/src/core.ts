/**
 * Calcium — spreadsheet calculation engine.
 * Concept & measured rules: docs/plans/2026-11-16-calcium-calc-engine.md
 *   R1 no objects — SoA arenas · R2 cell store always f64 · R3 coarse bytes
 *   boundary · R4 arena pooling · R5 if-chain dispatch · M0: 21 numeric/
 *   logical functions, A1 refs, ranges, full recalc with memo + cycle flags.
 *
 * scriptc subset discipline: no classes/objects, no strings inside the engine
 * (input is UTF-8 bytes), no Math.* (myFloor/intPow/newtonSqrt below), plain
 * while-loops, if-chains instead of switch, no Infinity literal (errors are
 * detected as |v| > 100000000000000000000000000000000000000, which only Inf can exceed).
 */

// ---------- workbook state (module-level; one wasm instance = one book) ------
let NROWS = 0;
let NCOLS = 0;
let NCELLS = 0;

// R7: EVERY store is f64 — scriptc converts u8/i32 array loads to f64 on
// every access (one uitofp each); f64 arrays load conversion-free. Indices
// and flags ride f64 exactly (≤ 2^53).
let vals = new Float64Array(0);     // R2: values always f64
let kinds = new Uint8Array(0);      // 0 empty · 1 number · 2 formula · 3 error cell (u8: scanned hot)
let astRoot = new Float64Array(0);  // formula AST root node, -1 none
let computed = new Uint8Array(0);   // formula value valid this pass (u8: scanned hot)
let visiting = new Uint8Array(0);   // cycle detection (u8: 0/1)

// ---------- dependency graph (M1; SoA lists, grown at set-time only) --------
// Forward list of cell c = cells c reads (N_REF cells + every cell a N_RANGE
// covers). Reverse list = cells that read c. Packed (start,count) runs in one
// bump-allocated pool: append at the pool tail is O(1), otherwise the list
// relocates to the tail with 2x reserved. Touched only at set-time — wbRecalc
// never reads or grows the graph. Blocks of replaced formulas leak into the
// pool until wbInit (bounded by edit count). Dirty set = edited cells plus
// transitive dependents, in discovery order (order is irrelevant: evaluation
// is demand-driven, so wbRecalcDirty matches a full recalc bit-for-bit).
let fwdStart = new Float64Array(0);
let fwdCount = new Float64Array(0);
let revStart = new Float64Array(0);
let revCount = new Float64Array(0);
let edgePool = new Float64Array(0); // shared fwd+rev pool, grown at set-time
let edgeTop = 0;
let edgeCap = 0;
let dirtyFlag = new Float64Array(0);
let dirtyList = new Float64Array(0);
let dirtyStack = new Float64Array(0);
let dirtyCount = 0;

// ---------- token arena (R4: reused per parse) ------------------------------
const TOK_MAX = 512;
const tokKind = new Float64Array(TOK_MAX);
const tokNum = new Float64Array(TOK_MAX); // T_NUM value · T_CELL row · T_FUNC id
const tokPos = new Float64Array(TOK_MAX); // T_CELL col · ident start byte
const tokLen = new Float64Array(TOK_MAX); // ident length
let tokCount = 0;

// T_ tokens
const T_END = 0, T_NUM = 1, T_CELL = 2, T_FUNC = 3, T_IDENT = 4,
  T_LP = 5, T_RP = 6, T_COMMA = 7, T_COLON = 8,
  T_PLUS = 9, T_MINUS = 10, T_STAR = 11, T_SLASH = 12, T_CARET = 13,
  T_LT = 14, T_GT = 15, T_LE = 16, T_GE = 17, T_EQ = 18, T_NE = 19;

// ---------- AST arena (R4: pooled; reset only by wbInit / benchParse) -------
const AST_MAX = 524288; // 512k nodes × 5 f64 arrays = 20 MB pooled arena
const ndKind = new Uint8Array(AST_MAX); // small-int node kinds: === compares fold (no Scratch boxing)
const ndA = new Float64Array(AST_MAX);    // REF cell · RANGE start · CALL funcId · op left
const ndB = new Float64Array(AST_MAX);    // RANGE end · op right · CALL first child
const ndSib = new Float64Array(AST_MAX);  // next argument (child chain)
const ndVal = new Float64Array(AST_MAX);  // N_NUM literal
let astCount = 0;

// N_ node kinds
const N_NUM = 1, N_REF = 2, N_RANGE = 3, N_CALL = 4, N_NEG = 5,
  N_ADD = 6, N_SUB = 7, N_MUL = 8, N_DIV = 9, N_POW = 10,
  N_LT = 11, N_GT = 12, N_LE = 13, N_GE = 14, N_EQ = 15, N_NE = 16,
  N_NAME = 17, N_CALLV = 18; // M1: LET/LAMBDA name binding + variable call

// F_ function ids (dispatch by (len, first two bytes) of the name — unique)
const F_SUM = 1, F_AVERAGE = 2, F_MIN = 3, F_MAX = 4, F_COUNT = 5,
  F_COUNTA = 6, F_IF = 7, F_IFERROR = 8, F_AND = 9, F_OR = 10, F_NOT = 11,
  F_ROUND = 12, F_ABS = 13, F_MOD = 14, F_SIGN = 15, F_INT = 16,
  F_POWER = 17, F_PRODUCT = 18, F_SQRT = 19, F_FLOOR = 20, F_CEIL = 21,
  F_LET = 22, F_LAMBDA = 23, F_SUMPRODUCT = 24;

// ---------- parse/eval scratch ----------------------------------------------
const SRC_MAX = 4096;
const srcF = new Float64Array(SRC_MAX); // input bytes, converted once (R7)
let tc = 0;                  // token cursor during parse
let parseSink = 0;           // keeps parse results live across iterations

// aggregate accumulators (single-pass SUM/COUNT/MIN/MAX/PRODUCT)
let g_sum = 0;
let g_cnt = 0;
let g_min = 0;
let g_max = 0;
let g_psum = 1;
let g_pcnt = 0;

// LCG state for benchBuild (bounded: never exceeds 2^53)
let lcgState = 42;

// ---------------- small numeric helpers (no Math.*) -------------------------
function myFloor(x: number): number {
  const t = x % 1;
  const f = x - t;
  if (t < 0) return f - 1;
  return f;
}
function isErr(v: number): boolean {
  return v !== v || v > 100000000000000000000000000000000000000 || v < -100000000000000000000000000000000000000;
}
function pow10(n: number): number {
  let r = 1;
  let i = 0;
  while (i < n) { r = r * 10; i = i + 1; }
  return r;
}
function intPow(b: number, e: number): number {
  let n = myFloor(e);
  const neg = n < 0;
  if (neg) n = -n;
  let r = 1;
  let i = 0;
  while (i < n) { r = r * b; i = i + 1; }
  if (neg) return 1 / r;
  return r;
}
function newtonSqrt(x: number): number {
  if (x < 0) return 0 / 0;
  if (x === 0) return 0;
  let g = x;
  let i = 0;
  while (i < 40) {
    g = (g + x / g) / 2;
    i = i + 1;
  }
  return g;
}
function lcgNext(): number {
  lcgState = (lcgState * 9301 + 49297) % 233280;
  return (lcgState / 233280) * 100;
}

// ---------------- node allocator --------------------------------------------
function newNode(k: number): number {
  if (astCount >= AST_MAX) return -1;
  const i = astCount;
  astCount = astCount + 1;
  ndKind[i] = k;
  ndA[i] = -1;
  ndB[i] = -1;
  ndSib[i] = -1;
  ndVal[i] = 0;
  return i;
}

// ---------------- function-name resolution ----------------------------------
// (len, b1, b2) is unique across the 21 names — verified in the concept doc.
function funcIdFrom(src: Float64Array, s: number, e: number): number {
  const len = e - s;
  if (s + 1 >= e) return -1;
  const b1 = src[s];
  const b2 = src[s + 1];
  if (len === 3 && b1 === 83 && b2 === 85) return F_SUM;          // SUM
  if (len === 7 && b1 === 65 && b2 === 86) return F_AVERAGE;      // AVERAGE
  if (len === 3 && b1 === 77 && b2 === 73) return F_MIN;          // MIN
  if (len === 3 && b1 === 77 && b2 === 65) return F_MAX;          // MAX
  if (len === 5 && b1 === 67 && b2 === 79) return F_COUNT;        // COUNT
  if (len === 6 && b1 === 67 && b2 === 79) return F_COUNTA;       // COUNTA
  if (len === 2 && b1 === 73 && b2 === 70) return F_IF;           // IF
  if (len === 7 && b1 === 73 && b2 === 70) return F_IFERROR;      // IFERROR (7 letters!)
  if (len === 3 && b1 === 65 && b2 === 78) return F_AND;          // AND
  if (len === 2 && b1 === 79 && b2 === 82) return F_OR;           // OR
  if (len === 3 && b1 === 78 && b2 === 79) return F_NOT;          // NOT
  if (len === 5 && b1 === 82 && b2 === 79) return F_ROUND;        // ROUND
  if (len === 3 && b1 === 65 && b2 === 66) return F_ABS;          // ABS
  if (len === 3 && b1 === 77 && b2 === 79) return F_MOD;          // MOD
  if (len === 4 && b1 === 83 && b2 === 73) return F_SIGN;         // SIGN
  if (len === 3 && b1 === 73 && b2 === 78) return F_INT;          // INT
  if (len === 5 && b1 === 80 && b2 === 79) return F_POWER;        // POWER
  if (len === 7 && b1 === 80 && b2 === 82) return F_PRODUCT;      // PRODUCT
  if (len === 4 && b1 === 83 && b2 === 81) return F_SQRT;         // SQRT
  if (len === 5 && b1 === 70 && b2 === 76) return F_FLOOR;        // FLOOR
  if (len === 4 && b1 === 67 && b2 === 69) return F_CEIL;         // CEIL
  if (len === 3 && b1 === 76 && b2 === 69) return F_LET;          // LET
  if (len === 6 && b1 === 76 && b2 === 65) return F_LAMBDA;       // LAMBDA
  if (len === 10 && b1 === 83 && b2 === 85) return F_SUMPRODUCT;  // SUMPRODUCT
  return -1;
}

// ---------- name table (M1: interned LET/LAMBDA identifier bytes) -----------
// Name identity is by content: the same spelling anywhere in any formula gets
// one id. Resolution is dynamic over the machine's binding stack (scoped by
// the per-cell bind floor), so ids only need to be stable within a book.
const NAME_MAX = 1024;
const NAME_BYTES_MAX = 8192;
const nameOff = new Float64Array(NAME_MAX);
const nameLen = new Float64Array(NAME_MAX);
const nameBytes = new Float64Array(NAME_BYTES_MAX);
let nameCount = 0;
let nameBytesTop = 0;

function internName(s: number, e: number): number {
  const len = e - s;
  let i = 0;
  while (i < nameCount) {
    if (nameLen[i] === len) {
      const off = nameOff[i] + 0;
      let j = 0;
      let same = 1;
      while (j < len) {
        if (nameBytes[off + j] !== srcF[s + j]) { same = 0; j = len; }
        else j = j + 1;
      }
      if (same === 1) return i;
    }
    i = i + 1;
  }
  if (nameCount >= NAME_MAX || nameBytesTop + len > NAME_BYTES_MAX) return -1;
  nameOff[nameCount] = nameBytesTop;
  nameLen[nameCount] = len;
  let j = 0;
  while (j < len) { nameBytes[nameBytesTop + j] = srcF[s + j]; j = j + 1; }
  nameBytesTop = nameBytesTop + len;
  const id = nameCount;
  nameCount = nameCount + 1;
  return id;
}

// ---------------- tokenizer ---------------------------------------------------
function tokenize(bytes: Uint8Array, n: number): number {
  if (n > SRC_MAX) return -1;
  let q0 = 0;
  while (q0 < n) { srcF[q0] = bytes[q0]; q0 = q0 + 1; } // one conversion pass (R7)
  let p = 0;
  let t = 0;
  if (n > 0 && srcF[0] === 61) p = 1; // leading '='
  while (p < n) {
    if (t >= TOK_MAX) return -1;
    const b = srcF[p];
    if (b === 32 || b === 9 || b === 13 || b === 10) { p = p + 1; continue; }
    if (b >= 48 && b <= 57) {
      // number: digits [. digits]
      let m = 0;
      let div = 1;
      let seenDot = 0;
      while (p < n) {
        const c = srcF[p];
        if (c >= 48 && c <= 57) {
          if (seenDot !== 0) { div = div * 10; m = m + (c - 48) / div; }
          else m = m * 10 + (c - 48);
          p = p + 1;
        } else if (c === 46 && seenDot === 0) {
          seenDot = 1;
          p = p + 1;
        } else break;
      }
      tokKind[t] = T_NUM; tokNum[t] = m;
      t = t + 1;
      continue;
    }
    if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 36 || b === 95) {
      // letters[$] then digits → cell ref; letters only → function/ident
      const s = p;
      let col = 0;
      let letters = 0;
      while (p < n) {
        const c = srcF[p];
        if (c >= 65 && c <= 90) { col = col * 26 + (c - 64); letters = letters + 1; p = p + 1; }
        else if (c >= 97 && c <= 122) { col = col * 26 + (c - 96); letters = letters + 1; p = p + 1; }
        else if (c === 36) { p = p + 1; } // '$' absolute marker — same ref
        else break;
      }
      let row = 0;
      let digits = 0;
      while (p < n) {
        const c = srcF[p];
        if (c >= 48 && c <= 57) { row = row * 10 + (c - 48); digits = digits + 1; p = p + 1; }
        else break;
      }
      if (letters > 0 && digits > 0 && row >= 1 && row <= NROWS && col >= 1 && col <= NCOLS) {
        tokKind[t] = T_CELL; tokNum[t] = row; tokPos[t] = col;
      } else if (digits === 0 && letters > 0) {
        // function (followed by '(') or bare ident / variable call
        let q = p;
        while (q < n && (srcF[q] === 32 || srcF[q] === 9)) q = q + 1;
        if (q < n && srcF[q] === 40) {
          const fid = funcIdFrom(srcF, s, p);
          if (fid >= 0) { tokKind[t] = T_FUNC; tokNum[t] = fid; }
          else { tokKind[t] = T_IDENT; tokPos[t] = s; tokLen[t] = p - s; } // LAMBDA variable call
        } else {
          tokKind[t] = T_IDENT; tokPos[t] = s; tokLen[t] = p - s;
        }
      } else return -1; // malformed ref (out of grid or letters-after-digits)
      t = t + 1;
      continue;
    }
    if (b === 43) { tokKind[t] = T_PLUS; t = t + 1; p = p + 1; continue; }
    if (b === 45) { tokKind[t] = T_MINUS; t = t + 1; p = p + 1; continue; }
    if (b === 42) { tokKind[t] = T_STAR; t = t + 1; p = p + 1; continue; }
    if (b === 47) { tokKind[t] = T_SLASH; t = t + 1; p = p + 1; continue; }
    if (b === 94) { tokKind[t] = T_CARET; t = t + 1; p = p + 1; continue; }
    if (b === 40) { tokKind[t] = T_LP; t = t + 1; p = p + 1; continue; }
    if (b === 41) { tokKind[t] = T_RP; t = t + 1; p = p + 1; continue; }
    if (b === 44) { tokKind[t] = T_COMMA; t = t + 1; p = p + 1; continue; }
    if (b === 58) { tokKind[t] = T_COLON; t = t + 1; p = p + 1; continue; }
    if (b === 60) { // < <= <>
      p = p + 1;
      if (p < n && srcF[p] === 61) { tokKind[t] = T_LE; p = p + 1; }
      else if (p < n && srcF[p] === 62) { tokKind[t] = T_NE; p = p + 1; }
      else tokKind[t] = T_LT;
      t = t + 1;
      continue;
    }
    if (b === 62) { // > >=
      p = p + 1;
      if (p < n && srcF[p] === 61) { tokKind[t] = T_GE; p = p + 1; }
      else tokKind[t] = T_GT;
      t = t + 1;
      continue;
    }
    if (b === 61) { tokKind[t] = T_EQ; t = t + 1; p = p + 1; continue; }
    return -1; // unsupported byte (M0: no strings/&/!/%)
  }
  tokKind[t] = T_END;
  return t + 1;
}

// ---------------- parser (single-loop precedence machine) --------------------
// 2026-11-17 §1-e rewrite. The M0 recursive-descent level chain
// (parseExpr→parseCmp→…→parseAtom, plus parseArgList) paid the T1 wrapper tax
// (~30ns) at every level per atom — the JSC parse gate 2.21×. This is the R8
// frame-machine prescription applied to parsing: ONE loop, explicit
// operator/value stacks, zero internal calls in the hot path (node allocation
// and cellIdx are inlined). LET/LAMBDA stay separate functions — cold paths
// that recur through parseSub exactly like argument lists.
// AST shapes are identical to the grammar they replace (precedence battery in
// test.ts locks the semantics; golden stays bit-exact):
// cmp < add < mul < pow(right-assoc) < unary-minus; `-2^2` = (-2)^2 (Excel).
function cellIdx(row: number, col: number): number {
  return (row - 1) * NCOLS + (col - 1);
}

// op-stack entries: binary operators keep their T_ kind (T_PLUS..T_NE is
// contiguous, and N_ADD..N_NE === T_PLUS..T_NE − 3 in the same order — the
// reduce maps kinds through that bijection). Markers use O_ ids above all T_/N_.
const O_LP = 90, O_CALL = 91, O_CALLV = 92, O_NEG = 93;
// precedences — higher binds tighter. P_UN above P_POW: unary minus binds
// tighter than ^ on the left (Excel: -2^2 = 4). Derived from the op-stack
// kind on demand — no parallel precedence array to keep in step.
const P_CMP = 2, P_ADD = 3, P_MUL = 4, P_POW = 5, P_UN = 6;
const PS_MAX = 768; // > TOK_MAX: at most one op/marker and one value per token
const psVal = new Float64Array(PS_MAX); // value stack: AST node ids
const psOp = new Float64Array(PS_MAX);  // op stack: binary T_ kind · O_ marker
const psAux = new Float64Array(PS_MAX);  // O_CALL: funcId · O_CALLV: N_NAME node
const psBase = new Float64Array(PS_MAX); // marker: value-stack base of its args
const psPend = new Float64Array(PS_MAX); // marker: valTop+1 at its last comma (0 = none)
// Stack tops are NOT module state: module-level lets are IR globals (tagged
// unions — the T2/T4 lesson), and a global RMW per token cost ~2× the twin's
// per-op marginal (measured 2026-11-17: 47ns vs 15ns per binary op in wasm).
// They live as parseSub locals, threaded through parseLet/parseLambda as
// plain f64 parameters — free in every tier.

/** Parse one expression starting at tc, stopping WITHOUT consuming at the
 *  first token that cannot continue it (COMMA, RP, END or a stray byte) —
 *  the enclosing context (argument list, LET/LAMBDA pair, wbSetFormula)
 *  decides what the stopper must be. Root node id, or -1 on error. */
function parseSub(op0: number, val0: number): number {
  let opTop = op0;
  let valTop = val0;
  const opBase = op0;
  const valBase = val0;
  let expectVal = 1; // 1 = operand position (a +/- here is unary)
  while (true) {
    const k = tokKind[tc];
    if (k === T_END) break;
    if (k === T_NUM) {
      if (astCount >= AST_MAX || valTop >= PS_MAX) return -1;
      const n = astCount;
      astCount = astCount + 1;
      ndKind[n] = N_NUM; ndA[n] = -1; ndB[n] = -1; ndSib[n] = -1; ndVal[n] = tokNum[tc];
      psVal[valTop] = n; valTop = valTop + 1;
      tc = tc + 1;
      expectVal = 0;
      continue;
    }
    if (k === T_CELL) {
      const r1 = tokNum[tc];
      const c1 = tokPos[tc];
      tc = tc + 1;
      if (tokKind[tc] === T_COLON) { // A1:B2 range primary (corners normalized)
        if (tokKind[tc + 1] !== T_CELL) return -1;
        tc = tc + 1;
        let r2 = tokNum[tc];
        let c2 = tokPos[tc];
        tc = tc + 1;
        let a = r1;
        let b = c1;
        if (r2 < a) { const tmp = a; a = r2; r2 = tmp; }
        if (c2 < b) { const tmp = b; b = c2; c2 = tmp; }
        if (astCount >= AST_MAX || valTop >= PS_MAX) return -1;
        const n = astCount;
        astCount = astCount + 1;
        ndKind[n] = N_RANGE;
        ndA[n] = (a - 1) * NCOLS + (b - 1);
        ndB[n] = (r2 - 1) * NCOLS + (c2 - 1);
        ndSib[n] = -1; ndVal[n] = 0;
        psVal[valTop] = n; valTop = valTop + 1;
        expectVal = 0;
        continue;
      }
      if (astCount >= AST_MAX || valTop >= PS_MAX) return -1;
      const n = astCount;
      astCount = astCount + 1;
      ndKind[n] = N_REF; ndA[n] = (r1 - 1) * NCOLS + (c1 - 1); ndB[n] = -1; ndSib[n] = -1; ndVal[n] = 0;
      psVal[valTop] = n; valTop = valTop + 1;
      expectVal = 0;
      continue;
    }
    if (k === T_FUNC) {
      const fid = tokNum[tc];
      tc = tc + 1;
      if (fid === F_LET || fid === F_LAMBDA) { // special forms own their parens
        const n = fid === F_LET ? parseLet(opTop, valTop) : parseLambda(opTop, valTop);
        if (n < 0) return -1;
        if (valTop >= PS_MAX) return -1;
        psVal[valTop] = n; valTop = valTop + 1;
        expectVal = 0;
        continue;
      }
      if (tokKind[tc] !== T_LP) return -1; // tokenizer contract: FUNC implies (
      tc = tc + 1;
      if (opTop >= PS_MAX) return -1;
      psOp[opTop] = O_CALL; psAux[opTop] = fid; psBase[opTop] = valTop; psPend[opTop] = 0;
      opTop = opTop + 1;
      expectVal = 1;
      continue;
    }
    if (k === T_IDENT) {
      // LET/LAMBDA variable: bare reference or call of a LAMBDA-valued binding
      const id = internName(tokPos[tc], tokPos[tc] + tokLen[tc]);
      if (id < 0) return -1;
      tc = tc + 1;
      if (tokKind[tc] === T_LP) {
        tc = tc + 1;
        if (astCount >= AST_MAX || opTop >= PS_MAX) return -1;
        const nn = astCount;
        astCount = astCount + 1;
        ndKind[nn] = N_NAME; ndA[nn] = id; ndB[nn] = -1; ndSib[nn] = -1; ndVal[nn] = 0;
        psOp[opTop] = O_CALLV; psAux[opTop] = nn; psBase[opTop] = valTop; psPend[opTop] = 0;
        opTop = opTop + 1;
        expectVal = 1;
        continue;
      }
      if (astCount >= AST_MAX || valTop >= PS_MAX) return -1;
      const n = astCount;
      astCount = astCount + 1;
      ndKind[n] = N_NAME; ndA[n] = id; ndB[n] = -1; ndSib[n] = -1; ndVal[n] = 0;
      psVal[valTop] = n; valTop = valTop + 1;
      expectVal = 0;
      continue;
    }
    if (k === T_LP) {
      if (opTop >= PS_MAX) return -1;
      psOp[opTop] = O_LP; psBase[opTop] = valTop; psPend[opTop] = 0;
      opTop = opTop + 1;
      tc = tc + 1;
      expectVal = 1;
      continue;
    }
    if (k === T_RP) {
      // reduce every reducible entry above the nearest marker
      while (opTop > opBase) {
        const mk = psOp[opTop - 1];
        if (mk !== O_NEG && (mk < T_PLUS || mk > T_NE)) break;
        if (mk === O_NEG) {
          if (valTop < valBase + 1 || astCount >= AST_MAX) return -1;
          valTop = valTop - 1;
          const n = astCount;
          astCount = astCount + 1;
          ndKind[n] = N_NEG; ndA[n] = psVal[valTop]; ndB[n] = -1; ndSib[n] = -1; ndVal[n] = 0;
          psVal[valTop] = n; valTop = valTop + 1;
        } else {
          if (valTop < valBase + 2 || astCount >= AST_MAX) return -1;
          const n = astCount;
          astCount = astCount + 1;
          ndKind[n] = mk - 3; // N_ADD..N_NE === T_PLUS..T_NE − 3
          ndA[n] = psVal[valTop - 2]; ndB[n] = psVal[valTop - 1]; ndSib[n] = -1; ndVal[n] = 0;
          valTop = valTop - 1;
          psVal[valTop - 1] = n;
        }
        opTop = opTop - 1;
      }
      if (opTop === opBase) break; // this RP belongs to an enclosing context
      const mk = psOp[opTop - 1];
      if (mk === O_LP) {
        if (valTop !== psBase[opTop - 1] + 1) return -1; // "()" / "(,)" / "(a,b)"
        opTop = opTop - 1;
        tc = tc + 1;
        expectVal = 0;
        continue;
      }
      if (mk === O_CALL || mk === O_CALLV) { // build the call from its args
        const m = opTop - 1;
        // `+ 0` launders the Float64Array idxOr load to raw f64. Without it,
        // `valTop = vb` widens valTop to a tagged union for the whole function
        // and every `valTop±1` becomes scr_union_new_f64 + release (IR 2026-11-17).
        const vb = psBase[m] + 0;
        if (psPend[m] !== 0 && valTop === psPend[m] - 1) return -1; // trailing comma
        let first = -1;
        let j = vb;
        while (j < valTop - 1) { ndSib[psVal[j]] = psVal[j + 1]; j = j + 1; }
        if (valTop > vb) first = psVal[vb] + 0;
        if (astCount >= AST_MAX) return -1;
        const n = astCount;
        astCount = astCount + 1;
        ndKind[n] = mk === O_CALL ? N_CALL : N_CALLV;
        ndA[n] = psAux[m] + 0; ndB[n] = first; ndSib[n] = -1; ndVal[n] = 0;
        opTop = opTop - 1;
        valTop = vb;
        psVal[valTop] = n; valTop = valTop + 1;
        tc = tc + 1;
        expectVal = 0;
        continue;
      }
      return -1;
    }
    if (k === T_COMMA) {
      // reduce every reducible entry above the nearest marker
      while (opTop > opBase) {
        const mk = psOp[opTop - 1];
        if (mk !== O_NEG && (mk < T_PLUS || mk > T_NE)) break;
        if (mk === O_NEG) {
          if (valTop < valBase + 1 || astCount >= AST_MAX) return -1;
          valTop = valTop - 1;
          const n = astCount;
          astCount = astCount + 1;
          ndKind[n] = N_NEG; ndA[n] = psVal[valTop]; ndB[n] = -1; ndSib[n] = -1; ndVal[n] = 0;
          psVal[valTop] = n; valTop = valTop + 1;
        } else {
          if (valTop < valBase + 2 || astCount >= AST_MAX) return -1;
          const n = astCount;
          astCount = astCount + 1;
          ndKind[n] = mk - 3; // N_ADD..N_NE === T_PLUS..T_NE − 3
          ndA[n] = psVal[valTop - 2]; ndB[n] = psVal[valTop - 1]; ndSib[n] = -1; ndVal[n] = 0;
          valTop = valTop - 1;
          psVal[valTop - 1] = n;
        }
        opTop = opTop - 1;
      }
      if (opTop > opBase) {
        const mk = psOp[opTop - 1];
        if (mk === O_CALL || mk === O_CALLV) { // argument separator
          const m = opTop - 1;
          if (valTop === psBase[m]) return -1; // empty arg: "F(,x)" / "F(,)"
          if (psPend[m] !== 0 && valTop === psPend[m] - 1) return -1; // double comma
          psPend[m] = valTop + 1;
          tc = tc + 1;
          expectVal = 1;
          continue;
        }
      }
      break; // comma of an enclosing context (LET pair / arg list) — stop, don't consume
    }
    // operators (operand position first: unary minus / transparent plus)
    if (expectVal === 1) {
      if (k === T_MINUS) {
        if (opTop >= PS_MAX) return -1;
        psOp[opTop] = O_NEG;
        opTop = opTop + 1;
        tc = tc + 1;
        continue; // still in operand position
      }
      if (k === T_PLUS) { tc = tc + 1; continue; } // unary plus is transparent
      return -1; // operator where an operand must be ("=1+*2")
    }
    let prec = 0;
    let la = 1;
    if (k === T_CARET) { prec = P_POW; la = 0; } // right-assoc
    else if (k === T_STAR || k === T_SLASH) { prec = P_MUL; }
    else if (k === T_PLUS || k === T_MINUS) { prec = P_ADD; }
    else if (k === T_LT || k === T_GT || k === T_LE || k === T_GE || k === T_EQ || k === T_NE) { prec = P_CMP; }
    else break; // stray token (T_COLON, ...) — terminator, caller decides
    // reduce while the stack top binds at least as tight (left-assoc: >=; right: >)
    while (opTop > opBase) {
      const mk = psOp[opTop - 1];
      if (mk !== O_NEG && (mk < T_PLUS || mk > T_NE)) break;
      let tp = P_CMP; // precedence derived from the entry kind (no side table)
      if (mk === O_NEG) tp = P_UN;
      else if (mk === T_CARET) tp = P_POW;
      else if (mk === T_STAR || mk === T_SLASH) tp = P_MUL;
      else if (mk === T_PLUS || mk === T_MINUS) tp = P_ADD;
      if (tp > prec || (tp === prec && la === 1)) {
        if (mk === O_NEG) {
          if (valTop < valBase + 1 || astCount >= AST_MAX) return -1;
          valTop = valTop - 1;
          const n = astCount;
          astCount = astCount + 1;
          ndKind[n] = N_NEG; ndA[n] = psVal[valTop]; ndB[n] = -1; ndSib[n] = -1; ndVal[n] = 0;
          psVal[valTop] = n; valTop = valTop + 1;
        } else {
          if (valTop < valBase + 2 || astCount >= AST_MAX) return -1;
          const n = astCount;
          astCount = astCount + 1;
          ndKind[n] = mk - 3; // N_ADD..N_NE === T_PLUS..T_NE − 3
          ndA[n] = psVal[valTop - 2]; ndB[n] = psVal[valTop - 1]; ndSib[n] = -1; ndVal[n] = 0;
          valTop = valTop - 1;
          psVal[valTop - 1] = n;
        }
        opTop = opTop - 1;
      } else break;
    }
    if (opTop >= PS_MAX) return -1;
    psOp[opTop] = k;
    opTop = opTop + 1;
    expectVal = 1;
    tc = tc + 1;
  }
  // terminator (END / enclosing COMMA or RP / stray): reduce, validate one value
  while (opTop > opBase) {
    const mk = psOp[opTop - 1];
    if (mk !== O_NEG && (mk < T_PLUS || mk > T_NE)) break;
    if (mk === O_NEG) {
      if (valTop < valBase + 1 || astCount >= AST_MAX) return -1;
      valTop = valTop - 1;
      const n = astCount;
      astCount = astCount + 1;
      ndKind[n] = N_NEG; ndA[n] = psVal[valTop]; ndB[n] = -1; ndSib[n] = -1; ndVal[n] = 0;
      psVal[valTop] = n; valTop = valTop + 1;
    } else {
      if (valTop < valBase + 2 || astCount >= AST_MAX) return -1;
      const n = astCount;
      astCount = astCount + 1;
      ndKind[n] = mk - 3; // N_ADD..N_NE === T_PLUS..T_NE − 3
      ndA[n] = psVal[valTop - 2]; ndB[n] = psVal[valTop - 1]; ndSib[n] = -1; ndVal[n] = 0;
      valTop = valTop - 1;
      psVal[valTop - 1] = n;
    }
    opTop = opTop - 1;
  }
  if (opTop !== opBase) return -1; // unclosed ( or call
  if (valTop !== valBase + 1) return -1; // empty or juxtaposed values
  return psVal[valTop - 1]; // stack tops are locals — nothing to restore
}

/** Parse a whole formula (tc must be 0): one expression, fully consumed. */
function parseFormula(): number {
  const root = parseSub(0, 0);
  if (root < 0) return -1;
  if (tokKind[tc] !== T_END) return -1;
  return root;
}

// (LET/LAMBDA helpers only — cold paths, the wrapper tax is irrelevant there)
function peekKind(): number {
  return tokKind[tc];
}

// LET(name, value, [name, value]..., body): children are N_NAME, expr, ..., expr.
// After a value's comma, a bare ident followed by another ',' begins the next
// pair; anything else parses as the body.
function parseLet(op0: number, val0: number): number {
  if (peekKind() !== T_LP) return -1;
  tc = tc + 1;
  const n = newNode(N_CALL);
  if (n < 0) return -1;
  ndA[n] = F_LET;
  let first = -1;
  let prev = -1;
  let pairs = 0;
  let body = -1;
  while (true) {
    if (peekKind() !== T_IDENT) return -1;
    const id = internName(tokPos[tc], tokPos[tc] + tokLen[tc]);
    if (id < 0) return -1;
    tc = tc + 1;
    const nn = newNode(N_NAME);
    if (nn < 0) return -1;
    ndA[nn] = id;
    if (prev < 0) first = nn;
    else ndSib[prev] = nn;
    prev = nn;
    if (peekKind() !== T_COMMA) return -1;
    tc = tc + 1;
    const val = parseSub(op0, val0);
    if (val < 0) return -1;
    ndSib[prev] = val;
    prev = val;
    pairs = pairs + 1;
    if (peekKind() !== T_COMMA) return -1; // a body is required after every value
    tc = tc + 1;
    // a bare ident followed by another ',' begins the next pair; anything
    // else (ident+other, literal, call, nested LET...) parses as the body
    if (peekKind() === T_IDENT && tokKind[tc + 1] === T_COMMA) continue;
    body = parseSub(op0, val0);
    break;
  }
  if (body < 0) return -1;
  ndSib[prev] = body;
  if (peekKind() !== T_RP) return -1;
  tc = tc + 1;
  ndB[n] = first;
  ndVal[n] = pairs;
  return n;
}

// LAMBDA(param, ..., body): children are N_NAME params ..., body last.
function parseLambda(op0: number, val0: number): number {
  if (peekKind() !== T_LP) return -1;
  tc = tc + 1;
  const n = newNode(N_CALL);
  if (n < 0) return -1;
  ndA[n] = F_LAMBDA;
  let first = -1;
  let prev = -1;
  let pc = 0;
  let body = -1;
  while (true) {
    if (peekKind() !== T_IDENT) return -1;
    const id = internName(tokPos[tc], tokPos[tc] + tokLen[tc]);
    if (id < 0) return -1;
    tc = tc + 1;
    const pn = newNode(N_NAME);
    if (pn < 0) return -1;
    ndA[pn] = id;
    if (prev < 0) first = pn;
    else ndSib[prev] = pn;
    prev = pn;
    pc = pc + 1;
    if (peekKind() !== T_COMMA) return -1;
    tc = tc + 1;
    // a bare ident followed by another ',' is the next param; else it's the body
    if (peekKind() === T_IDENT && tokKind[tc + 1] === T_COMMA) continue;
    body = parseSub(op0, val0);
    break;
  }
  if (body < 0) return -1;
  ndSib[prev] = body;
  if (peekKind() !== T_RP) return -1;
  tc = tc + 1;
  ndB[n] = first;
  ndVal[n] = pc;
  return n;
}

// ---------------- dependency graph (set-time only) ----------------------------
function growEdges(need: number): void {
  let cap = edgeCap * 2 + 1024;
  while (cap < edgeTop + need) cap = cap * 2 + 1024;
  const np = new Float64Array(cap);
  let i = 0;
  while (i < edgeTop) { np[i] = edgePool[i]; i = i + 1; }
  edgePool = np;
  edgeCap = cap;
}

// append v to a cell's list; relocate to the pool tail (2x reserved) if blocked
function edgeAdd(st: Float64Array, cn: Float64Array, cell: number, v: number): void {
  const c = cn[cell];
  if (c === 0) {
    if (edgeTop + 1 > edgeCap) growEdges(1);
    st[cell] = edgeTop;
    edgePool[edgeTop] = v;
    edgeTop = edgeTop + 1;
    cn[cell] = 1;
    return;
  }
  const s = st[cell];
  if (s + c === edgeTop && edgeTop + 1 <= edgeCap) {
    edgePool[edgeTop] = v;
    edgeTop = edgeTop + 1;
    cn[cell] = c + 1;
    return;
  }
  let res = c * 2;
  if (res < c + 1) res = c + 1;
  if (edgeTop + res > edgeCap) growEdges(res);
  let j = 0;
  while (j < c) { edgePool[edgeTop + j] = edgePool[s + j]; j = j + 1; }
  st[cell] = edgeTop;
  edgePool[edgeTop + c] = v;
  edgeTop = edgeTop + res;
  cn[cell] = c + 1;
}

function addDeps(cell: number, target: number): void {
  edgeAdd(fwdStart, fwdCount, cell, target);
  edgeAdd(revStart, revCount, target, cell);
}

function revRemove(t: number, v: number): void {
  const c = revCount[t];
  if (c === 0) return;
  const s = revStart[t];
  let j = 0;
  while (j < c) {
    if (edgePool[s + j] === v) {
      edgePool[s + j] = edgePool[s + c - 1]; // swap-remove; list order is irrelevant
      revCount[t] = c - 1;
      return;
    }
    j = j + 1;
  }
}

function removeDeps(cell: number): void {
  const s = fwdStart[cell];
  const c = fwdCount[cell];
  let j = 0;
  while (j < c) { revRemove(edgePool[s + j] + 0, cell); j = j + 1; }
  fwdCount[cell] = 0; // retired block leaks into the pool until wbInit
}

function addCellDeps(cell: number, root: number): void {
  fwdCount[cell] = 0;
  collectRefs(root, cell);
}

// walk a parsed formula; one edge per referenced cell (ranges cover each cell)
function collectRefs(n: number, cell: number): void {
  const k = ndKind[n];
  if (k === N_REF) { addDeps(cell, ndA[n] + 0); return; }
  if (k === N_RANGE) {
    const a = ndA[n] + 0;
    const b = ndB[n] + 0;
    const qa = a / NCOLS; const ta = qa % 1;
    const r1 = (qa - ta) - (ta < 0 ? 1 : 0); // floor
    const qb = b / NCOLS; const tb = qb % 1;
    const r2 = (qb - tb) - (tb < 0 ? 1 : 0);
    const c1 = a - r1 * NCOLS;
    const c2 = b - r2 * NCOLS;
    let rb = r1 * NCOLS;
    const rbEnd = r2 * NCOLS;
    while (rb <= rbEnd) {
      let cc = c1;
      while (cc <= c2) { addDeps(cell, rb + cc); cc = cc + 1; }
      rb = rb + NCOLS;
    }
    return;
  }
  if (k === N_CALL) { let cc = ndB[n]; while (cc >= 0) { collectRefs(cc, cell); cc = ndSib[cc]; } return; }
  if (k === N_CALLV) { let cc = ndB[n]; while (cc >= 0) { collectRefs(cc, cell); cc = ndSib[cc]; } return; }
  if (k === N_NEG) { collectRefs(ndA[n], cell); return; }
  if (k >= N_ADD && k <= N_NE) { collectRefs(ndA[n], cell); collectRefs(ndB[n], cell); return; }
  // N_NUM / N_NAME: no cell edges
}

// transitive dirty marking over reverse edges; each cell enters the set once
function markDirty(seed: number): void {
  if (dirtyFlag[seed] !== 0) return;
  dirtyFlag[seed] = 1;
  dirtyList[dirtyCount] = seed;
  dirtyCount = dirtyCount + 1;
  dirtyStack[0] = seed;
  let top = 1;
  while (top > 0) {
    top = top - 1;
    const x = dirtyStack[top] + 0;
    const c = revCount[x];
    if (c === 0) continue;
    const s = revStart[x];
    let j = 0;
    while (j < c) {
      const y = edgePool[s + j] + 0;
      if (dirtyFlag[y] === 0) {
        dirtyFlag[y] = 1;
        dirtyList[dirtyCount] = y;
        dirtyCount = dirtyCount + 1;
        dirtyStack[top] = y;
        top = top + 1;
      }
      j = j + 1;
    }
  }
}

// ---------------- evaluator: frame machine (R8) --------------------------------
// Replaces the recursive evalCell/evalNode/evalCall/aggArg evaluator. Why:
// every scriptc call site boxes — sc_f_ wrappers return a heap ptr and run
// scr_union_release on args (see core.lib.ll) — which taxed the recursive
// engine 2.5-7.4x vs the JS twin (worst on call-heavy shapes, e.g. IF3 at
// 7.4x). The machine keeps one dispatch loop inlined in wbRecalc: zero
// scriptc calls in the hot path, explicit work/value stacks. Semantics are
// ported 1:1 from the recursive evaluator and verified bit-exact against
// golden outputs captured before the rewrite (.golden.json).
const FR_MAX = 65536;
const ftTag = new Uint8Array(FR_MAX); // small-int frame tags: === compares fold (no Scratch boxing)
const ftA = new Float64Array(FR_MAX); // node / cell idx / binop kind / funcId
const ftB = new Float64Array(FR_MAX); // binop - / argc / agg arg cursor / base
const ftC = new Float64Array(FR_MAX); // agg argc / range col cursor
const ftD = new Float64Array(FR_MAX); // range first col
const ftE = new Float64Array(FR_MAX); // range last col
const ftF = new Float64Array(FR_MAX); // range end idx
const vstk = new Float64Array(FR_MAX);
const scratch16 = new Float64Array(16); // child list for reverse push
const AGG_MAX = 1024;
const aggSave = new Float64Array(AGG_MAX * 7); // register snapshot per open aggregate
// live aggregate registers as array slots — module `let` scalars assigned from
// array loads lower to boxed union globals (scr_union_new + release per write,
// ~50ns/iter measured); array slots stay raw (~2ns/iter for six RMWs)
const gg = new Float64Array(6);
let fp = -1;
let sp = 0;
let aggTop = 0;
const FT_NODE = 1; // a=node: evaluate subtree, net +1 value
const FT_CELL = 2; // a=idx: write back top of vstk to cell, net 0
const FT_PUSHV = 3; // a=idx: push vals[idx] (after write-back), net +1
const FT_BIN = 4; // a=node kind: pop 2, push op result
const FT_NEG = 5;
const FT_APPLY = 6; // a=funcId, b=argc (c=argc if b=-2 overflow case)
const FT_AGG = 7; // a=funcId, b=current arg child (-1 = finalize)
const FT_AGR = 8; // b=base, c=col, d=c0, e=c1, f=end: ensure+accumulate one range
const FT_ASC = 9; // agg scalar arg: pop 1 -> accOne
const FT_LET = 10; // LET: a=node, b=state, c=cur child, d=pairs left, e=pending name, f=total pairs
const FT_CALL = 11; // LAMBDA call: a=closure node, b=state, c=cur arg, d=params left, e=pending name, f=total params
const FT_SP2 = 12; // SUMPRODUCT: open pairwise aggregate (b=-1 finalize)
const FT_AGR2 = 13; // SUMPRODUCT pairwise walk: b=row base1, c=col cursor, d=base2-base1, e=first col, f=end1

// LET/LAMBDA binding stack: nameId + value (+ isLambda). Machine-scoped: the
// dispatch loop pushes/pops around scope bodies. N_NAME looks up down to the
// current cell's bind floor (mBindBase), so pulled cells never see the
// requesting formula's live bindings. Lambdas bind directly (AST node idx as
// the value) and never ride the value stack.
const BIND_MAX = 4096;
const bindName = new Float64Array(BIND_MAX);
const bindVal = new Float64Array(BIND_MAX);
const bindKind = new Uint8Array(BIND_MAX); // 0 number · 1 lambda — u8 so === folds
const ctxSave = new Float64Array(FR_MAX); // bindBase per open cell context
const LAMBDA_DEPTH_CAP = 200;

// ---------------- workbook API -------------------------------------------------
export function wbInit(rows: number, cols: number): number {
  NROWS = rows;
  NCOLS = cols;
  NCELLS = rows * cols;
  vals = new Float64Array(NCELLS);
  kinds = new Uint8Array(NCELLS);
  astRoot = new Float64Array(NCELLS);
  computed = new Uint8Array(NCELLS);
  visiting = new Uint8Array(NCELLS);
  fwdStart = new Float64Array(NCELLS);
  fwdCount = new Float64Array(NCELLS);
  revStart = new Float64Array(NCELLS);
  revCount = new Float64Array(NCELLS);
  dirtyFlag = new Float64Array(NCELLS);
  dirtyList = new Float64Array(NCELLS);
  dirtyStack = new Float64Array(NCELLS);
  let i = 0;
  while (i < NCELLS) {
    astRoot[i] = -1;
    i = i + 1;
  }
  astCount = 0;
  nameCount = 0;
  nameBytesTop = 0;
  edgeTop = 0; // pools keep capacity across builds (R4)
  dirtyCount = 0;
  lcgState = 42;
  return NCELLS;
}

export function wbSetNumber(idx: number, v: number): number {
  if (kinds[idx] === 2) removeDeps(idx); // formula -> number: drop its reads
  kinds[idx] = 1;
  vals[idx] = v;
  astRoot[idx] = -1;
  computed[idx] = 1;
  markDirty(idx);
  return v;
}

/** Batch numeric fill: idxStart.. + little-endian packed f64 bytes (R3). */
export function wbSetNumbers(idxStart: number, packed: Uint8Array): number {
  const n = myFloor(packed.length / 8);
  let i = 0;
  while (i < n) {
    let v = 0;
    let scale = 1;
    let j = 7;
    while (j >= 0) {
      v = v + packed[i * 8 + j] * scale;
      scale = scale * 256;
      j = j - 1;
    }
    wbSetNumber(idxStart + i, v);
    i = i + 1;
  }
  return n;
}

export function wbGet(idx: number): number {
  return vals[idx];
}

/** Parse `formula` (UTF-8 bytes, optional leading '=') into cell `idx`. */
export function wbSetFormula(idx: number, formula: Uint8Array): number {
  const nt = tokenize(formula, formula.length);
  if (nt < 0) return failFormula(idx);
  tc = 0;
  const root = parseFormula();
  if (root < 0) return failFormula(idx);
  removeDeps(idx); // drop the previous formula's reads, if any
  kinds[idx] = 2;
  astRoot[idx] = root;
  computed[idx] = 0;
  addCellDeps(idx, root);
  markDirty(idx);
  return 1;
}

/** Parse failure: cell becomes an error cell (NaN); previous deps dropped. */
function failFormula(idx: number): number {
  removeDeps(idx);
  kinds[idx] = 3;
  vals[idx] = 0 / 0;
  astRoot[idx] = -1;
  computed[idx] = 1;
  markDirty(idx);
  return 0;
}

/** First uncomputed formula cell index >= from, else -1. Kept as a separate
 *  small function: inside wbRecalc's multi-thousand-line body these scan loops
 *  compile to ~18ns/cell; standalone (LLVM inlines the call for free — internal
 *  calls carry no wrapper tax) they hit ~1.5ns/cell (2026-11-17 probe). */
function scanFind(from: number, ncells: number): number {
  if (ncells < 0) return scanFind(from, ncells); // recursion guard: keeps LLVM from inlining this hot loop into callers (§1-d)
  // freeze module-global array pointers ONCE: per-iteration global loads kill hoisting
  const k = kinds;
  const c = computed;
  let found = -1;
  for (let s = from; s < ncells; s = s + 1) {
    const si = s | 0; // `| 0` laundering: i32 index for the versioned loop
    if (k[si] === 2 && c[si] === 0) { found = s; break; }
  }
  return found;
}
/** Checksum over all cells, ascending index (deterministic summation order).
 *  NOTE: no `x === x` NaN test — scriptc `===` boxes both operands as generic
 *  Scratch values (call+release per element, 15× slower); and it is redundant:
 *  both fence comparisons are false for NaN/±inf, so the fence alone excludes
 *  them. Predicate is bit-identical to the old form (golden oracles unchanged). */
function scanChecksum(ncells: number): number {
  if (ncells < 0) return scanChecksum(ncells); // recursion guard (see scanFind)
  let sum = 0;
  const v = vals;
  const HI = 100000000000000000000000000000000000000;
  const LO = -100000000000000000000000000000000000000;
  for (let c2 = 0; c2 < ncells; c2 = c2 + 1) {
    const x = v[c2 | 0];
    if (x < HI && x > LO) sum = sum + x;
  }
  return sum;
}

/** The frame machine for ONE formula cell (seed + dispatch). Kept in its own
 *  function on purpose: too big for LLVM to inline back into wbRecalc, so the
 *  scan loops stay in a small function where loop versioning fires (§1-d). */
function runCell(cell: number): void {  // local machine state: module-level lets/consts are globals in the IR —
  // reloading them per dispatch (plus alias-invalidated re-reads) dominated
  // runtime. Everything hot becomes an SSA register here.
  const mTag = ftTag;
  const mA = ftA;
  const mB = ftB;
  const mC = ftC;
  const mD = ftD;
  const mE = ftE;
  const mF = ftF;
  const mVstk = vstk;
  const mGg = gg;
  const mSave = aggSave;
  const mScratch = scratch16;
  const mVals = vals;
  const mKinds = kinds;
  const mRoot = astRoot;
  const mComputed = computed;
  const mVisiting = visiting;
  const mNk = ndKind;
  const mNa = ndA;
  const mNb = ndB;
  const mNsib = ndSib;
  const mNval = ndVal;
  const mNCOLS = NCOLS;
  const mNCELLS = NCELLS;
  const lFT_NODE = FT_NODE;
  const lFT_CELL = FT_CELL;
  const lFT_PUSHV = FT_PUSHV;
  const lFT_BIN = FT_BIN;
  const lFT_NEG = FT_NEG;
  const lFT_APPLY = FT_APPLY;
  const lFT_AGG = FT_AGG;
  const lFT_AGR = FT_AGR;
  const lFT_ASC = FT_ASC;
  const lN_REF = N_REF;
  const lN_CALL = N_CALL;
  const lN_ADD = N_ADD;
  const lN_MUL = N_MUL;
  const lN_SUB = N_SUB;
  const lN_DIV = N_DIV;
  const lN_POW = N_POW;
  const lN_NUM = N_NUM;
  const lN_NEG = N_NEG;
  const lN_LT = N_LT;
  const lN_NE = N_NE;
  const lF_SUM = F_SUM;
  const lF_AVERAGE = F_AVERAGE;
  const lF_COUNT = F_COUNT;
  const lF_COUNTA = F_COUNTA;
  const lF_MIN = F_MIN;
  const lF_MAX = F_MAX;
  const lF_PRODUCT = F_PRODUCT;
  const lF_IF = F_IF;
  const lF_IFERROR = F_IFERROR;
  const lF_AND = F_AND;
  const lF_OR = F_OR;
  const lF_NOT = F_NOT;
  const lF_ABS = F_ABS;
  const lF_SIGN = F_SIGN;
  const lF_INT = F_INT;
  const lF_SQRT = F_SQRT;
  const lF_ROUND = F_ROUND;
  const lF_MOD = F_MOD;
  const lF_POWER = F_POWER;
  const lF_FLOOR = F_FLOOR;
  const lF_CEIL = F_CEIL;
  const lF_LET = F_LET;
  const lF_LAMBDA = F_LAMBDA;
  const lF_SUMPRODUCT = F_SUMPRODUCT;
  const lFT_SP2 = FT_SP2;
  const lFT_AGR2 = FT_AGR2;
  const lN_NAME = N_NAME;
  const lN_CALLV = N_CALLV;
  const lFT_LET = FT_LET;
  const lFT_CALL = FT_CALL;
  const lBindName = bindName;
  const lBindVal = bindVal;
  const lBindKind = bindKind;
  const lCtxSave = ctxSave;
  const lDepthCap = LAMBDA_DEPTH_CAP;
  const lBindMax = BIND_MAX;
  let mfp = -1;
  let msp = 0;
  let mAggTop = 0;
  let mBindTop = 0; // LET/LAMBDA binding stack depth for the current cell
  let mBindBase = 0; // name-lookup floor = binding depth at the current cell's entry
  let mCtxTop = 0; // saved bindBase per open cell context (seed + pulls)
  let mCallDepth = 0; // active LAMBDA frames

  // cell sweep, split for loop-versioning (§1-c): the dirty-cell FINDER and the
  // checksum live in small standalone functions (they compile ~12× faster per
  // cell there — a giant function body defeats loop versioning), the machine
  // runs between finder calls. Internal calls inline for free (no T1 tax).
  // seed the machine for this cell: [lFT_CELL(i), lFT_NODE(root)]
  msp = 0;
  mfp = 1;
  mTag[0] = lFT_CELL; mA[0] = cell;
  mTag[1] = lFT_NODE; mA[1] = mRoot[cell];
  mVisiting[cell] = 1;
  mBindTop = 0;
  mBindBase = 0;
  mCallDepth = 0;
  lCtxSave[0] = 0; // the seed lFT_CELL owns context slot 0
  mCtxTop = 1;
  while (mfp >= 0) {
        const tag = mTag[mfp];
        if (tag === lFT_NODE) {
          const n = mA[mfp];
          const k = mNk[n];
          if (k === lN_REF) {
            const idx = mNa[n] + 0;
            const kk = mKinds[idx];
            if (kk === 1 || (kk === 2 && mComputed[idx] !== 0)) { mVstk[msp] = mVals[idx]; msp = msp + 1; mfp = mfp - 1; }
            else if (kk === 2 && mVisiting[idx] !== 0) { mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1; } // cycle
            else if (kk !== 2) { mVstk[msp] = kk === 0 ? 0 : 0 / 0; msp = msp + 1; mfp = mfp - 1; } // empty=0, error=NaN
            else {
              // uncomputed formula: evaluate it, write back, then push its value.
              // self -> lFT_PUSHV (runs last), then lFT_CELL (runs second), then lFT_NODE (runs first)
              lCtxSave[mCtxTop] = mBindBase;
              mCtxTop = mCtxTop + 1;
              mBindBase = mBindTop; // the pulled cell's bindings start above ours
              mVisiting[idx] = 1;
              mTag[mfp] = lFT_PUSHV; mA[mfp] = idx;
              mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = idx;
              mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[idx];
            }
          } else if (k === lN_CALL) {
            const fid = mNa[n];
            if (fid === lF_LET) {
              // (name, value) pairs then body — parser guarantees the shape
              const pairs = mNval[n] + 0;
              if (pairs < 1 || mBindTop + pairs > lBindMax) {
                mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1;
              } else {
                mTag[mfp] = lFT_LET; mA[mfp] = n;
                mB[mfp] = 0; // state: expect binding pair
                mC[mfp] = mNb[n]; // first child (name node)
                mD[mfp] = pairs;
                mE[mfp] = -1;
                mF[mfp] = pairs;
              }
            } else if (fid === lF_LAMBDA) {
              // lambda in value position: callables never ride the value stack
              mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1;
            } else if (fid === lF_SUMPRODUCT) {
              // exactly two N_RANGE children of equal shape, else NaN.
              // delta = range2.top-left - range1.top-left is constant because
              // the shapes match, so cur2 = cur1 + delta walks range2 in
              // lockstep with range1.
              const ch1 = mNb[n] + 0;
              const ch2 = mNsib[ch1] + 0;
              const ch3 = mNsib[ch2] + 0;
              let ok = 1;
              let r1b = 0;
              let end1 = 0;
              let cA = 0;
              let cB = 0;
              let delta = 0;
              if (ch2 < 0 || ch3 >= 0 || mNk[ch1] !== N_RANGE || mNk[ch2] !== N_RANGE) ok = 0;
              else {
                const qa = mNa[ch1] / mNCOLS; const ta = qa % 1;
                const r1 = (qa - ta) - (ta < 0 ? 1 : 0);
                const qb = mNb[ch1] / mNCOLS; const tb = qb % 1;
                const r2 = (qb - tb) - (tb < 0 ? 1 : 0);
                const ca = mNa[ch1] - r1 * mNCOLS;
                const cb = mNb[ch1] - r2 * mNCOLS;
                const qc = mNa[ch2] / mNCOLS; const tc2 = qc % 1;
                const r3 = (qc - tc2) - (tc2 < 0 ? 1 : 0);
                const qd = mNb[ch2] / mNCOLS; const td = qd % 1;
                const r4 = (qd - td) - (td < 0 ? 1 : 0);
                const c3 = mNa[ch2] - r3 * mNCOLS;
                const c4 = mNb[ch2] - r4 * mNCOLS;
                if (r2 - r1 !== r4 - r3 || cb - ca !== c4 - c3) ok = 0;
                else {
                  r1b = r1 * mNCOLS;
                  end1 = r2 * mNCOLS + cb;
                  cA = ca;
                  cB = cb;
                  delta = mNa[ch2] - mNa[ch1];
                }
              }
              if (ok === 0) {
                mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1;
              } else {
                // open the pairwise aggregate (nested-safe like FT_AGG)
                mSave[mAggTop] = mGg[0]; mSave[mAggTop + 1] = mGg[1];
                mSave[mAggTop + 2] = mGg[2]; mSave[mAggTop + 3] = mGg[3];
                mSave[mAggTop + 4] = mGg[4]; mSave[mAggTop + 5] = mGg[5];
                mAggTop = mAggTop + 7;
                mGg[0] = 0; mGg[1] = 0; mGg[2] = 0; mGg[3] = 0; mGg[4] = 1; mGg[5] = 0;
                mTag[mfp] = lFT_SP2; mA[mfp] = fid; mB[mfp] = -1;
                mfp = mfp + 1;
                mTag[mfp] = lFT_AGR2;
                mA[mfp] = cB; mB[mfp] = r1b; mC[mfp] = cA; mD[mfp] = delta; mE[mfp] = cA; mF[mfp] = end1;
              }
            } else if (fid === lF_SUM || fid === lF_AVERAGE || fid === lF_COUNT || fid === lF_COUNTA ||
              fid === lF_MIN || fid === lF_MAX || fid === lF_PRODUCT) {
              // open aggregate: snapshot registers, reset (nested-safe by construction)
              mSave[mAggTop] = mGg[0]; mSave[mAggTop + 1] = mGg[1];
              mSave[mAggTop + 2] = mGg[2]; mSave[mAggTop + 3] = mGg[3];
              mSave[mAggTop + 4] = mGg[4]; mSave[mAggTop + 5] = mGg[5];
              mAggTop = mAggTop + 7;
              mGg[0] = 0; mGg[1] = 0; mGg[2] = 0; mGg[3] = 0; mGg[4] = 1; mGg[5] = 0;
              mTag[mfp] = lFT_AGG; mA[mfp] = fid; mB[mfp] = mNb[n];
            } else {
              // scalar function: count children, push in reverse so the first arg
              // evaluates first (its value lands deepest in mVstk)
              let argc = 0;
              let cc = mNb[n];
              while (cc >= 0 && argc < 16) { mScratch[argc] = cc; argc = argc + 1; cc = mNsib[cc]; }
              if (argc < 16) {
                mTag[mfp] = lFT_APPLY; mA[mfp] = fid; mB[mfp] = argc;
                let j = argc - 1;
                while (j >= 0) { mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mScratch[j]; j = j - 1; }
              } else {
                // >16 args: only order-insensitive AND/OR stay valid; forward push
                cc = mNb[n];
                let total = 0;
                while (cc >= 0) { total = total + 1; cc = mNsib[cc]; }
                mTag[mfp] = lFT_APPLY; mA[mfp] = fid;
                mB[mfp] = fid === lF_AND || fid === lF_OR ? total : -2;
                mC[mfp] = total;
                cc = mNb[n];
                while (cc >= 0) { mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = cc; cc = mNsib[cc]; }
              }
            }
          } else if (k === lN_ADD || k === lN_MUL || k === lN_SUB || k === lN_DIV || k === lN_POW ||
            (k >= lN_LT && k <= lN_NE)) {
            // self -> lFT_BIN; children: b pushed first, a last (a evaluates first)
            mTag[mfp] = lFT_BIN; mA[mfp] = k;
            mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mNb[n];
            mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mNa[n];
          } else if (k === lN_NUM) { mVstk[msp] = mNval[n]; msp = msp + 1; mfp = mfp - 1; }
          else if (k === lN_NEG) {
            mTag[mfp] = lFT_NEG;
            mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mNa[n];
          } else if (k === lN_NAME) {
            // binding lookup, innermost first, down to this cell's floor
            const nid = mNa[n] + 0;
            let b = mBindTop;
            let found = -1;
            while (b > mBindBase) {
              b = b - 1;
              if (lBindName[b] === nid) { found = b; b = mBindBase; }
            }
            if (found >= 0 && lBindKind[found] === 0) { mVstk[msp] = lBindVal[found] + 0; msp = msp + 1; }
            else { mVstk[msp] = 0 / 0; msp = msp + 1; } // unbound, or callable in value position
            mfp = mfp - 1;
          } else if (k === lN_CALLV) {
            // call a LAMBDA held in a binding; callee resolves at call time,
            // which is what makes LET self-reference (recursion) work
            const nameN = mNa[n] + 0;
            const nid = mNa[nameN] + 0;
            let b = mBindTop;
            let found = -1;
            while (b > mBindBase) {
              b = b - 1;
              if (lBindName[b] === nid) { found = b; b = mBindBase; }
            }
            let bad = 0;
            let closure = -1;
            if (found < 0 || lBindKind[found] !== 1) bad = 1;
            else {
              closure = lBindVal[found] + 0;
              if (mNk[closure] !== lN_CALL || mNa[closure] !== lF_LAMBDA) bad = 1;
            }
            if (bad === 1 || mCallDepth >= lDepthCap) {
              mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1;
            } else {
              const pcount = mNval[closure] + 0;
              let acount = 0;
              let cc = mNb[n];
              while (cc >= 0) { acount = acount + 1; cc = mNsib[cc]; }
              if (acount !== pcount || mBindTop + pcount > lBindMax) {
                mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1;
              } else {
                mCallDepth = mCallDepth + 1;
                mTag[mfp] = lFT_CALL; mA[mfp] = closure;
                mB[mfp] = 0; // state: expect argument
                mC[mfp] = mNb[n]; // first arg
                mD[mfp] = pcount;
                mE[mfp] = -1;
                mF[mfp] = pcount;
              }
            }
          } else { mVstk[msp] = 0 / 0; msp = msp + 1; mfp = mfp - 1; } // N_RANGE in scalar ctx / unknown
        } else if (tag === lFT_AGR) {
          // one range of an open aggregate. Counted for-loops (scriptc
          // loop-versions them: per-access integrality/bounds checks drop out)
          // with the gg registers hoisted to f64 locals; pause (push frames)
          // only when a formula cell needs evaluation, saving resume state in
          // mB/mC. Nested aggregates restore our registers via their own
          // mSave frame. Ranges are parser-normalized (r1<=r2, c1<=c2).
          let paused = 0;
          const d0 = mD[mfp];
          const d1 = mE[mfp];
          const endAll = mF[mfp];
          let a0 = mGg[0]; let a1 = mGg[1]; let a2 = mGg[2]; let a3 = mGg[3]; let a4 = mGg[4]; let a5 = mGg[5];
          if (!(d0 < d1) && !(d1 < d0)) { // == without `===`: f64 load-vs-load `===` boxes both operands (Scratch value), parser guarantees integer corners
            // single column: one stride-NCOLS counted loop over rows
            for (let cur = mB[mfp] + mC[mfp]; cur <= endAll; cur = cur + mNCOLS) {
              const ci = cur | 0;
              if (mKinds[ci] === 2 && mComputed[ci] === 0 && mVisiting[ci] === 0) {
                mB[mfp] = cur - d0; mC[mfp] = d0; // resume at this same cell
                lCtxSave[mCtxTop] = mBindBase;
                mCtxTop = mCtxTop + 1;
                mBindBase = mBindTop;
                mVisiting[ci] = 1;
                mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = ci;
                mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[ci];
                paused = 1;
                break;
              }
              if (mKinds[ci] !== 0) { // inline accOne — `+ 0` launders the load to raw f64
                const av = mVals[ci] + 0;
                a0 = a0 + av;
                a1 = a1 + 1;
                a4 = a4 * av;
                a5 = a5 + 1;
                if (a1 === 1 || av < a2) a2 = av;
                if (a1 === 1 || av > a3) a3 = av;
              }
            }
          } else {
            // multi-column: rows outer (few), per-row counted col loop
            let rb = mB[mfp];
            const lastBase = endAll - d1;
            let cc = mC[mfp];
            while (paused === 0) {
              const rowEnd = rb + d1;
              for (let cur = rb + cc; cur <= rowEnd; cur = cur + 1) {
                const ci = cur | 0;
                if (mKinds[ci] === 2 && mComputed[ci] === 0 && mVisiting[ci] === 0) {
                  mB[mfp] = rb; mC[mfp] = cur - rb; // resume at this same cell
                  lCtxSave[mCtxTop] = mBindBase;
                  mCtxTop = mCtxTop + 1;
                  mBindBase = mBindTop;
                  mVisiting[ci] = 1;
                  mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = ci;
                  mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[ci];
                  paused = 1;
                  break;
                }
                if (mKinds[ci] !== 0) {
                  const av = mVals[ci] + 0;
                  a0 = a0 + av;
                  a1 = a1 + 1;
                  a4 = a4 * av;
                  a5 = a5 + 1;
                  if (a1 === 1 || av < a2) a2 = av;
                  if (a1 === 1 || av > a3) a3 = av;
                }
              }
              if (paused === 1) break;
              if (rb === lastBase) break; // range exhausted
              rb = rb + mNCOLS;
              cc = d0;
            }
          }
          mGg[0] = a0; mGg[1] = a1; mGg[2] = a2; mGg[3] = a3; mGg[4] = a4; mGg[5] = a5;
          if (paused === 0) mfp = mfp - 1; // range exhausted -> pop frame
        } else if (tag === lFT_CELL) {
          const ci = mA[mfp] + 0;
          mVals[ci] = mVstk[msp - 1];
          mComputed[ci] = 1;
          mVisiting[ci] = 0;
          mCtxTop = mCtxTop - 1; // this cell's context closes; restore the caller's floor
          mBindBase = lCtxSave[mCtxTop] + 0;
          msp = msp - 1;
          mfp = mfp - 1;
        } else if (tag === lFT_BIN) {
          const bk = mA[mfp];
          const bv = mVstk[msp - 1] + 0;
          const av = mVstk[msp - 2] + 0;
          msp = msp - 2;
          let rv = 0 / 0;
          if (bk === lN_ADD) rv = av + bv;
          else if (bk === lN_MUL) rv = av * bv;
          else if (bk === lN_SUB) rv = av - bv;
          else if (bk === lN_DIV) rv = av / bv;
          else if (bk === lN_POW) { // inline intPow
            let pn = bv - (bv % 1);
            if ((bv % 1) < 0) pn = pn - 1;
            const pneg = pn < 0;
            if (pneg) pn = -pn;
            let pr = 1;
            let pi = 0;
            while (pi < pn) { pr = pr * av; pi = pi + 1; }
            rv = pneg ? 1 / pr : pr;
          } else {
            // comparisons: error operands -> NaN (matches evalNode)
            const bad = (av !== av || av > 100000000000000000000000000000000000000 || av < -100000000000000000000000000000000000000) ||
              (bv !== bv || bv > 100000000000000000000000000000000000000 || bv < -100000000000000000000000000000000000000);
            if (bad) rv = 0 / 0;
            else if (bk === lN_LT) rv = av < bv ? 1 : 0;
            else if (bk === N_GT) rv = av > bv ? 1 : 0;
            else if (bk === N_LE) rv = av <= bv ? 1 : 0;
            else if (bk === N_GE) rv = av >= bv ? 1 : 0;
            else if (bk === N_EQ) rv = av === bv ? 1 : 0;
            else rv = av !== bv ? 1 : 0;
          }
          mVstk[msp] = rv;
          msp = msp + 1;
          mfp = mfp - 1;
        } else if (tag === lFT_ASC) {
          // aggregate scalar arg: the lFT_NODE above produced one value — accumulate it
          const sv = mVstk[msp - 1] + 0;
          msp = msp - 1;
          mGg[0] = mGg[0] + sv;
          mGg[1] = mGg[1] + 1;
          mGg[4] = mGg[4] * sv;
          mGg[5] = mGg[5] + 1;
          if (mGg[1] === 1 || sv < mGg[2]) mGg[2] = sv;
          if (mGg[1] === 1 || sv > mGg[3]) mGg[3] = sv;
          mfp = mfp - 1;
        } else if (tag === lFT_APPLY) {
          const fid = mA[mfp];
          const argc = mB[mfp];
          if (argc === -2) { // >16 args on a fixed-arity function: NaN
            msp = msp - mC[mfp];
            mVstk[msp] = 0 / 0;
            msp = msp + 1;
          } else {
            const v0 = (argc >= 1 ? mVstk[msp - argc] : 0 / 0) + 0;
            const v1 = (argc >= 2 ? mVstk[msp - argc + 1] : 0 / 0) + 0;
            const v2 = (argc >= 3 ? mVstk[msp - argc + 2] : 0 / 0) + 0;
            let res = 0 / 0;
            if (fid === lF_IF) {
              if (argc >= 1) {
                if (v0 !== v0 || v0 > 100000000000000000000000000000000000000 || v0 < -100000000000000000000000000000000000000) res = 0 / 0;
                else if (v0 !== 0) res = argc >= 2 ? v1 : 0 / 0;
                else res = argc >= 3 ? v2 : 0;
              }
            } else if (fid === lF_IFERROR) {
              if (argc >= 1) {
                if (!(v0 !== v0 || v0 > 100000000000000000000000000000000000000 || v0 < -100000000000000000000000000000000000000)) res = v0;
                else res = argc >= 2 ? v1 : 0 / 0;
              }
            } else if (fid === lF_AND || fid === lF_OR) {
              let acc2 = fid === lF_AND ? 1 : 0;
              let bad2 = 0;
              let j2 = 0;
              while (j2 < argc) {
                const vv = mVstk[msp - argc + j2];
                if (vv !== vv || vv > 100000000000000000000000000000000000000 || vv < -100000000000000000000000000000000000000) { bad2 = 1; j2 = argc; }
                else {
                  if (fid === lF_AND) { if (vv === 0) acc2 = 0; }
                  else { if (vv !== 0) acc2 = 1; }
                  j2 = j2 + 1;
                }
              }
              res = bad2 ? 0 / 0 : acc2;
            } else if (fid === lF_NOT) {
              if (argc >= 1) res = (v0 !== v0 || v0 > 100000000000000000000000000000000000000 || v0 < -100000000000000000000000000000000000000) ? 0 / 0 : (v0 === 0 ? 1 : 0);
            } else if (fid === lF_ABS) {
              if (argc >= 1) res = v0 < 0 ? -v0 : v0;
            } else if (fid === lF_SIGN) {
              if (argc >= 1) res = (v0 !== v0 || v0 > 100000000000000000000000000000000000000 || v0 < -100000000000000000000000000000000000000) ? v0 : (v0 > 0 ? 1 : (v0 < 0 ? -1 : 0));
            } else if (fid === lF_INT) {
              if (argc >= 1) { const t0 = v0 % 1; const f0 = v0 - t0; res = t0 < 0 ? f0 - 1 : f0; }
            } else if (fid === lF_SQRT) { // inline newtonSqrt
              if (argc >= 1) {
                if (v0 < 0) res = 0 / 0;
                else if (v0 === 0) res = 0;
                else {
                  let g = v0;
                  let q = 0;
                  while (q < 40) { g = (g + v0 / g) / 2; q = q + 1; }
                  res = g;
                }
              }
            } else if (fid === lF_ROUND) {
              if (argc >= 1) {
                if (v0 !== v0 || v0 > 100000000000000000000000000000000000000 || v0 < -100000000000000000000000000000000000000) res = v0;
                else {
                  let d = 0;
                  if (argc >= 2) { const t1 = v1 % 1; const f1 = v1 - t1; d = t1 < 0 ? f1 - 1 : f1; }
                  const dd = d < 0 ? -d : d;
                  let sc = 1;
                  let q = 0;
                  while (q < dd) { sc = sc * 10; q = q + 1; }
                  const ax = (v0 < 0 ? -v0 : v0) * sc;
                  let r = ax + 0.5;
                  const t2 = r % 1;
                  const f2 = r - t2;
                  r = t2 < 0 ? f2 - 1 : f2;
                  if (v0 < 0) r = -r;
                  res = r / sc;
                }
              }
            } else if (fid === lF_MOD) {
              if (argc >= 2) {
                if (v1 === 0) res = 0 / 0;
                else {
                  const mq = v0 / v1;
                  const mt = mq % 1;
                  const mf = mq - mt;
                  const mfl = mt < 0 ? mf - 1 : mf; // myFloor
                  res = v0 - v1 * mfl;
                }
              }
            } else if (fid === lF_POWER) {
              if (argc >= 2) { // inline intPow(v0, v1)
                let pn = v1 - (v1 % 1);
                if ((v1 % 1) < 0) pn = pn - 1;
                const pneg = pn < 0;
                if (pneg) pn = -pn;
                let pr = 1;
                let pi = 0;
                while (pi < pn) { pr = pr * v0; pi = pi + 1; }
                res = pneg ? 1 / pr : pr;
              }
            } else if (fid === lF_FLOOR || fid === lF_CEIL) {
              if (argc >= 1) {
                const sig = argc >= 2 ? v1 : 1;
                if (sig === 0) res = 0 / 0;
                else {
                  const q = v0 / sig;
                  const tq = q % 1;
                  const fq = q - tq;
                  const fl = tq < 0 ? fq - 1 : fq; // myFloor(q)
                  // CEIL = -myFloor(-q)
                  const nq = -q;
                  const tn = nq % 1;
                  const fn = nq - tn;
                  const fln = tn < 0 ? fn - 1 : fn; // myFloor(-q)
                  res = (fid === lF_FLOOR ? fl : -fln) * sig;
                }
              }
            }
            msp = msp - argc;
            mVstk[msp] = res;
            msp = msp + 1;
          }
          mfp = mfp - 1;
        } else if (tag === lFT_AGG) {
          const fid = mA[mfp];
          const cur2 = mB[mfp];
          if (cur2 < 0) {
            // finalize: compute result, restore outer registers
            if (fid === lF_SUM) mVstk[msp] = mGg[0];
            else if (fid === lF_AVERAGE) mVstk[msp] = mGg[1] === 0 ? 0 / 0 : mGg[0] / mGg[1];
            else if (fid === lF_COUNT || fid === lF_COUNTA) mVstk[msp] = mGg[1];
            else if (fid === lF_MIN) mVstk[msp] = mGg[1] === 0 ? 0 : mGg[2];
            else if (fid === lF_MAX) mVstk[msp] = mGg[1] === 0 ? 0 : mGg[3];
            else mVstk[msp] = mGg[5] === 0 ? 0 : mGg[4]; // lF_PRODUCT
            msp = msp + 1;
            mAggTop = mAggTop - 7;
            mGg[0] = mSave[mAggTop]; mGg[1] = mSave[mAggTop + 1]; mGg[2] = mSave[mAggTop + 2];
            mGg[3] = mSave[mAggTop + 3]; mGg[4] = mSave[mAggTop + 4]; mGg[5] = mSave[mAggTop + 5];
            mfp = mfp - 1;
          } else {
            mB[mfp] = mNsib[cur2]; // advance before descending (we may pause here a long time)
            if (mNk[cur2] === N_RANGE) {
              const ra = mNa[cur2];
              const rb = mNb[cur2];
              const qa = ra / mNCOLS;
              const ta = qa % 1;
              const r1 = (qa - ta) - (ta < 0 ? 1 : 0); // floor(qa)
              const qb = rb / mNCOLS;
              const tb = qb % 1;
              const r2 = (qb - tb) - (tb < 0 ? 1 : 0); // floor(qb)
              const c1 = ra - r1 * mNCOLS;
              const c2 = rb - r2 * mNCOLS;
              mfp = mfp + 1;
              mTag[mfp] = lFT_AGR;
              mB[mfp] = r1 * mNCOLS; // base
              mC[mfp] = c1; // col cursor
              mD[mfp] = c1; // first col
              mE[mfp] = c2; // last col
              mF[mfp] = r2 * mNCOLS + c2; // end idx
            } else {
              mfp = mfp + 1; mTag[mfp] = lFT_ASC;
              mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = cur2;
            }
          }
        } else if (tag === lFT_PUSHV) {
          mVstk[msp] = mVals[mA[mfp]];
          msp = msp + 1;
          mfp = mfp - 1;
        } else if (tag === lFT_NEG) {
          mVstk[msp - 1] = -mVstk[msp - 1];
          mfp = mfp - 1;
        } else if (tag === lFT_LET) {
          // states: 0 expect (name,value) pairs · 1 bind computed value · 2 body done
          let st = mB[mfp] + 0;
          if (st === 1) {
            lBindName[mBindTop] = mE[mfp];
            lBindVal[mBindTop] = mVstk[msp - 1] + 0;
            lBindKind[mBindTop] = 0;
            mBindTop = mBindTop + 1;
            msp = msp - 1;
            mD[mfp] = mD[mfp] - 1;
            mC[mfp] = mNsib[mC[mfp]] + 0; // step past the value expr
            st = 0;
          } else if (st === 2) {
            // body value on the stack top: it is the LET result
            mBindTop = mBindTop - (mF[mfp] + 0);
            mfp = mfp - 1;
            st = 3;
          }
          if (st === 0) {
            while (true) {
              if (mD[mfp] === 0) {
                mB[mfp] = 2; // all pairs bound; mC is the body
                const body = mC[mfp] + 0; // read BEFORE fp++ (ftC of the new slot is garbage)
                mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = body;
                break;
              }
              const nameN = mC[mfp] + 0;
              const nid = mNa[nameN] + 0;
              const vnode = mNsib[nameN] + 0;
              if (mNk[vnode] === lN_CALL && mNa[vnode] === lF_LAMBDA) {
                // direct-bind the closure — callables never ride the value stack
                lBindName[mBindTop] = nid;
                lBindVal[mBindTop] = vnode + 0;
                lBindKind[mBindTop] = 1;
                mBindTop = mBindTop + 1;
                mC[mfp] = mNsib[vnode] + 0;
                mD[mfp] = mD[mfp] - 1;
                continue;
              }
              mE[mfp] = nid;
              mC[mfp] = vnode;
              mB[mfp] = 1;
              mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = vnode;
              break;
            }
          }
        } else if (tag === lFT_CALL) {
          // states: 0 expect args · 1 bind computed arg · 2 body done
          let st = mB[mfp] + 0;
          if (st === 1) {
            lBindName[mBindTop] = mE[mfp];
            lBindVal[mBindTop] = mVstk[msp - 1] + 0;
            lBindKind[mBindTop] = 0;
            mBindTop = mBindTop + 1;
            msp = msp - 1;
            mD[mfp] = mD[mfp] - 1;
            mC[mfp] = mNsib[mC[mfp]] + 0; // step past this arg
            st = 0;
          } else if (st === 2) {
            // body value on the stack top: it is the call result
            mBindTop = mBindTop - (mF[mfp] + 0);
            mCallDepth = mCallDepth - 1;
            mfp = mfp - 1;
            st = 3;
          }
          if (st === 0) {
            while (true) {
              if (mD[mfp] === 0) {
                // all params bound: evaluate the closure body (last chain child)
                let bb = mNb[mA[mfp]] + 0;
                let q = mF[mfp] + 0;
                while (q > 0) { bb = mNsib[bb] + 0; q = q - 1; }
                mB[mfp] = 2;
                mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = bb;
                break;
              }
              const argN = mC[mfp] + 0;
              let pp = mNb[mA[mfp]] + 0; // param name sits at position total-left
              let q2 = (mF[mfp] - mD[mfp]) + 0;
              while (q2 > 0) { pp = mNsib[pp] + 0; q2 = q2 - 1; }
              const nid = mNa[pp] + 0;
              if (mNk[argN] === lN_CALL && mNa[argN] === lF_LAMBDA) {
                // direct-bind a lambda argument to the parameter
                lBindName[mBindTop] = nid;
                lBindVal[mBindTop] = argN + 0;
                lBindKind[mBindTop] = 1;
                mBindTop = mBindTop + 1;
                mC[mfp] = mNsib[argN] + 0;
                mD[mfp] = mD[mfp] - 1;
                continue;
              }
              mE[mfp] = nid;
              mB[mfp] = 1;
              mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = argN;
              break;
            }
          }
        } else if (tag === lFT_SP2) {
          // SUMPRODUCT ranges exhausted: gg[0] holds the product-sum
          mVstk[msp] = mGg[0];
          msp = msp + 1;
          mAggTop = mAggTop - 7;
          mGg[0] = mSave[mAggTop]; mGg[1] = mSave[mAggTop + 1]; mGg[2] = mSave[mAggTop + 2];
          mGg[3] = mSave[mAggTop + 3]; mGg[4] = mSave[mAggTop + 4]; mGg[5] = mSave[mAggTop + 5];
          mfp = mfp - 1;
        } else if (tag === lFT_AGR2) {
          // one lockstep pass over two same-shape ranges (cur2 = cur1 + delta).
          // Counted loops like FT_AGR; pause only when a covered formula cell
          // needs evaluation (range1's cell first, then range2's). Empty cells
          // act as 0, so a product over them contributes nothing.
          let paused = 0;
          const d0 = mE[mfp];
          const d1 = mA[mfp];
          const endAll = mF[mfp];
          const delta = mD[mfp] + 0;
          let a0 = mGg[0] + 0;
          if (!(d0 < d1) && !(d1 < d0)) { // == without `===` (Scratch boxing, see FT_AGR)
            // single column: stride-NCOLS counted loop over rows
            for (let cur = mB[mfp] + mC[mfp]; cur <= endAll; cur = cur + mNCOLS) {
              const cur2 = cur + delta;
              if (mKinds[cur] === 2 && mComputed[cur] === 0 && mVisiting[cur] === 0) {
                mB[mfp] = cur - d0; mC[mfp] = d0; // resume at this same cell
                lCtxSave[mCtxTop] = mBindBase;
                mCtxTop = mCtxTop + 1;
                mBindBase = mBindTop;
                mVisiting[cur] = 1;
                mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = cur;
                mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[cur];
                paused = 1;
                break;
              }
              if (mKinds[cur2] === 2 && mComputed[cur2] === 0 && mVisiting[cur2] === 0) {
                mB[mfp] = cur - d0; mC[mfp] = d0; // resume at this same cell
                lCtxSave[mCtxTop] = mBindBase;
                mCtxTop = mCtxTop + 1;
                mBindBase = mBindTop;
                mVisiting[cur2] = 1;
                mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = cur2;
                mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[cur2];
                paused = 1;
                break;
              }
              const v1 = mKinds[cur] === 0 ? 0 : mVals[cur] + 0;
              const v2 = mKinds[cur2] === 0 ? 0 : mVals[cur2] + 0;
              a0 = a0 + v1 * v2;
            }
          } else {
            // multi-column: rows outer, per-row counted col loop
            let rb = mB[mfp] + 0;
            const lastBase = endAll - d1;
            let cc = mC[mfp] + 0;
            while (paused === 0) {
              const rowEnd = rb + d1;
              for (let cur = rb + cc; cur <= rowEnd; cur = cur + 1) {
                const cur2 = cur + delta;
                if (mKinds[cur] === 2 && mComputed[cur] === 0 && mVisiting[cur] === 0) {
                  mB[mfp] = rb; mC[mfp] = cur - rb; // resume at this same cell
                  lCtxSave[mCtxTop] = mBindBase;
                  mCtxTop = mCtxTop + 1;
                  mBindBase = mBindTop;
                  mVisiting[cur] = 1;
                  mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = cur;
                  mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[cur];
                  paused = 1;
                  break;
                }
                if (mKinds[cur2] === 2 && mComputed[cur2] === 0 && mVisiting[cur2] === 0) {
                  mB[mfp] = rb; mC[mfp] = cur - rb; // resume at this same cell
                  lCtxSave[mCtxTop] = mBindBase;
                  mCtxTop = mCtxTop + 1;
                  mBindBase = mBindTop;
                  mVisiting[cur2] = 1;
                  mfp = mfp + 1; mTag[mfp] = lFT_CELL; mA[mfp] = cur2;
                  mfp = mfp + 1; mTag[mfp] = lFT_NODE; mA[mfp] = mRoot[cur2];
                  paused = 1;
                  break;
                }
                const v1 = mKinds[cur] === 0 ? 0 : mVals[cur] + 0;
                const v2 = mKinds[cur2] === 0 ? 0 : mVals[cur2] + 0;
                a0 = a0 + v1 * v2;
              }
              if (paused === 1) break;
              if (rb === lastBase) break; // range exhausted
              rb = rb + mNCOLS;
              cc = d0;
            }
          }
          mGg[0] = a0;
          if (paused === 0) mfp = mfp - 1; // range exhausted -> pop frame
        }
      }
}

/** Full recalc; returns checksum (sum of finite values, deterministic order).
 *  The scan loops live HERE, in a small function — a giant body defeats loop
 *  versioning (§1-c/§1-d). runCell is far too big to inline back. */
export function wbRecalc(): number {
  const n = NCELLS;
  let scanFrom = 0;
  while (true) {
    const cell = scanFind(scanFrom, n);
    if (cell < 0) break;
    scanFrom = cell + 1;
    runCell(cell);
  }
  // checksum: ascending index — same summation order as the fused loop
  return scanChecksum(n);
}

/** M1: invalidate every formula + clear the dirty set (full-recalc entry). */
export function wbInvalidateAll(): number {
  let i = 0;
  const kc = kinds;
  const cc = computed;
  const df = dirtyFlag;
  const n = NCELLS;
  while (i < n) {
    if (kc[i] === 2) cc[i] = 0;
    df[i] = 0;
    i = i + 1;
  }
  dirtyCount = 0;
  return NCELLS;
}

/**
 * M1: recompute only the dirty closure (edited cells + transitive dependents).
 * Dirty formulas get computed=0; wbRecalc's demand-driven sweep then evaluates
 * exactly those (clean cells stay memoized), so results are bit-identical to a
 * full recalc while costing O(dirty set). Returns the full-book checksum.
 */
export function wbRecalcDirty(): number {
  let k = 0;
  const kc = kinds;
  const cc = computed;
  const df = dirtyFlag;
  const dl = dirtyList;
  while (k < dirtyCount) {
    const i = dl[k] + 0;
    if (kc[i] === 2) cc[i] = 0;
    df[i] = 0;
    k = k + 1;
  }
  dirtyCount = 0;
  return wbRecalc();
}

// ---------------- bench exports (boundary-free hot loops) ---------------------
// TEMP probes (delete after diagnosis): cost of boxed-global accumulator vs
// array-slot accumulator vs frame-array traffic, per iteration.

/// decompose the pure-scan cost: finder loop only vs checksum loop only (reps internal)
export function probeScanFind(reps: number): number {
  let acc = 0;
  for (let r = 0; r < reps; r = r + 1) acc = acc + (scanFind(0, NCELLS) + 1);
  return acc;
}
export function probeScanChecksum(reps: number): number {
  let acc = 0;
  for (let r = 0; r < reps; r = r + 1) acc = acc + scanChecksum(NCELLS);
  return acc;
}
/// checksum ablation: (a) bare f64 load+add, no fence
export function probeChkA(reps: number): number {
  let acc = 0;
  const v = vals;
  const n = NCELLS;
  for (let r = 0; r < reps; r = r + 1) {
    let sum = 0;
    for (let c2 = 0; c2 < n; c2 = c2 + 1) sum = sum + v[c2 | 0];
    acc = acc + sum;
  }
  return acc;
}
/// (b) fence + NaN, index pre-hoisted
export function probeChkB(reps: number): number {
  let acc = 0;
  const v = vals;
  const n = NCELLS;
  for (let r = 0; r < reps; r = r + 1) {
    let sum = 0;
    for (let c2 = 0; c2 < n; c2 = c2 + 1) {
      const ci = c2 | 0;
      const x = v[ci];
      if (x === x && x < 100000000000000000000000000000000000000 && x > -100000000000000000000000000000000000000) sum = sum + x;
    }
    acc = acc + sum;
  }
  return acc;
}
/// (c) u8-array load+add over kinds (same shape as the fast finder)
export function probeChkC(reps: number): number {
  let acc = 0;
  const v = kinds;
  const n = NCELLS;
  for (let r = 0; r < reps; r = r + 1) {
    let sum = 0;
    for (let c2 = 0; c2 < n; c2 = c2 + 1) {
      const ci = c2 | 0;
      const x = v[ci];
      if (x === x && x < 100000000000000000000000000000000000000 && x > -100000000000000000000000000000000000000) sum = sum + x;
    }
    acc = acc + sum;
  }
  return acc;
}
/// (d) fence with RELOAD per use (no named multi-use value)
export function probeChkD(reps: number): number {
  let acc = 0;
  const v = vals;
  const n = NCELLS;
  const HI = 100000000000000000000000000000000000000;
  const LO = -100000000000000000000000000000000000000;
  for (let r = 0; r < reps; r = r + 1) {
    let sum = 0;
    for (let c2 = 0; c2 < n; c2 = c2 + 1) {
      const ci = c2 | 0;
      if (v[ci] === v[ci] && v[ci] < HI && v[ci] > LO) sum = sum + v[ci];
    }
    acc = acc + sum;
  }
  return acc;
}
/// (e) single compare only (no && chain, no NaN self-test)
export function probeChkE(reps: number): number {
  let acc = 0;
  const v = vals;
  const n = NCELLS;
  const HI = 100000000000000000000000000000000000000;
  for (let r = 0; r < reps; r = r + 1) {
    let sum = 0;
    for (let c2 = 0; c2 < n; c2 = c2 + 1) {
      const ci = c2 | 0;
      if (v[ci] < HI) sum = sum + v[ci];
    }
    acc = acc + sum;
  }
  return acc;
}
export function probeAccGlobal(n: number): number {
  let i = 0;
  while (i < n) {
    g_sum = g_sum + 1;
    g_cnt = g_cnt + 1;
    g_psum = g_psum * 1.0000001;
    g_pcnt = g_pcnt + 1;
    if (g_cnt === 1 || 1 < g_min) g_min = 1;
    if (g_cnt === 1 || 1 > g_max) g_max = 1;
    i = i + 1;
  }
  return g_sum + g_cnt;
}
export function probeAccArray(n: number): number {
  let i = 0;
  while (i < n) {
    aggSave[0] = aggSave[0] + 1;
    aggSave[1] = aggSave[1] + 1;
    aggSave[2] = aggSave[2] * 1.0000001;
    aggSave[3] = aggSave[3] + 1;
    aggSave[4] = 1;
    aggSave[5] = 1;
    i = i + 1;
  }
  return aggSave[0];
}
export function probeFrames(n: number): number {
  // simulate machine hot-path frame traffic: 3 reads + 2 writes on ft arrays
  let acc = 0;
  let i = 0;
  while (i < n) {
    const f = i % 65536;
    const t = ftTag[f];
    const b = ftB[f];
    const c = ftC[f];
    ftB[f] = b + c;
    ftC[f] = t;
    acc = acc + b;
    i = i + 1;
  }
  return acc;
}
export function probeLoadDirect(n: number): number {
  // alternating-index load feeding arithmetic (defeats LICM)
  let acc = 0;
  let i = 0;
  while (i < n) { acc = acc + aggSave[i % 2]; i = i + 1; }
  return acc;
}
export function probeLoadLocal(n: number): number {
  // alternating-index load stored to local first
  let acc = 0;
  let i = 0;
  while (i < n) { const x = aggSave[i % 2]; acc = acc + x; i = i + 1; }
  return acc;
}
export function probeLoadCmp(n: number): number {
  // alternating ternary over two loads (tests union-boxing of ?: results)
  let acc = 0;
  let i = 0;
  while (i < n) { const x = i % 2 === 0 ? aggSave[0] : aggSave[1]; acc = acc + x; i = i + 1; }
  return acc;
}
export function probeMachineNode(n: number): number {
  // replicate the machine's FT_NODE/N_REF fast path shape exactly
  // (arrays seeded so the hot branch actually executes)
  let z = 0;
  while (z < 65536) {
    ftTag[z] = 1; ftA[z] = z; ndKind[z] = 2; ndA[z] = z; kinds[z] = 1; vals[z] = z;
    z = z + 1;
  }
  let acc = 0;
  let i = 0;
  while (i < n) {
    const tag = ftTag[i % 65536];
    if (tag === 1) {
      const nd = ftA[i % 65536];
      const k = ndKind[nd % 524288];
      if (k === 2) {
        const idx2 = ndA[nd % 524288] + 0;
        const kk = kinds[idx2 % 262144];
        if (kk === 1 || kk === 2) { vstk[i % 65536] = vals[idx2 % 262144]; acc = acc + 1; }
        else if (kk !== 2) { acc = acc + kk; }
      } else if (k === 4) { acc = acc + 2; }
    }
    i = i + 1;
  }
  return acc;
}
/** Parse `formula` `times`× into the pooled arena (reset per iter). */
export function benchParse(times: number, formula: Uint8Array): number {
  let i = 0;
  while (i < times) {
    const nt = tokenize(formula, formula.length);
    if (nt < 0) return -1;
    tc = 0;
    const root = parseFormula();
    if (root < 0) return -2;
    parseSink = root;
    astCount = 0; // pool reset (R4)
    nameCount = 0;
    nameBytesTop = 0;
    i = i + 1;
  }
  return times;
}

/**
 * Build a deterministic synthetic workbook of `nCells` cells (1000 cols wide):
 * 60% numbers, 40% formulas in 5 variants (SUM/IF/AVERAGE/ROUND∘SQRT/MAX-MIN
 * over backward ranges) — direct AST construction, no parse cost included.
 */
export function benchBuildVariant(variant: number, nCells: number): number {
  const cols = 1000;
  const rows = myFloor((nCells + cols - 1) / cols);
  wbInit(rows, cols);
  let i = 0;
  while (i < NCELLS) {
    if (variant >= 0 && i % 10 >= 6) {
      // force this variant for every formula slot
      const r = myFloor(i / NCOLS);
      let root = -1;
      if (variant === 1) {
        root = newNode(N_CALL);
        ndA[root] = F_IF;
        const cmp = newNode(N_GT);
        const pv = newNode(N_REF); ndA[pv] = i - 1;
        const lit = newNode(N_NUM); ndVal[lit] = 50;
        ndA[cmp] = pv; ndB[cmp] = lit;
        const mul = newNode(N_MUL);
        const pv2 = newNode(N_REF); ndA[pv2] = i - 1;
        const two = newNode(N_NUM); ndVal[two] = 2;
        ndA[mul] = pv2; ndB[mul] = two;
        const div = newNode(N_DIV);
        const pv3 = newNode(N_REF); ndA[pv3] = i - 1;
        const thr = newNode(N_NUM); ndVal[thr] = 3;
        ndA[div] = pv3; ndB[div] = thr;
        ndSib[cmp] = mul; ndSib[mul] = div;
        ndB[root] = cmp;
      } else if (variant === 2) {
        root = newNode(N_CALL);
        ndA[root] = F_AVERAGE;
        const rg = newNode(N_RANGE);
        const top = r - 10 < 0 ? 0 : r - 10;
        if (r === top) { i = i + 1; continue; }
        ndA[rg] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[root] = rg;
      } else if (variant === 3) {
        root = newNode(N_CALL);
        ndA[root] = F_ROUND;
        const sq = newNode(N_CALL);
        ndA[sq] = F_SQRT;
        const add = newNode(N_ADD);
        const mul = newNode(N_MUL);
        const p7 = newNode(N_REF); ndA[p7] = i - 7 < 0 ? i : i - 7;
        const p3 = newNode(N_REF); ndA[p3] = i - 3 < 0 ? i : i - 3;
        ndA[mul] = p7; ndB[mul] = p3;
        const one = newNode(N_NUM); ndVal[one] = 1;
        ndA[add] = mul; ndB[add] = one;
        ndB[sq] = add;
        const d = newNode(N_NUM); ndVal[d] = 2;
        ndSib[sq] = d;
        ndB[root] = sq;
      } else if (variant === 4) {
        const top = r - 15 < 0 ? 0 : r - 15;
        if (r === top) { i = i + 1; continue; }
        root = newNode(N_SUB);
        const mx = newNode(N_CALL);
        ndA[mx] = F_MAX;
        const rg1 = newNode(N_RANGE);
        ndA[rg1] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg1] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[mx] = rg1;
        const mn = newNode(N_CALL);
        ndA[mn] = F_MIN;
        const rg2 = newNode(N_RANGE);
        ndA[rg2] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg2] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[mn] = rg2;
        const div = newNode(N_DIV);
        const two = newNode(N_NUM); ndVal[two] = 2;
        ndA[div] = mn; ndB[div] = two;
        ndA[root] = mx; ndB[root] = div;
      } else {
        const top = r - 20 < 0 ? 0 : r - 20;
        if (r === top) { i = i + 1; continue; }
        root = newNode(N_CALL);
        ndA[root] = F_SUM;
        const rg = newNode(N_RANGE);
        ndA[rg] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[root] = rg;
      }
      kinds[i] = 2;
      astRoot[i] = root;
      computed[i] = 0;
      addCellDeps(i, root);
    } else {
      wbSetNumber(i, lcgNext());
    }
    i = i + 1;
  }
  return NCELLS;
}

export function benchBuild(nCells: number): number {
  const cols = 1000;
  const rows = myFloor((nCells + cols - 1) / cols);
  wbInit(rows, cols);
  let i = 0;
  while (i < NCELLS) {
    if (i % 10 < 6) {
      wbSetNumber(i, lcgNext());
    } else {
      const v = i % 5;
      const r = myFloor(i / NCOLS);
      let root = -1;
      if (v === 0) {
        // SUM over up to 20 rows above in the same column
        const top = r - 20 < 0 ? 0 : r - 20;
        if (r === top) {
          wbSetNumber(i, lcgNext());
          i = i + 1;
          continue;
        }
        root = newNode(N_CALL);
        ndA[root] = F_SUM;
        const rg = newNode(N_RANGE);
        ndA[rg] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[root] = rg;
      } else if (v === 1) {
        // IF(prev > 50, prev*2, prev/3)
        root = newNode(N_CALL);
        ndA[root] = F_IF;
        const cmp = newNode(N_GT);
        const pv = newNode(N_REF); ndA[pv] = i - 1;
        const lit = newNode(N_NUM); ndVal[lit] = 50;
        ndA[cmp] = pv; ndB[cmp] = lit;
        const mul = newNode(N_MUL);
        const pv2 = newNode(N_REF); ndA[pv2] = i - 1;
        const two = newNode(N_NUM); ndVal[two] = 2;
        ndA[mul] = pv2; ndB[mul] = two;
        const div = newNode(N_DIV);
        const pv3 = newNode(N_REF); ndA[pv3] = i - 1;
        const thr = newNode(N_NUM); ndVal[thr] = 3;
        ndA[div] = pv3; ndB[div] = thr;
        ndSib[cmp] = mul; ndSib[mul] = div;
        ndB[root] = cmp;
      } else if (v === 2) {
        // AVERAGE over up to 10 rows above in the same column
        const top = r - 10 < 0 ? 0 : r - 10;
        if (r === top) {
          wbSetNumber(i, lcgNext());
          i = i + 1;
          continue;
        }
        root = newNode(N_CALL);
        ndA[root] = F_AVERAGE;
        const rg = newNode(N_RANGE);
        ndA[rg] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[root] = rg;
      } else if (v === 3) {
        // ROUND(SQRT(prev7*prev3+1), 2)
        root = newNode(N_CALL);
        ndA[root] = F_ROUND;
        const sq = newNode(N_CALL);
        ndA[sq] = F_SQRT;
        const add = newNode(N_ADD);
        const mul = newNode(N_MUL);
        const p7 = newNode(N_REF); ndA[p7] = i - 7 < 0 ? i : i - 7;
        const p3 = newNode(N_REF); ndA[p3] = i - 3 < 0 ? i : i - 3;
        ndA[mul] = p7; ndB[mul] = p3;
        const one = newNode(N_NUM); ndVal[one] = 1;
        ndA[add] = mul; ndB[add] = one;
        ndB[sq] = add;
        const d = newNode(N_NUM); ndVal[d] = 2;
        ndSib[sq] = d;
        ndB[root] = sq;
      } else {
        // MAX(range15) - MIN(range15)/2
        const top = r - 15 < 0 ? 0 : r - 15;
        if (r === top) {
          wbSetNumber(i, lcgNext());
          i = i + 1;
          continue;
        }
        root = newNode(N_SUB);
        const mx = newNode(N_CALL);
        ndA[mx] = F_MAX;
        const rg1 = newNode(N_RANGE);
        ndA[rg1] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg1] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[mx] = rg1;
        const mn = newNode(N_CALL);
        ndA[mn] = F_MIN;
        const rg2 = newNode(N_RANGE);
        ndA[rg2] = cellIdx(top + 1, (i - r * NCOLS) + 1);
        ndB[rg2] = cellIdx(r, (i - r * NCOLS) + 1);
        ndB[mn] = rg2;
        const div = newNode(N_DIV);
        const two = newNode(N_NUM); ndVal[two] = 2;
        ndA[div] = mn; ndB[div] = two;
        ndA[root] = mx; ndB[root] = div;
      }
      kinds[i] = 2;
      astRoot[i] = root;
      computed[i] = 0;
      addCellDeps(i, root);
    }
    i = i + 1;
  }
  return NCELLS;
}

/** `times`× full invalidation + recalc; returns accumulated checksum. */
export function benchRecalc(times: number): number {
  let k = 0;
  while (k < dirtyCount) { dirtyFlag[dirtyList[k] + 0] = 0; k = k + 1; }
  dirtyCount = 0;
  let acc = 0;
  let t = 0;
  while (t < times) {
    let i = 0;
    while (i < NCELLS) {
      if (kinds[i] === 2) computed[i] = 0;
      i = i + 1;
    }
    acc = acc + wbRecalc();
    t = t + 1;
  }
  return acc;
}

/** M1 bench: alternate single-number edits (two cells, fresh values each call,
 *  LICM-safe) + incremental recalc of the dirty closure. */
export function benchRecalcDirty(times: number): number {
  if (NCELLS <= 1005) return -1;
  let acc = 0;
  let t = 0;
  while (t < times) {
    if (t % 2 === 0) wbSetNumber(5, 1000 + t);
    else wbSetNumber(1005, 2000 + t);
    acc = acc + wbRecalcDirty();
    t = t + 1;
  }
  return acc;
}

// ---- temporary debug exports ----
export function dbgRect(row1: number, col1: number, row2: number, col2: number): number {
  const a = cellIdx(row1, col1);
  const b = cellIdx(row2, col2);
  const r1 = myFloor(a / NCOLS);
  const c1 = a - r1 * NCOLS;
  const r2 = myFloor(b / NCOLS);
  const c2 = b - r2 * NCOLS;
  return r1 * 1000000 + c1 * 10000 + r2 * 100 + c2;
}
export function dbgCountRange(row1: number, col1: number, row2: number, col2: number): number {
  const a = cellIdx(row1, col1);
  const b = cellIdx(row2, col2);
  let n = 0;
  const r1 = myFloor(a / NCOLS);
  const c1 = a - r1 * NCOLS;
  const r2 = myFloor(b / NCOLS);
  const c2 = b - r2 * NCOLS;
  let rr = r1;
  while (rr <= r2) {
    const base = rr * NCOLS;
    let cc = c1;
    while (cc <= c2) {
      if (kinds[base + cc] !== 0) n = n + 1;
      cc = cc + 1;
    }
    rr = rr + 1;
  }
  return n;
}

/**
 * Verbatim copy of examples/calcium/twin.ts — the JS twin the Calcium wasm
 * engine races against. Do not edit by hand: scripts/sync-calcium.mjs
 * rewrites this file whenever the source twin changes, so the two stay
 * bit-exact (identical checksums are the demo's parity guarantee).
 */

// @ts-nocheck — vendored oracle, not site code: it targets the engine
// package's own toolchain (bun, no tsc), and its pre-TS5.7 Uint8Array
// typing does not match this tsconfig. Logic must remain byte-identical.

/**
 * Calcium JS twin — same algorithm as src/core.ts, plain idiomatic JS
 * (R6: identical algorithm, fair twin — this is what a perf-conscious JS
 * implementation of the same design looks like). Checksums must match the
 * wasm engine bit-for-bit (same evaluation order).
 */

export function createTwin() {
  let NROWS = 0;
  let NCOLS = 0;
  let NCELLS = 0;

  let vals = new Float64Array(0);
  let kinds = new Uint8Array(0);
  let astRoot = new Int32Array(0);
  let computed = new Uint8Array(0);
  let visiting = new Uint8Array(0);

  const TOK_MAX = 512;
  const tokKind = new Uint8Array(TOK_MAX);
  const tokNum = new Float64Array(TOK_MAX);
  const tokPos = new Int32Array(TOK_MAX);
  const tokLen = new Int32Array(TOK_MAX);
  let tokCount = 0;

  const AST_MAX = 1048576;
  const ndKind = new Uint8Array(AST_MAX);
  const ndA = new Int32Array(AST_MAX);
  const ndB = new Int32Array(AST_MAX);
  const ndSib = new Int32Array(AST_MAX);
  const ndVal = new Float64Array(AST_MAX);
  let astCount = 0;

  const T_END = 0, T_NUM = 1, T_CELL = 2, T_FUNC = 3, T_IDENT = 4,
    T_LP = 5, T_RP = 6, T_COMMA = 7, T_COLON = 8,
    T_PLUS = 9, T_MINUS = 10, T_STAR = 11, T_SLASH = 12, T_CARET = 13,
    T_LT = 14, T_GT = 15, T_LE = 16, T_GE = 17, T_EQ = 18, T_NE = 19;

  const N_NUM = 1, N_REF = 2, N_RANGE = 3, N_CALL = 4, N_NEG = 5,
    N_ADD = 6, N_SUB = 7, N_MUL = 8, N_DIV = 9, N_POW = 10,
    N_LT = 11, N_GT = 12, N_LE = 13, N_GE = 14, N_EQ = 15, N_NE = 16,
    N_NAME = 17, N_CALLV = 18; // M1: LET/LAMBDA name binding + variable call

  const F_SUM = 1, F_AVERAGE = 2, F_MIN = 3, F_MAX = 4, F_COUNT = 5,
    F_COUNTA = 6, F_IF = 7, F_IFERROR = 8, F_AND = 9, F_OR = 10, F_NOT = 11,
    F_ROUND = 12, F_ABS = 13, F_MOD = 14, F_SIGN = 15, F_INT = 16,
    F_POWER = 17, F_PRODUCT = 18, F_SQRT = 19, F_FLOOR = 20, F_CEIL = 21,
    F_LET = 22, F_LAMBDA = 23, F_SUMPRODUCT = 24;

  let tc = 0;
  let parseSink = 0;

  let g_sum = 0, g_cnt = 0, g_min = 0, g_max = 0, g_psum = 1, g_pcnt = 0;

  let lcgState = 42;

  const ERR = 0 / 0;
  const BIG = 100000000000000000000000000000000000000; // 1e38, no exponent

  function myFloor(x: number): number {
    const t = x % 1;
    const f = x - t;
    if (t < 0) return f - 1;
    return f;
  }
  function isErr(v: number): boolean {
    return v !== v || v > BIG || v < -BIG;
  }
  function pow10(n: number): number {
    let r = 1;
    for (let i = 0; i < n; i++) r = r * 10;
    return r;
  }
  function intPow(b: number, e: number): number {
    let n = myFloor(e);
    const neg = n < 0;
    if (neg) n = -n;
    let r = 1;
    for (let i = 0; i < n; i++) r = r * b;
    if (neg) return 1 / r;
    return r;
  }
  function newtonSqrt(x: number): number {
    if (x < 0) return ERR;
    if (x === 0) return 0;
    let g = x;
    for (let i = 0; i < 40; i++) g = (g + x / g) / 2;
    return g;
  }
  function lcgNext(): number {
    lcgState = (lcgState * 9301 + 49297) % 233280;
    return (lcgState / 233280) * 100;
  }

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

  function funcIdFrom(src: Uint8Array, s: number, e: number): number {
    const len = e - s;
    if (s + 1 >= e) return -1;
    const b1 = src[s];
    const b2 = src[s + 1];
    if (len === 3 && b1 === 83 && b2 === 85) return F_SUM;
    if (len === 7 && b1 === 65 && b2 === 86) return F_AVERAGE;
    if (len === 3 && b1 === 77 && b2 === 73) return F_MIN;
    if (len === 3 && b1 === 77 && b2 === 65) return F_MAX;
    if (len === 5 && b1 === 67 && b2 === 79) return F_COUNT;
    if (len === 6 && b1 === 67 && b2 === 79) return F_COUNTA;
    if (len === 2 && b1 === 73 && b2 === 70) return F_IF;
    if (len === 7 && b1 === 73 && b2 === 70) return F_IFERROR;
    if (len === 3 && b1 === 65 && b2 === 78) return F_AND;
    if (len === 2 && b1 === 79 && b2 === 82) return F_OR;
    if (len === 3 && b1 === 78 && b2 === 79) return F_NOT;
    if (len === 5 && b1 === 82 && b2 === 79) return F_ROUND;
    if (len === 3 && b1 === 65 && b2 === 66) return F_ABS;
    if (len === 3 && b1 === 77 && b2 === 79) return F_MOD;
    if (len === 4 && b1 === 83 && b2 === 73) return F_SIGN;
    if (len === 3 && b1 === 73 && b2 === 78) return F_INT;
    if (len === 5 && b1 === 80 && b2 === 79) return F_POWER;
    if (len === 7 && b1 === 80 && b2 === 82) return F_PRODUCT;
    if (len === 4 && b1 === 83 && b2 === 81) return F_SQRT;
    if (len === 5 && b1 === 70 && b2 === 76) return F_FLOOR;
    if (len === 4 && b1 === 67 && b2 === 69) return F_CEIL;
    if (len === 3 && b1 === 76 && b2 === 69) return F_LET;
    if (len === 6 && b1 === 76 && b2 === 65) return F_LAMBDA;
    if (len === 10 && b1 === 83 && b2 === 85) return F_SUMPRODUCT;
    return -1;
  }

  // ---------- name table (M1: interned LET/LAMBDA identifier bytes) ----------
  const NAME_MAX = 1024;
  const NAME_BYTES_MAX = 8192;
  const nameOff = new Int32Array(NAME_MAX);
  const nameLen = new Int32Array(NAME_MAX);
  const nameBytes = new Uint8Array(NAME_BYTES_MAX);
  let nameCount = 0;
  let nameBytesTop = 0;
  let curBytes = new Uint8Array(0); // formula being parsed (core.ts uses srcF)

  function internName(s: number, e: number): number {
    const len = e - s;
    for (let i = 0; i < nameCount; i++) {
      if (nameLen[i] === len) {
        const off = nameOff[i];
        let same = true;
        for (let j = 0; j < len; j++) {
          if (nameBytes[off + j] !== curBytes[s + j]) { same = false; break; }
        }
        if (same) return i;
      }
    }
    if (nameCount >= NAME_MAX || nameBytesTop + len > NAME_BYTES_MAX) return -1;
    nameOff[nameCount] = nameBytesTop;
    nameLen[nameCount] = len;
    for (let j = 0; j < len; j++) nameBytes[nameBytesTop + j] = curBytes[s + j];
    nameBytesTop += len;
    return nameCount++;
  }

  function tokenize(bytes: Uint8Array, n: number): number {
    curBytes = bytes;
    let p = 0;
    let t = 0;
    if (n > 0 && bytes[0] === 61) p = 1;
    while (p < n) {
      if (t >= TOK_MAX) return -1;
      const b = bytes[p];
      if (b === 32 || b === 9 || b === 13 || b === 10) { p = p + 1; continue; }
      if (b >= 48 && b <= 57) {
        let m = 0;
        let div = 1;
        let seenDot = 0;
        while (p < n) {
          const c = bytes[p];
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
        const s = p;
        let col = 0;
        let letters = 0;
        while (p < n) {
          const c = bytes[p];
          if (c >= 65 && c <= 90) { col = col * 26 + (c - 64); letters = letters + 1; p = p + 1; }
          else if (c >= 97 && c <= 122) { col = col * 26 + (c - 96); letters = letters + 1; p = p + 1; }
          else if (c === 36) { p = p + 1; }
          else break;
        }
        let row = 0;
        let digits = 0;
        while (p < n) {
          const c = bytes[p];
          if (c >= 48 && c <= 57) { row = row * 10 + (c - 48); digits = digits + 1; p = p + 1; }
          else break;
        }
        if (letters > 0 && digits > 0 && row >= 1 && row <= NROWS && col >= 1 && col <= NCOLS) {
          tokKind[t] = T_CELL; tokNum[t] = row; tokPos[t] = col;
        } else if (digits === 0 && letters > 0) {
          let q = p;
          while (q < n && (bytes[q] === 32 || bytes[q] === 9)) q = q + 1;
          if (q < n && bytes[q] === 40) {
            const fid = funcIdFrom(bytes, s, p);
            if (fid >= 0) { tokKind[t] = T_FUNC; tokNum[t] = fid; }
            else { tokKind[t] = T_IDENT; tokPos[t] = s; tokLen[t] = p - s; } // LAMBDA variable call
          } else {
            tokKind[t] = T_IDENT; tokPos[t] = s; tokLen[t] = p - s;
          }
        } else return -1;
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
      if (b === 60) {
        p = p + 1;
        if (p < n && bytes[p] === 61) { tokKind[t] = T_LE; p = p + 1; }
        else if (p < n && bytes[p] === 62) { tokKind[t] = T_NE; p = p + 1; }
        else tokKind[t] = T_LT;
        t = t + 1;
        continue;
      }
      if (b === 62) {
        p = p + 1;
        if (p < n && bytes[p] === 61) { tokKind[t] = T_GE; p = p + 1; }
        else tokKind[t] = T_GT;
        t = t + 1;
        continue;
      }
      if (b === 61) { tokKind[t] = T_EQ; t = t + 1; p = p + 1; continue; }
      return -1;
    }
    tokKind[t] = T_END;
    return t + 1;
  }

  function cellIdx(row: number, col: number): number {
    return (row - 1) * NCOLS + (col - 1);
  }
  function peekKind(): number {
    return tokKind[tc];
  }

  // ---------- parser (single-loop precedence machine; mirrors src/core.ts) ----
  // Same rewrite as core.ts (§1-e): one loop, explicit op/value stacks, no
  // per-level call chain — keeps the twin the same algorithm in idiomatic JS.
  // op-stack entries: binary ops keep their T_ kind (N_ADD..N_NE === T_PLUS..T_NE
  // − 3, same order); markers use O_ ids above all T_/N_ kinds.
  const O_LP = 90, O_CALL = 91, O_CALLV = 92, O_NEG = 93;
  const P_CMP = 2, P_ADD = 3, P_MUL = 4, P_POW = 5, P_UN = 6;
  const PS_MAX = 768;
  const psVal = new Int32Array(PS_MAX);
  const psOp = new Int32Array(PS_MAX);
  const psAux = new Int32Array(PS_MAX);
  const psBase = new Int32Array(PS_MAX);
  const psPend = new Int32Array(PS_MAX);

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

  // LET(name, value, [name, value]..., body): children are N_NAME, expr, ..., expr
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
      pairs++;
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

  // LAMBDA(param, ..., body): children are N_NAME params ..., body last
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
      pc++;
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

  // ---------- dependency graph (M1; mirrors src/core.ts, set-time only) ----
  let fwdStart = new Int32Array(0);
  let fwdCount = new Int32Array(0);
  let revStart = new Int32Array(0);
  let revCount = new Int32Array(0);
  let edgePool = new Int32Array(0);
  let edgeTop = 0;
  let edgeCap = 0;
  let dirtyFlag = new Uint8Array(0);
  let dirtyList = new Int32Array(0);
  let dirtyStack = new Int32Array(0);
  let dirtyCount = 0;

  function growEdges(need: number): void {
    let cap = edgeCap * 2 + 1024;
    while (cap < edgeTop + need) cap = cap * 2 + 1024;
    const np = new Int32Array(cap);
    np.set(edgePool.subarray(0, edgeTop));
    edgePool = np;
    edgeCap = cap;
  }

  function edgeAdd(st: Int32Array, cn: Int32Array, cell: number, v: number): void {
    const c = cn[cell];
    if (c === 0) {
      if (edgeTop + 1 > edgeCap) growEdges(1);
      st[cell] = edgeTop;
      edgePool[edgeTop++] = v;
      cn[cell] = 1;
      return;
    }
    const s = st[cell];
    if (s + c === edgeTop && edgeTop + 1 <= edgeCap) {
      edgePool[edgeTop++] = v;
      cn[cell] = c + 1;
      return;
    }
    let res = c * 2;
    if (res < c + 1) res = c + 1;
    if (edgeTop + res > edgeCap) growEdges(res);
    for (let j = 0; j < c; j++) edgePool[edgeTop + j] = edgePool[s + j];
    st[cell] = edgeTop;
    edgePool[edgeTop + c] = v;
    edgeTop += res;
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
    for (let j = 0; j < c; j++) {
      if (edgePool[s + j] === v) {
        edgePool[s + j] = edgePool[s + c - 1]; // swap-remove; order irrelevant
        revCount[t] = c - 1;
        return;
      }
    }
  }

  function removeDeps(cell: number): void {
    const s = fwdStart[cell];
    const c = fwdCount[cell];
    for (let j = 0; j < c; j++) revRemove(edgePool[s + j], cell);
    fwdCount[cell] = 0; // retired block leaks into the pool until wbInit
  }

  function addCellDeps(cell: number, root: number): void {
    fwdCount[cell] = 0;
    collectRefs(root, cell);
  }

  function collectRefs(n: number, cell: number): void {
    const k = ndKind[n];
    if (k === N_REF) { addDeps(cell, ndA[n]); return; }
    if (k === N_RANGE) {
      const a = ndA[n], b = ndB[n];
      const r1 = Math.floor(a / NCOLS), r2 = Math.floor(b / NCOLS);
      const c1 = a - r1 * NCOLS, c2 = b - r2 * NCOLS;
      for (let rb = r1 * NCOLS; rb <= r2 * NCOLS; rb += NCOLS) {
        for (let cc = c1; cc <= c2; cc++) addDeps(cell, rb + cc);
      }
      return;
    }
    if (k === N_CALL) { for (let cc = ndB[n]; cc >= 0; cc = ndSib[cc]) collectRefs(cc, cell); return; }
    if (k === N_CALLV) { for (let cc = ndB[n]; cc >= 0; cc = ndSib[cc]) collectRefs(cc, cell); return; }
    if (k === N_NEG) { collectRefs(ndA[n], cell); return; }
    if (k >= N_ADD && k <= N_NE) { collectRefs(ndA[n], cell); collectRefs(ndB[n], cell); return; }
    // N_NUM / N_NAME: no cell edges
  }

  function markDirty(seed: number): void {
    if (dirtyFlag[seed] !== 0) return;
    dirtyFlag[seed] = 1;
    dirtyList[dirtyCount++] = seed;
    dirtyStack[0] = seed;
    let top = 1;
    while (top > 0) {
      const x = dirtyStack[--top];
      const c = revCount[x];
      if (c === 0) continue;
      const s = revStart[x];
      for (let j = 0; j < c; j++) {
        const y = edgePool[s + j];
        if (dirtyFlag[y] === 0) {
          dirtyFlag[y] = 1;
          dirtyList[dirtyCount++] = y;
          dirtyStack[top++] = y;
        }
      }
    }
  }

  // ---------------- evaluator: frame machine (mirrors src/core.ts — R6) ----
  // Same algorithm as the wasm engine: one dispatch loop, explicit work and
  // value stacks, aggregate register save/restore per open aggregate.
  const FR_MAX = 65536;
  const ftTag = new Uint8Array(FR_MAX);
  const ftA = new Int32Array(FR_MAX);
  const ftB = new Int32Array(FR_MAX);
  const ftC = new Int32Array(FR_MAX);
  const ftD = new Int32Array(FR_MAX);
  const ftE = new Int32Array(FR_MAX);
  const ftF = new Int32Array(FR_MAX);
  const vstk = new Float64Array(FR_MAX);
  const scratch16 = new Int32Array(16);
  const AGG_MAX = 1024;
  const aggSave = new Float64Array(AGG_MAX * 7);
  const gg = new Float64Array(6); // live aggregate registers
  const FT_NODE = 1, FT_CELL = 2, FT_PUSHV = 3, FT_BIN = 4, FT_NEG = 5,
    FT_APPLY = 6, FT_AGG = 7, FT_AGR = 8, FT_ASC = 9,
    FT_LET = 10, FT_CALL = 11, FT_SP2 = 12, FT_AGR2 = 13;

  // LET/LAMBDA binding stack + per-cell context floors (mirrors src/core.ts)
  const BIND_MAX = 4096;
  const bindName = new Int32Array(BIND_MAX);
  const bindVal = new Float64Array(BIND_MAX);
  const bindKind = new Uint8Array(BIND_MAX); // 0 number · 1 lambda (AST node idx)
  const ctxSave = new Int32Array(FR_MAX);
  const LAMBDA_DEPTH_CAP = 200;

  function wbInit(rows: number, cols: number): number {
    NROWS = rows;
    NCOLS = cols;
    NCELLS = rows * cols;
    vals = new Float64Array(NCELLS);
    kinds = new Uint8Array(NCELLS);
    astRoot = new Int32Array(NCELLS);
    computed = new Uint8Array(NCELLS);
    visiting = new Uint8Array(NCELLS);
    fwdStart = new Int32Array(NCELLS);
    fwdCount = new Int32Array(NCELLS);
    revStart = new Int32Array(NCELLS);
    revCount = new Int32Array(NCELLS);
    dirtyFlag = new Uint8Array(NCELLS);
    dirtyList = new Int32Array(NCELLS);
    dirtyStack = new Int32Array(NCELLS);
    for (let i = 0; i < NCELLS; i++) astRoot[i] = -1;
    astCount = 0;
    nameCount = 0;
    nameBytesTop = 0;
    edgeTop = 0; // pools keep capacity across builds (R4)
    dirtyCount = 0;
    lcgState = 42;
    return NCELLS;
  }

  function wbSetNumber(idx: number, v: number): number {
    if (kinds[idx] === 2) removeDeps(idx); // formula -> number: drop its reads
    kinds[idx] = 1;
    vals[idx] = v;
    astRoot[idx] = -1;
    computed[idx] = 1;
    markDirty(idx);
    return v;
  }

  function wbSetNumbers(idxStart: number, packed: Uint8Array): number {
    const n = myFloor(packed.length / 8);
    for (let i = 0; i < n; i++) {
      let v = 0;
      let scale = 1;
      for (let j = 7; j >= 0; j--) {
        v += packed[i * 8 + j] * scale;
        scale *= 256;
      }
      wbSetNumber(idxStart + i, v);
    }
    return n;
  }

  function wbGet(idx: number): number {
    return vals[idx];
  }

  /** Parse `formula` (UTF-8 bytes, optional leading '=') into cell `idx`. */
  function wbSetFormula(idx: number, formula: Uint8Array): number {
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
    vals[idx] = NaN;
    astRoot[idx] = -1;
    computed[idx] = 1;
    markDirty(idx);
    return 0;
  }

  function scanFind(from: number): number {
    for (let s = from; s < NCELLS; s++) {
      if (kinds[s] === 2 && computed[s] === 0) return s;
    }
    return -1;
  }
  function scanChecksum(): number {
    let sum = 0;
    for (let c2 = 0; c2 < NCELLS; c2++) {
      const v = vals[c2];
      if (v === v && v < BIG && v > -BIG) sum += v;
    }
    return sum;
  }

  function wbRecalc(): number {
    // cell sweep split like the wasm engine: finder fn, machine, checksum fn
    let scanFrom = 0;
    while (true) {
      const cell = scanFind(scanFrom);
      if (cell < 0) break;
      scanFrom = cell + 1;
      {
        let sp = 0;
        let fp = 1;
        ftTag[0] = FT_CELL; ftA[0] = cell;
        ftTag[1] = FT_NODE; ftA[1] = astRoot[cell];
        visiting[cell] = 1;
        let aggTop = 0;
        let bindTop = 0;
        let bindBase = 0;
        let ctxTop = 0;
        let callDepth = 0;
        ctxSave[0] = 0; // the seed FT_CELL owns context slot 0
        ctxTop = 1;
        while (fp >= 0) {
          const tag = ftTag[fp];
          if (tag === FT_NODE) {
            const n = ftA[fp];
            const k = ndKind[n];
            if (k === N_REF) {
              const idx = ndA[n];
              const kk = kinds[idx];
              if (kk === 1 || (kk === 2 && computed[idx] !== 0)) { vstk[sp++] = vals[idx]; fp--; }
              else if (kk === 2 && visiting[idx] !== 0) { vstk[sp++] = NaN; fp--; } // cycle
              else if (kk !== 2) { vstk[sp++] = kk === 0 ? 0 : NaN; fp--; } // empty=0, error=NaN
              else {
                ctxSave[ctxTop++] = bindBase;
                bindBase = bindTop; // the pulled cell's bindings start above ours
                visiting[idx] = 1;
                ftTag[fp] = FT_PUSHV; ftA[fp] = idx;
                fp++; ftTag[fp] = FT_CELL; ftA[fp] = idx;
                fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[idx];
              }
            } else if (k === N_CALL) {
              const fid = ndA[n];
              if (fid === F_LET) {
                // (name, value) pairs then body — parser guarantees the shape
                const pairs = ndVal[n];
                if (pairs < 1 || bindTop + pairs > BIND_MAX) { vstk[sp++] = NaN; fp--; }
                else {
                  ftTag[fp] = FT_LET; ftA[fp] = n;
                  ftB[fp] = 0; // state: expect binding pair
                  ftC[fp] = ndB[n]; // first child (name node)
                  ftD[fp] = pairs;
                  ftE[fp] = -1;
                  ftF[fp] = pairs;
                }
              } else if (fid === F_LAMBDA) {
                vstk[sp++] = NaN; fp--; // callables never ride the value stack
              } else if (fid === F_SUMPRODUCT) {
                // exactly two N_RANGE children of equal shape, else NaN
                const ch1 = ndB[n];
                const ch2 = ndSib[ch1];
                const ch3 = ndSib[ch2];
                let ok = true;
                let r1b = 0, end1 = 0, cA = 0, cB = 0, delta = 0;
                if (ch2 < 0 || ch3 >= 0 || ndKind[ch1] !== N_RANGE || ndKind[ch2] !== N_RANGE) ok = false;
                else {
                  const r1 = myFloor(ndA[ch1] / NCOLS), r2 = myFloor(ndB[ch1] / NCOLS);
                  const r3 = myFloor(ndA[ch2] / NCOLS), r4 = myFloor(ndB[ch2] / NCOLS);
                  const ca = ndA[ch1] - r1 * NCOLS, cb = ndB[ch1] - r2 * NCOLS;
                  const c3 = ndA[ch2] - r3 * NCOLS, c4 = ndB[ch2] - r4 * NCOLS;
                  if (r2 - r1 !== r4 - r3 || cb - ca !== c4 - c3) ok = false;
                  else {
                    r1b = r1 * NCOLS;
                    end1 = r2 * NCOLS + cb;
                    cA = ca;
                    cB = cb;
                    delta = ndA[ch2] - ndA[ch1];
                  }
                }
                if (!ok) {
                  vstk[sp++] = NaN; fp--;
                } else {
                  aggSave[aggTop] = gg[0]; aggSave[aggTop + 1] = gg[1];
                  aggSave[aggTop + 2] = gg[2]; aggSave[aggTop + 3] = gg[3];
                  aggSave[aggTop + 4] = gg[4]; aggSave[aggTop + 5] = gg[5];
                  aggTop += 7;
                  gg[0] = 0; gg[1] = 0; gg[2] = 0; gg[3] = 0; gg[4] = 1; gg[5] = 0;
                  ftTag[fp] = FT_SP2; ftA[fp] = fid; ftB[fp] = -1;
                  fp++;
                  ftTag[fp] = FT_AGR2;
                  ftA[fp] = cB; ftB[fp] = r1b; ftC[fp] = cA; ftD[fp] = delta; ftE[fp] = cA; ftF[fp] = end1;
                }
              } else if (fid === F_SUM || fid === F_AVERAGE || fid === F_COUNT || fid === F_COUNTA ||
                fid === F_MIN || fid === F_MAX || fid === F_PRODUCT) {
                aggSave[aggTop] = gg[0]; aggSave[aggTop + 1] = gg[1];
                aggSave[aggTop + 2] = gg[2]; aggSave[aggTop + 3] = gg[3];
                aggSave[aggTop + 4] = gg[4]; aggSave[aggTop + 5] = gg[5];
                aggTop += 7;
                gg[0] = 0; gg[1] = 0; gg[2] = 0; gg[3] = 0; gg[4] = 1; gg[5] = 0;
                ftTag[fp] = FT_AGG; ftA[fp] = fid; ftB[fp] = ndB[n];
              } else {
                let argc = 0;
                let cc = ndB[n];
                while (cc >= 0 && argc < 16) { scratch16[argc] = cc; argc++; cc = ndSib[cc]; }
                if (argc < 16) {
                  ftTag[fp] = FT_APPLY; ftA[fp] = fid; ftB[fp] = argc;
                  for (let j = argc - 1; j >= 0; j--) { fp++; ftTag[fp] = FT_NODE; ftA[fp] = scratch16[j]; }
                } else {
                  cc = ndB[n];
                  let total = 0;
                  while (cc >= 0) { total++; cc = ndSib[cc]; }
                  ftTag[fp] = FT_APPLY; ftA[fp] = fid;
                  ftB[fp] = fid === F_AND || fid === F_OR ? total : -2;
                  ftC[fp] = total;
                  cc = ndB[n];
                  while (cc >= 0) { fp++; ftTag[fp] = FT_NODE; ftA[fp] = cc; cc = ndSib[cc]; }
                }
              }
            } else if (k === N_ADD || k === N_MUL || k === N_SUB || k === N_DIV || k === N_POW ||
              (k >= N_LT && k <= N_NE)) {
              ftTag[fp] = FT_BIN; ftA[fp] = k;
              fp++; ftTag[fp] = FT_NODE; ftA[fp] = ndB[n];
              fp++; ftTag[fp] = FT_NODE; ftA[fp] = ndA[n];
            } else if (k === N_NUM) { vstk[sp++] = ndVal[n]; fp--; }
            else if (k === N_NEG) {
              ftTag[fp] = FT_NEG;
              fp++; ftTag[fp] = FT_NODE; ftA[fp] = ndA[n];
            } else if (k === N_NAME) {
              // binding lookup, innermost first, down to this cell's floor
              const nid = ndA[n];
              let b = bindTop;
              let found = -1;
              while (b > bindBase) {
                b--;
                if (bindName[b] === nid) { found = b; b = bindBase; }
              }
              if (found >= 0 && bindKind[found] === 0) vstk[sp++] = bindVal[found];
              else vstk[sp++] = NaN; // unbound, or callable in value position
              fp--;
            } else if (k === N_CALLV) {
              // call a LAMBDA held in a binding; callee resolves at call time,
              // which is what makes LET self-reference (recursion) work
              const nameN = ndA[n];
              const nid = ndA[nameN];
              let b = bindTop;
              let found = -1;
              while (b > bindBase) {
                b--;
                if (bindName[b] === nid) { found = b; b = bindBase; }
              }
              let bad = found < 0 || bindKind[found] !== 1;
              let closure = -1;
              if (!bad) {
                closure = bindVal[found];
                if (ndKind[closure] !== N_CALL || ndA[closure] !== F_LAMBDA) bad = true;
              }
              if (bad || callDepth >= LAMBDA_DEPTH_CAP) {
                vstk[sp++] = NaN; fp--;
              } else {
                const pcount = ndVal[closure];
                let acount = 0;
                for (let cc = ndB[n]; cc >= 0; cc = ndSib[cc]) acount++;
                if (acount !== pcount || bindTop + pcount > BIND_MAX) {
                  vstk[sp++] = NaN; fp--;
                } else {
                  callDepth++;
                  ftTag[fp] = FT_CALL; ftA[fp] = closure;
                  ftB[fp] = 0; // state: expect argument
                  ftC[fp] = ndB[n]; // first arg
                  ftD[fp] = pcount;
                  ftE[fp] = -1;
                  ftF[fp] = pcount;
                }
              }
            } else { vstk[sp++] = NaN; fp--; } // N_RANGE in scalar ctx / unknown
          } else if (tag === FT_AGR) {
            // counted walks (same shape as the wasm engine); pause only for
            // formulas. Ranges are parser-normalized (r1<=r2, c1<=c2).
            let paused = false;
            const d0 = ftD[fp], d1 = ftE[fp], endAll = ftF[fp];
            let s = gg[0], n = gg[1], mn = gg[2], mx = gg[3], p = gg[4], n2 = gg[5];
            if (d0 === d1) {
              // single column: stride-NCOLS loop over rows
              for (let cur = ftB[fp] + ftC[fp]; cur <= endAll; cur += NCOLS) {
                if (kinds[cur] === 2 && computed[cur] === 0 && visiting[cur] === 0) {
                  ftB[fp] = cur - d0; ftC[fp] = d0; // resume at this same cell
                  ctxSave[ctxTop++] = bindBase;
                  bindBase = bindTop;
                  visiting[cur] = 1;
                  fp++; ftTag[fp] = FT_CELL; ftA[fp] = cur;
                  fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[cur];
                  paused = true;
                  break;
                }
                if (kinds[cur] !== 0) {
                  const av = vals[cur];
                  s += av; n += 1; p *= av; n2 += 1;
                  if (n === 1 || av < mn) mn = av;
                  if (n === 1 || av > mx) mx = av;
                }
              }
            } else {
              // multi-column: rows outer, per-row counted col loop
              let rb = ftB[fp];
              const lastBase = endAll - d1;
              let cc = ftC[fp];
              while (!paused) {
                const rowEnd = rb + d1;
                for (let cur = rb + cc; cur <= rowEnd; cur++) {
                  if (kinds[cur] === 2 && computed[cur] === 0 && visiting[cur] === 0) {
                    ftB[fp] = rb; ftC[fp] = cur - rb; // resume at this same cell
                    ctxSave[ctxTop++] = bindBase;
                    bindBase = bindTop;
                    visiting[cur] = 1;
                    fp++; ftTag[fp] = FT_CELL; ftA[fp] = cur;
                    fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[cur];
                    paused = true;
                    break;
                  }
                  if (kinds[cur] !== 0) {
                    const av = vals[cur];
                    s += av; n += 1; p *= av; n2 += 1;
                    if (n === 1 || av < mn) mn = av;
                    if (n === 1 || av > mx) mx = av;
                  }
                }
                if (paused) break;
                if (rb === lastBase) break; // range exhausted
                rb += NCOLS;
                cc = d0;
              }
            }
            gg[0] = s; gg[1] = n; gg[2] = mn; gg[3] = mx; gg[4] = p; gg[5] = n2;
            if (!paused) fp--;
          } else if (tag === FT_CELL) {
            const ci = ftA[fp];
            vals[ci] = vstk[sp - 1];
            computed[ci] = 1;
            visiting[ci] = 0;
            bindBase = ctxSave[--ctxTop]; // this cell's context closes
            sp--; fp--;
          } else if (tag === FT_BIN) {
            const bk = ftA[fp];
            const bv = vstk[sp - 1];
            const av = vstk[sp - 2];
            sp -= 2;
            let rv: number;
            if (bk === N_ADD) rv = av + bv;
            else if (bk === N_MUL) rv = av * bv;
            else if (bk === N_SUB) rv = av - bv;
            else if (bk === N_DIV) rv = av / bv;
            else if (bk === N_POW) {
              let pn = Math.floor(bv);
              const pneg = pn < 0;
              if (pneg) pn = -pn;
              let pr = 1;
              for (let pi = 0; pi < pn; pi++) pr *= av;
              rv = pneg ? 1 / pr : pr;
            } else {
              const bad = isErr(av) || isErr(bv);
              if (bad) rv = NaN;
              else if (bk === N_LT) rv = av < bv ? 1 : 0;
              else if (bk === N_GT) rv = av > bv ? 1 : 0;
              else if (bk === N_LE) rv = av <= bv ? 1 : 0;
              else if (bk === N_GE) rv = av >= bv ? 1 : 0;
              else if (bk === N_EQ) rv = av === bv ? 1 : 0;
              else rv = av !== bv ? 1 : 0;
            }
            vstk[sp++] = rv;
            fp--;
          } else if (tag === FT_ASC) {
            const sv = vstk[sp - 1];
            sp--;
            gg[0] += sv; gg[1] += 1; gg[4] *= sv; gg[5] += 1;
            if (gg[1] === 1 || sv < gg[2]) gg[2] = sv;
            if (gg[1] === 1 || sv > gg[3]) gg[3] = sv;
            fp--;
          } else if (tag === FT_APPLY) {
            const fid = ftA[fp];
            const argc = ftB[fp];
            if (argc === -2) {
              sp -= ftC[fp];
              vstk[sp++] = NaN;
            } else {
              const v0 = argc >= 1 ? vstk[sp - argc] : NaN;
              const v1 = argc >= 2 ? vstk[sp - argc + 1] : NaN;
              const v2 = argc >= 3 ? vstk[sp - argc + 2] : NaN;
              let res = NaN;
              if (fid === F_IF) {
                if (argc >= 1) {
                  if (isErr(v0)) res = NaN;
                  else if (v0 !== 0) res = argc >= 2 ? v1 : NaN;
                  else res = argc >= 3 ? v2 : 0;
                }
              } else if (fid === F_IFERROR) {
                if (argc >= 1) res = !isErr(v0) ? v0 : (argc >= 2 ? v1 : NaN);
              } else if (fid === F_AND || fid === F_OR) {
                let acc2 = fid === F_AND ? 1 : 0;
                let bad2 = false;
                for (let j2 = 0; j2 < argc; j2++) {
                  const vv = vstk[sp - argc + j2];
                  if (isErr(vv)) { bad2 = true; break; }
                  if (fid === F_AND) { if (vv === 0) acc2 = 0; }
                  else { if (vv !== 0) acc2 = 1; }
                }
                res = bad2 ? NaN : acc2;
              } else if (fid === F_NOT) {
                if (argc >= 1) res = isErr(v0) ? NaN : (v0 === 0 ? 1 : 0);
              } else if (fid === F_ABS) {
                if (argc >= 1) res = v0 < 0 ? -v0 : v0;
              } else if (fid === F_SIGN) {
                if (argc >= 1) res = isErr(v0) ? v0 : (v0 > 0 ? 1 : (v0 < 0 ? -1 : 0));
              } else if (fid === F_INT) {
                if (argc >= 1) res = myFloor(v0);
              } else if (fid === F_SQRT) {
                if (argc >= 1) res = newtonSqrt(v0);
              } else if (fid === F_ROUND) {
                if (argc >= 1) {
                  if (isErr(v0)) res = v0;
                  else {
                    const d = argc >= 2 ? myFloor(v1) : 0;
                    const sc = pow10(d < 0 ? -d : d);
                    const ax = (v0 < 0 ? -v0 : v0) * sc;
                    let r = myFloor(ax + 0.5);
                    if (v0 < 0) r = -r;
                    res = r / sc;
                  }
                }
              } else if (fid === F_MOD) {
                if (argc >= 2) res = v1 === 0 ? NaN : v0 - v1 * myFloor(v0 / v1);
              } else if (fid === F_POWER) {
                if (argc >= 2) {
                  let pn = myFloor(v1);
                  const pneg = pn < 0;
                  if (pneg) pn = -pn;
                  let pr = 1;
                  for (let pi = 0; pi < pn; pi++) pr *= v0;
                  res = pneg ? 1 / pr : pr;
                }
              } else if (fid === F_FLOOR || fid === F_CEIL) {
                if (argc >= 1) {
                  const sig = argc >= 2 ? v1 : 1;
                  if (sig === 0) res = NaN;
                  else {
                    const q = v0 / sig;
                    const f = fid === F_FLOOR ? myFloor(q) : -myFloor(-q);
                    res = f * sig;
                  }
                }
              }
              sp -= argc;
              vstk[sp++] = res;
            }
            fp--;
          } else if (tag === FT_AGG) {
            const fid = ftA[fp];
            const cur2 = ftB[fp];
            if (cur2 < 0) {
              if (fid === F_SUM) vstk[sp] = gg[0];
              else if (fid === F_AVERAGE) vstk[sp] = gg[1] === 0 ? NaN : gg[0] / gg[1];
              else if (fid === F_COUNT || fid === F_COUNTA) vstk[sp] = gg[1];
              else if (fid === F_MIN) vstk[sp] = gg[1] === 0 ? 0 : gg[2];
              else if (fid === F_MAX) vstk[sp] = gg[1] === 0 ? 0 : gg[3];
              else vstk[sp] = gg[5] === 0 ? 0 : gg[4]; // F_PRODUCT
              sp++;
              aggTop -= 7;
              gg[0] = aggSave[aggTop]; gg[1] = aggSave[aggTop + 1]; gg[2] = aggSave[aggTop + 2];
              gg[3] = aggSave[aggTop + 3]; gg[4] = aggSave[aggTop + 4]; gg[5] = aggSave[aggTop + 5];
              fp--;
            } else {
              ftB[fp] = ndSib[cur2];
              if (ndKind[cur2] === N_RANGE) {
                const ra = ndA[cur2];
                const rb = ndB[cur2];
                const r1 = myFloor(ra / NCOLS);
                const r2 = myFloor(rb / NCOLS);
                const c1 = ra - r1 * NCOLS;
                const c2 = rb - r2 * NCOLS;
                fp++;
                ftTag[fp] = FT_AGR;
                ftB[fp] = r1 * NCOLS;
                ftC[fp] = c1;
                ftD[fp] = c1;
                ftE[fp] = c2;
                ftF[fp] = r2 * NCOLS + c2;
              } else {
                fp++; ftTag[fp] = FT_ASC;
                fp++; ftTag[fp] = FT_NODE; ftA[fp] = cur2;
              }
            }
          } else if (tag === FT_PUSHV) {
            vstk[sp++] = vals[ftA[fp]];
            fp--;
          } else if (tag === FT_NEG) {
            vstk[sp - 1] = -vstk[sp - 1];
            fp--;
          } else if (tag === FT_LET) {
            // states: 0 expect (name,value) pairs · 1 bind computed value · 2 body done
            let st = ftB[fp];
            if (st === 1) {
              bindName[bindTop] = ftE[fp];
              bindVal[bindTop] = vstk[sp - 1];
              bindKind[bindTop] = 0;
              bindTop++;
              sp--;
              ftD[fp]--;
              ftC[fp] = ndSib[ftC[fp]]; // step past the value expr
              st = 0;
            } else if (st === 2) {
              bindTop -= ftF[fp]; // body value stays as the LET result
              fp--;
              st = 3;
            }
            if (st === 0) {
              while (true) {
                if (ftD[fp] === 0) {
                  ftB[fp] = 2; // all pairs bound; ftC is the body
                  const body = ftC[fp]; // read BEFORE fp++ (ftC of the new slot is garbage)
                  fp++; ftTag[fp] = FT_NODE; ftA[fp] = body;
                  break;
                }
                const nameN = ftC[fp];
                const nid = ndA[nameN];
                const vnode = ndSib[nameN];
                if (ndKind[vnode] === N_CALL && ndA[vnode] === F_LAMBDA) {
                  // direct-bind the closure — callables never ride the value stack
                  bindName[bindTop] = nid;
                  bindVal[bindTop] = vnode;
                  bindKind[bindTop] = 1;
                  bindTop++;
                  ftC[fp] = ndSib[vnode];
                  ftD[fp]--;
                  continue;
                }
                ftE[fp] = nid;
                ftC[fp] = vnode;
                ftB[fp] = 1;
                fp++; ftTag[fp] = FT_NODE; ftA[fp] = vnode;
                break;
              }
            }
          } else if (tag === FT_CALL) {
            // states: 0 expect args · 1 bind computed arg · 2 body done
            let st = ftB[fp];
            if (st === 1) {
              bindName[bindTop] = ftE[fp];
              bindVal[bindTop] = vstk[sp - 1];
              bindKind[bindTop] = 0;
              bindTop++;
              sp--;
              ftD[fp]--;
              ftC[fp] = ndSib[ftC[fp]]; // step past this arg
              st = 0;
            } else if (st === 2) {
              bindTop -= ftF[fp];
              callDepth--;
              fp--;
              st = 3;
            }
            if (st === 0) {
              while (true) {
                if (ftD[fp] === 0) {
                  // all params bound: evaluate the closure body (last chain child)
                  let bb = ndB[ftA[fp]];
                  for (let q = 0; q < ftF[fp]; q++) bb = ndSib[bb];
                  ftB[fp] = 2;
                  fp++; ftTag[fp] = FT_NODE; ftA[fp] = bb;
                  break;
                }
                const argN = ftC[fp];
                let pp = ndB[ftA[fp]]; // param name sits at position total-left
                for (let q = 0; q < ftF[fp] - ftD[fp]; q++) pp = ndSib[pp];
                const nid = ndA[pp];
                if (ndKind[argN] === N_CALL && ndA[argN] === F_LAMBDA) {
                  // direct-bind a lambda argument to the parameter
                  bindName[bindTop] = nid;
                  bindVal[bindTop] = argN;
                  bindKind[bindTop] = 1;
                  bindTop++;
                  ftC[fp] = ndSib[argN];
                  ftD[fp]--;
                  continue;
                }
                ftE[fp] = nid;
                ftB[fp] = 1;
                fp++; ftTag[fp] = FT_NODE; ftA[fp] = argN;
                break;
              }
            }
          } else if (tag === FT_SP2) {
            // SUMPRODUCT ranges exhausted: gg[0] holds the product-sum
            vstk[sp++] = gg[0];
            aggTop -= 7;
            gg[0] = aggSave[aggTop]; gg[1] = aggSave[aggTop + 1]; gg[2] = aggSave[aggTop + 2];
            gg[3] = aggSave[aggTop + 3]; gg[4] = aggSave[aggTop + 4]; gg[5] = aggSave[aggTop + 5];
            fp--;
          } else if (tag === FT_AGR2) {
            // one lockstep pass over two same-shape ranges (cur2 = cur1 + delta);
            // pause only when a covered formula cell needs evaluation
            let paused = false;
            const d0 = ftE[fp];
            const d1 = ftA[fp];
            const endAll = ftF[fp];
            const delta = ftD[fp];
            let a0 = gg[0];
            if (d0 === d1) {
              for (let cur = ftB[fp] + ftC[fp]; cur <= endAll; cur += NCOLS) {
                const cur2 = cur + delta;
                if (kinds[cur] === 2 && computed[cur] === 0 && visiting[cur] === 0) {
                  ftB[fp] = cur - d0; ftC[fp] = d0; // resume at this same cell
                  ctxSave[ctxTop++] = bindBase;
                  bindBase = bindTop;
                  visiting[cur] = 1;
                  fp++; ftTag[fp] = FT_CELL; ftA[fp] = cur;
                  fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[cur];
                  paused = true;
                  break;
                }
                if (kinds[cur2] === 2 && computed[cur2] === 0 && visiting[cur2] === 0) {
                  ftB[fp] = cur - d0; ftC[fp] = d0; // resume at this same cell
                  ctxSave[ctxTop++] = bindBase;
                  bindBase = bindTop;
                  visiting[cur2] = 1;
                  fp++; ftTag[fp] = FT_CELL; ftA[fp] = cur2;
                  fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[cur2];
                  paused = true;
                  break;
                }
                const v1 = kinds[cur] === 0 ? 0 : vals[cur];
                const v2 = kinds[cur2] === 0 ? 0 : vals[cur2];
                a0 += v1 * v2;
              }
            } else {
              let rb = ftB[fp];
              const lastBase = endAll - d1;
              let cc = ftC[fp];
              while (!paused) {
                const rowEnd = rb + d1;
                for (let cur = rb + cc; cur <= rowEnd; cur++) {
                  const cur2 = cur + delta;
                  if (kinds[cur] === 2 && computed[cur] === 0 && visiting[cur] === 0) {
                    ftB[fp] = rb; ftC[fp] = cur - rb; // resume at this same cell
                    ctxSave[ctxTop++] = bindBase;
                    bindBase = bindTop;
                    visiting[cur] = 1;
                    fp++; ftTag[fp] = FT_CELL; ftA[fp] = cur;
                    fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[cur];
                    paused = true;
                    break;
                  }
                  if (kinds[cur2] === 2 && computed[cur2] === 0 && visiting[cur2] === 0) {
                    ftB[fp] = rb; ftC[fp] = cur - rb; // resume at this same cell
                    ctxSave[ctxTop++] = bindBase;
                    bindBase = bindTop;
                    visiting[cur2] = 1;
                    fp++; ftTag[fp] = FT_CELL; ftA[fp] = cur2;
                    fp++; ftTag[fp] = FT_NODE; ftA[fp] = astRoot[cur2];
                    paused = true;
                    break;
                  }
                  const v1 = kinds[cur] === 0 ? 0 : vals[cur];
                  const v2 = kinds[cur2] === 0 ? 0 : vals[cur2];
                  a0 += v1 * v2;
                }
                if (paused) break;
                if (rb === lastBase) break; // range exhausted
                rb += NCOLS;
                cc = d0;
              }
            }
            gg[0] = a0;
            if (!paused) fp--;
          }
        }
      }
    }
    // checksum: ascending index — same summation order as the fused loop
    return scanChecksum();
  }

  function wbInvalidateAll(): number {
    for (let i = 0; i < NCELLS; i++) {
      if (kinds[i] === 2) computed[i] = 0;
      dirtyFlag[i] = 0;
    }
    dirtyCount = 0;
    return NCELLS;
  }

  function wbRecalcDirty(): number {
    for (let k = 0; k < dirtyCount; k++) {
      const i = dirtyList[k];
      if (kinds[i] === 2) computed[i] = 0;
      dirtyFlag[i] = 0;
    }
    dirtyCount = 0;
    return wbRecalc();
  }

  function benchParse(times: number, formula: Uint8Array): number {
    for (let i = 0; i < times; i++) {
      const nt = tokenize(formula, formula.length);
      if (nt < 0) return -1;
      tc = 0;
      const root = parseFormula();
      if (root < 0) return -2;
      parseSink = root;
      astCount = 0;
      nameCount = 0;
      nameBytesTop = 0;
    }
    return times;
  }

  function benchBuild(nCells: number): number {
    const cols = 1000;
    const rows = myFloor((nCells + cols - 1) / cols);
    wbInit(rows, cols);
    for (let i = 0; i < NCELLS; i++) {
      if (i % 10 < 6) {
        wbSetNumber(i, lcgNext());
      } else {
        const v = i % 5;
        const r = myFloor(i / NCOLS);
        let root = -1;
        if (v === 0) {
          const top = r - 20 < 0 ? 0 : r - 20;
          if (r === top) { wbSetNumber(i, lcgNext()); continue; }
          root = newNode(N_CALL);
          ndA[root] = F_SUM;
          const rg = newNode(N_RANGE);
          ndA[rg] = cellIdx(top + 1, (i - r * NCOLS) + 1);
          ndB[rg] = cellIdx(r, (i - r * NCOLS) + 1);
          ndB[root] = rg;
        } else if (v === 1) {
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
          const top = r - 10 < 0 ? 0 : r - 10;
          if (r === top) { wbSetNumber(i, lcgNext()); continue; }
          root = newNode(N_CALL);
          ndA[root] = F_AVERAGE;
          const rg = newNode(N_RANGE);
          ndA[rg] = cellIdx(top + 1, (i - r * NCOLS) + 1);
          ndB[rg] = cellIdx(r, (i - r * NCOLS) + 1);
          ndB[root] = rg;
        } else if (v === 3) {
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
          const top = r - 15 < 0 ? 0 : r - 15;
          if (r === top) { wbSetNumber(i, lcgNext()); continue; }
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
    }
    return NCELLS;
  }

  function benchRecalc(times: number): number {
    for (let k = 0; k < dirtyCount; k++) dirtyFlag[dirtyList[k]] = 0;
    dirtyCount = 0;
    let acc = 0;
    for (let t = 0; t < times; t++) {
      for (let i = 0; i < NCELLS; i++) {
        if (kinds[i] === 2) computed[i] = 0;
      }
      acc = acc + wbRecalc();
    }
    return acc;
  }

  function benchRecalcDirty(times: number): number {
    if (NCELLS <= 1005) return -1;
    let acc = 0;
    for (let t = 0; t < times; t++) {
      if (t % 2 === 0) wbSetNumber(5, 1000 + t);
      else wbSetNumber(1005, 2000 + t);
      acc = acc + wbRecalcDirty();
    }
    return acc;
  }

  function benchBuildVariant(variant: number, nCells: number): number {
    const cols = 1000;
    const rows = myFloor((nCells + cols - 1) / cols);
    wbInit(rows, cols);
    for (let i = 0; i < NCELLS; i++) {
      if (variant >= 0 && i % 10 >= 6) {
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
          const top = r - 10 < 0 ? 0 : r - 10;
          if (r === top) { continue; }
          const rg = newNode(N_RANGE);
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
          if (r === top) { continue; }
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
          if (r === top) { continue; }
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
    }
    return NCELLS;
  }

  return {
    wbInit, wbSetNumber, wbSetNumbers, wbSetFormula, wbGet, wbRecalc,
    wbInvalidateAll, wbRecalcDirty,
    benchParse, benchBuild, benchRecalc, benchRecalcDirty,
    benchBuildVariant,
    astCount: () => astCount,
  };
}

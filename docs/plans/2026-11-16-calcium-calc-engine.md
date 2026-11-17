# 2026-11-16 — Calcium: 스프레드시트 계산 엔진 (플래그십 프로젝트 컨셉)

**한 줄 정의:** 수식 언어(파서) + 의존성 그래프 + 증분 재계산을 담은 스프레드시트급 계산 엔진을,
하나의 TypeScript 코어(scriptc 컴파일)로 모든 호스트에서 돌린다 — **"one core, every runtime"을
제품으로 증명하는 첫 워크로드.**

배경: `docs/research/2026-11-16-wasm-vs-js-engine-findings.md` — wasm이 엔진 무관하게 이기는
구조적 3축(호출 프레임 지배 재귀 · 할당 지배 파이프라인 · 파싱/디코딩)이 확인됐고, 이 프로젝트는
세 축을 한 워크로드에 겹쳐 쌓는 설계다. 스프레드시트 재계산은 곧 "파싱(편집 시) + 그래프 할당 +
트리 워킹 평가(재계산 시)"의 연속이다.

---

## 1. 오늘 확보된 실측 근거 — 인터프리터 형상 프로브 (3엔진)

컨셉 결정 전에 아키텍처 분기(객체 그래프 vs 평행 배열)를 실측으로 확정했다.
프로브: `/tmp/calc-probe` (휘발 — 핵심 소스 부록 참조), 깊이 18 완전이진트리 = **524,287 노드**,
wasm(scriptc 0.4.12, release) vs 동일 알고리즘 JS 트윈, 7회 중앙값, 결과 parity 검증 통과.

| 형상 | Bun 1.4.3 (JSC) | Node 26 (V8) | 승자 |
|---|---|---|---|
| **A. 객체 노드** build+eval | JS **2.09×** 승 | JS **1.05×** 승 | JS |
| **B. SoA 평행배열** build+eval | wasm **1.73×** 승 | wasm **2.24×** 승 | **wasm** |
| B. SoA 순수 eval ×50 | wasm 66× 승 | wasm 78× 승 | ⚠️ 아티팩트 |
| **C. write-back eval ×50** (진짜 eval-only) | wasm **1.44×** 승 | wasm **1.60×** 승 | **wasm** |

**아키텍처 확정:**

- **A의 패배 원인 — scriptc 객체 런타임의 refcount 세금.** IR 확인: 클래스는 `%sc_o_Node` 구조체 +
  `getelementptr` 정적 오프셋 필드 로드로 정상 내려가지만(변환 명령 전체 6개뿐 — 인덱스 함정 없음),
  할당이 `scr_cyc_alloc` + retain/release/cycle-collector 체계라 노드당 refcount 트래픽이 붙는다.
  52만 노드 규모에서 이게 승리를 뒤집는다. **→ 설계 규칙 R1: 코어 안 객체 금지, SoA 아레나.**
- **B가 이기는 이유는 이미 증명된 승리축의 조합** — typed array 할당(pipeline 축) + 인덱스 재귀(fibTree 축).
  1.73~2.24×, 두 엔진 일관.
- **C가 이 프로젝트의 바닥층 숫자다.** write-back(셀 메모이제이션과 동일 형상, 불순) eval은
  wasm 1.44~1.60× — 재계산 지배 워크로드의 최소 승리폭. 엔진 위에 파싱·그래프·풀링이 더해지며 폭 확대.
- **B 순수 eval×50의 66~78×는 LLVM 아티팩트**: 순수 함수 반복을 `50×f()`로 strength-reduction한 것
  (노드당 0.2사이클 = 물리적으로 불가능하여 발견). JIT은 호출을 호이스팅하지 못하므로 구조적으로
  못 따라오는 최적화지만, 실제 엔진 eval은 불순하므로 **설계 기댓값에서 제외**. 단 배열 수식
  (같은 수식을 데이터 열에 반복 적용 = MAP/REDUCE/spill)은 "순수 평가의 반복" 형상이라 이 레버가
  실제로 당첨될 수 있는 후보 — M1에서 실코드로 검증할 것.

**Gecko(Zen/Firefox)는 미실측** → **M0에서 첫 실측 완료** (아래 1-b, 공식 Firefox 160 +
Marionette 리그; Playwright Firefox는 wasm 측정 불가 — research 문서 §4).

### 1-b. M0 완주 실측 (2026-11-16, 3엔진 전수)

M0 코드(`examples/calcium/`): 토크나이저(UTF-8 bytes in) + 재귀 하강 파서 + SoA 트리 워킹
평가기, A1 참조·함수 21개. 재귀 평가기로 시작해 **R8 프레임 머신으로 재작성**(하나의
디스패치 루프, 핫 패스에서 scriptc 호출 전부 제거) — golden 체크섬(100셀 + 5 variant
100k 체크섬)으로 **재작성 전후 bit-exact 검증** 후 측정. JS 트윈도 동일 머신으로 이식
(R6 공정성 — 알고리즘 동일, 타입만 관용적: tag=Uint8, 인덱스=Int32).

**패리티: 3엔진 전부 PASS (bit-exact)** — JSC·V8·SpiderMonkey 모두 체크섬 일치.

| 게이트 (100k 셀) | JSC (Bun) | V8 (Node 26) | SpiderMonkey (FF 160) |
|---|---|---|---|
| 파서만 ≥2× wasm | ✗ JS 2.14× 승 | ✗ JS 1.34× 승 | ~동점 (2ms vs 2ms, 타이머 정밀도 한계) |
| 전체 재계산 ≥1.5× wasm | ✗ JS 4.14× 승 | ✗ JS 2.88× 승 | ✗ JS 2.38× 승 |

Variant(형상별, wasm ms / JS ms — JS 승): SUM20 24.4/2.8 · IF3 6.6/1.3 · AVG10 12.8/2.0 ·
ROUND∘SQRT 11.1/6.7 · MAX-MIN15 34.6/4.9 (JSC). **단 한 형상이 Gecko에서 wasm 승**:
ROUND∘SQRT 11/12, IF3도 6/5 근접 — 수학 함수 밀도가 높은 형상에서만 wasm이 버틴다.

**정직한 판정: M0 게이트 패스 실패.** 그러나 원인 분리가 완료됐다 — 지는 이유가 엔진
설계가 아니라 **scriptc 코드젠 세금 3종**으로 특정됐고, 각각 프로브로 정량화했다:

| # | 세금 | 증거 (프로브/IR/wat) | 크기 |
|---|---|---|---|
| **T1** | **호출 박싱** — 모든 scriptc 함수 호출이 `sc_f_` 래퍼를 거침: 힙 `ptr` 반환 + 인자별 `scr_union_release` + `scr_exc_pending()` 폴 | IR에서 `sc_f_` 래퍼 전수 확인 | ~30ns/call |
| **T2** | **배열 접근 검사** — Float64Array 접근마다 인덱스-정수 검사 + f64 경계 검사 + i64 왕복 검사 + shift | wat에서 접근당 ~12 추가 명령 확인 | 디스패치당 ~10ns |
| **T3** | **union 글로벌** — 모듈 `let`을 배열 로드로 쓰면 박스형 union 글로벌로 하강(`@sc_g_* = global ptr`), 쓰기 = `scr_union_new_f64` + release | `probeAccGlobal` vs `probeAccArray` | 50.4 vs 2.2 ns/iter (6 RMW) = **23×** |

프레임 머신 재작성으로 T1·T3을 엔진에서 제거했다(재귀 18.0 → 머신 25.2ms로 오히려
느려진 JSC SUM20을 gg 레지스터 + `+0` 란더링 + 상태 로컬화 + FT_AGR 내부 루프로
25.2 → 개선; IF3 19.1→6.3, ROUND∘SQRT 27.9→11.1). **잔여 격차의 대부분이 T2** —
엔진 측 레버는 소진됐고, 남은 패배분은 툴체인 수정(T1-T3)으로 돌아가는 것이 정직한
결론이다. T1-T3은 scriptc 로드맵 항목으로 그대로 이관된다(= 이 프로젝트의 존재 이유:
툴체인을 시험하는 워크로드).

**파서 축 정정:** 설계 가정(파서 = wasm 승리축)은 **3엔진 모두에서 기각**. 문자 분류
if-chain은 JIT이 동등하게 컴파일하며, scriptc 파서는 토큰당 함수 호출(T1)로 느려진다.
파싱 승리는 T1 수정 후 재측정이 필요하다.

### 1-c. T2 재분해 — 루프 형태가 진짜 축, FT_AGR 재작성 (2026-11-17)

**T2(변환 검사) 가설 기각.** `|0` 인덱스 호이스트로 FT_AGR의 IR 왕복 검사 fptosi 166→34
감소, golden bit-exact — 그러나 **런타임 무변화**(JSC 24.6→24.4ms). LLVM -O2가 이미
대부분的中和시켰다(최종 wat conv 86→55, br_if 489→406). 접근당 명령 수는 병목이 아니었다.

**어블레이션으로 밝혀진 진짜 축 = 루프 형태 + 누산기 표현** (`/tmp/int-probe`, FT_AGR
내부 루프 재현, 셀당 ns, wasm/JS twin 동일 알고리즘):

| 형태 | wasm | js | w/j | 의미 |
|---|---|---|---|---|
| P3 while 순수 워크 | 2.21 | 0.37 | 6.02 | while = per-access 검사 잔존 |
| P4 counted for 동일 산술 | 0.37 | 0.37 | **1.00** | **for 형태만 loop-versioning → 검사 소멸** |
| P6 for+break+로컬 누산기 | 2.29 | 1.94 | 1.18 | break 있어도 버전닝 유지 |
| P7 while+break+로컬 누산기 | 4.03 | 1.57 | 2.56 | 누산기 로컬화 단독 효과와 대조 |
| S4 stride for+locals (SUM20 실제 형상: 세로 20셀 stride NCOLS) | 1.32 | 0.91 | 1.46 | while+gg(2.82) 대비 **2.13×** |

- scriptc counted-loop 패스는 **for 형태만** 인식(while은 미인식) — 동일 산술의 P3/P4가
  6.02× 차이. 파생 인덱스(`s + rr*NCOLS`)보다 **stride 루프 변수 그 자체**(`cur += NCOLS`)가
  빠르다(S4 1.32 vs S5 1.80).
- gg(Float64Array 레지스터 슬롯) RMW 세금: 누산기를 f64 로컬로 호이스트하면 형태별
  −1.15(while) ~ −3.27(for) ns/cell.

**FT_AGR 재작성 (core.ts + twin.ts 대칭):** 단일 열 범위 = stride-NCOLS counted 루프,
다열 범위 = 행 while + 열 counted for 중첩, gg 6개를 f64 로컬로 호이스트(pause 시
원복), formula 셀 pause/resume 상태는 mB/mC에 보존(재진입 시 같은 셀 재검사·누적).
**golden bit-exact — 기존 5 체크섬 전부 불변.**

| 재계산 게이트 (100k) | JSC | V8 | SpiderMonkey FF160 |
|---|---|---|---|
| §1-b (while+gg) | JS 4.14× 승 | JS 2.88× 승 | JS 2.38× 승 |
| **FT_AGR 재작성 후** | **JS 2.10× 승** | **JS 1.57× 승** | JS 1.50× 승¹ |

¹ Gecko 중간 수치 보정(11-17): rig의 drive.ts는 결과를 **stdout**에만 출력하고 out.json은
갱신되지 않음 — 그날 그날 stdout을 캡처하지 않으면 부실 파일을 읽게 된다(하루치 "20/9" 독수가
전부 이 함정). Gecko 참값은 §1-d 최종 표(캡처 stdout 기준)로 통일.

게이트(≥1.5×)는 여전히 MISS이나 격차 절반 이상 회복. 잔여 = 디스패치/FT_NODE·REF
경로 + 파서의 T1 호출 세금. counted 인식의 while 확장은 툴체인 이관 항목으로 유효.

Variant별(wasm ms / js ms, §1-b → 재작성 후): **SUM20** JSC 24.4/2.8 → 6.1/2.1 (8.7×→2.94×,
wasm 자체 4.0× 빨라짐) · **MAXMIN15** 34.6/4.9 → 10.8/3.9 (7.1×→2.77×) · **AVG10**
12.8/2.0 → 4.6/1.7 (6.4×→2.64×) · IF3 6.6/1.3 → 6.1/1.7 (5.1×→3.60×, 집계 없는 형상 —
디스패치 경로가 다음 병목임을 시사) · ROUNDSQRT 11.1/6.7 → 10.5/7.2 (1.66×→1.47×).
V8은 전 variant 1.30~1.75, Gecko(SUM20 2.0 · ROUNDSQRT 1.0) — ROUNDSQRT(수학 함수 밀도)는
전 엔진에서 최접전.

**철회 2건 (§1-b 이후 기록한 "scriptc 버그" 후보):** (a) 모듈레벨 대형 `Float64Array`
NaN, (b) module-const 루프 바운드 NaN — 재검증 결과 전부 **수동 로더 프로필에
`abi.init_symbol` 누락**이 원인(`wasm-loader`는 프로필에 심볼이 있을 때만 모듈 init
호출 → 모듈 const가 0으로 읽힘 → 범위 붕괴). scriptc 무결, upstream 이슈 철회.
교훈: 손으로 프로필을 쓸 때 `abi.init_symbol`은 필수. (덤: golden.ts 비교를
NaN-faithful하게 수정 — `NaN !== NaN` 허위 MISMATCH.)

### 1-d. M1 완주 + 스캔 플로어 해부 — 정체는 T4 `===` 박싱 (2026-11-17)

**M1 기능 전부 완주** (core.ts + twin.ts 대칭, 테스트·골든으로 독립 검증):

- **의존성 그래프**: SoA packed (start,count) 리스트를 공유 bump 풀(꼬리 append O(1),
  재배치 2×)에 fwd+rev 양방향. `wbSetFormula`는 전역 무효화 대신 `computed=0` +
  `markDirty` 전이폐쇄. `wbRecalcDirty` = dirty 마스킹 후 기존 wbRecalc 스윕 그대로
  (수요 주도 pull = 위상정렬 → 전체 재계산과 bit-identical, 테스트 100셀 × 9편집
  전수 비교로 확인). `wbInvalidateAll` + `wbRecalc` = 전체 재계산.
- **LET/LAMBDA**: 바인딩 스택 + 셀별 bind floor(ctxSave를 seed/N_REF pull/AGR pause에
  push, FT_CELL이 pop). 콜러블은 일급 아님(bindKind=1, 값 = AST 노드 id; 값 위치의
  콜러블 → NaN). 자유 이름은 호출 시점에 호출 셀의 floor까지 동적 해석. 깊이 상한
  200 초과 → NaN (팩토리얼 10 = 3628800, g(150) = 151, g(250) = NaN 골든 고정).
- **SUMPRODUCT** (배열 수식 대표, FT_SP2/FT_AGR2): 인자가 정확히 2개 N_RANGE고
  형상 일치(앵커는 상수 차이 허용) 아니면 NaN, 빈 곱=0, NaN 전파, pause 순서 =
  cell1 완주 후 cell2.

검증: `test.ts` ALL PASS(증분 대 전체 패리티, 사이클 파괴·재생성, 수식→숫자 전환,
신규 의존 수식 포함) · golden `.m1` 섹션 추가 — **M0 오라클 6개 체크섬 byte-identical**,
twin 양쪽 suite 동의.

**스캔 플로어 해부 — 정체는 T4(`===` Scratch 박싱), 인라인 붕괴설은 철회 (2026-11-17):**
0-수식 100k 순수 스캔이 wasm 17~18ns/cell(twin 2.3)이던 벽을 분해 프로브로 절단:
finder(scanFind)는 **0.02ns/cell로 처음부터 무료**, 벽 전부가 **checksum의
`x === x` NaN 자기검사**였다(14.1ns/cell). **scriptc의 `===`는 f64 피연산자를 일반
Scratch 값으로 박싱** — wabt로 확인: 요소마다 `call`(박스 생성) → 태그 br_table →
offset 24 언박싱 → `call`(release). `<`/`>`는 단형 f64 비교로 박싱 없음(단일 비교
1.07ns/cell). 어블레이션: bare 덧셈 0.96 · `===` 포함 14.06 · u8 배열+같은 펜스 0.53
(u8→f64는 NaN이 아니라고 정적으로 증명돼 펜스가 상수폴딩 — "펜스가 저렴"이 아니라
"펜스가 소멸"). **수정: `x === x`는 애초에 중복** — NaN은 `x < HI && x > LO` 양쪽 모두
거짓이라 펜스만으로 이미 제외됨. 술어 bit-identical → golden 오라클 불변. 같은 세금이
FT_AGR/SP2의 `d0 === d1`(load 대 load)에도 있어 `!(d0<d1) && !(d1<d0)`로 교체(파서가
정수 코너를 보장). 디스패치의 `tag === 상수`는 박싱 없음(8.2ms 재계산에 13M 박스는
물리적으로 불가능 — 산술로 반증). 어제 기록한 "LLVM 인라인 붕괴"설은 **철회**: 헬퍼는
실제로 거대 함수에 인라인되지만(1e38 펜스 사본 다수가 wbRecalc 내부) 인라인된 채로
충분히 빠르다 — 루프 문맥이 아니라 루프 **본체의 박싱**이 축이었다. runCell 분리·
재귀 가드는 성능 중립으로 유지(구조 위생). kinds/computed/visiting·ftTag·ndKind·
bindKind → Uint8Array도 유지(형상 일치 + `===` 상수폴딩 보너스).

**최종 게이트 (2026-11-17, T4 수정 후 전 엔진 재실측)**:

| 게이트 | JSC (Bun) | V8 (node 26) | SpiderMonkey (FF160 rig) |
|---|---|---|---|
| 파서 ≥2× wasm | MISS — JS 2.21× 승 | MISS — JS 1.40× 승 | 동점 (2 vs 2ms) |
| 재계산 ≥1.5× wasm | MISS — JS 1.85× 승 | MISS — JS 1.29× 승 | MISS — JS 1.17× 승 |
| 증분 1편집 ≥5× | MISS — JS 1.68× 승 | MISS — **wasm 1.48× 승** | MISS — **wasm 1.33× 승** |
| 패리티 bit-exact | PASS | PASS | PASS (체크섬 4.906…e+6) |

같은 날 T4 수정 전 → 후: 재계산 JSC 2.01→1.85 · V8 1.54→1.29 · Gecko ~2.2→1.17,
증분 JSC 12.7→1.68 · V8 10.4(wasm 패배)→1.48(wasm 승) · Gecko →1.33(wasm 승),
순수 스캔 17~18 → **1.6ns/cell(wasm 첫 승)**.

Variant(Gecko wasm/js ms): SUM20 4/3 · IF3 5/4 · AVG10 3/3(동점) · ROUNDSQRT 10/11
(**wasm 승**) · MAXMIN15 8/7. JSC(T4 후 재실측): SUM20 5.6/2.2 · IF3 6.8/2.6 · AVG10
4.6/1.8 · ROUNDSQRT 11.2/8.2 · MAXMIN15 9.8/4.1 — Gecko는 사실상 패리티 도달.

잔여 축: (1) 파서 T1 호출 세금 + 토크나이저(JSC 파서 게이트가 최대 미스) (2) 디스패치·
FT_NODE/REF 경로(IF3) (3) **툴체인 이관(T4): f64 `===`/`!==`를 박싱 없는 숫자 비교로
컴파일** — 양쪽 정적 타입이 f64로 좁혀지면 박스 경로 자체가 불필요. 이것이 while counted
인식(≈1.74ns/cell)과 함께 유효한 상류 처방 2건.

### §1-e 잔여 축 해법 — 낮은 지렛대를 어떻게 올리나 (2026-11-17)

잔여 축의 해법을 "지금 코어에서"와 "상류(툴체인)에서"로 나눠 확정:

1. **파서 T1+토크나이저** (게이트 최대 미스, JSC 파서 2.21×) — **엔진 재작성 완료 (2026-11-17)**
   - 지금(엔진): 파서를 **단일 함수 shunting-yard**로 재작성(`parseSub` 명시적
     op/값 스택). 우선순위 배터리 55수식 × 엔진+트윈 + golden bit-exact 통과.
   - **함정(IR)**: `valTop = psBase[m]`이 typed-array `idxOr` 유니온을 그대로 대입하면
     `valTop`이 함수 전체에서 tagged union으로 넓어지고, 매 `valTop±1`이
     `scr_union_new_f64`+`release`가 된다(재작성 직후 wasm ~1300ns/수식 회귀).
     처방: `psBase[m] + 0` 세탁 → 파라미터/로컬이 다시 raw f64
     (`scr_union` 112→34, IR 7763→5684줄). bun versus: twin 파싱 321→209ns,
     wasm ~811→895ns(회귀 회복·트윈 격차 축소). 추가 승리는 상류 P4/P5.
   - 상류(근본): sc_f_ 래퍼의 **즉시값 반환 경로** — 반환 값이 escape하지 않으면
     박스 대신 레지스터 반환, 인자별 `scr_union_release` 제거,
     `scr_exc_pending()` 예외 폴을 호출당이 아니라 루프당 1회로.
   - 참고: versus 벤치(§1-f)에서 calcium 파서는 native ~473ns/수식으로
     expr-eval(~1.7µs/수식)보다 이미 3.6× 빠르다 — "느린 축"은 상대적.
2. **디스패치·FT_NODE/REF 경로** (IF3) — **어블레이션 1차 (2026-11-17)**
   - `benchBuildVariant` 100k 재계산(bun/JSC, ms): IF3에서 wasm/twin 비가 최악.
     | variant | wasm | twin | w/t |
     |---|---:|---:|---:|
     | mixed0 | 4.67 | 2.03 | 2.30 |
     | **IF3** | **6.36** | **1.80** | **3.53** |
     | AVG10 | 3.85 | 1.73 | 2.22 |
     | ROUNDSQRT | 10.73 | 7.09 | 1.51 |
     | MAXMIN15 | 8.56 | 3.73 | 2.29 |
   - IF3는 노드 수(CALL+GT+REF×3+NUM×3+MUL+DIV)가 많아 FT_NODE 디스패치 횟수가
     폭증 — twin은 IF3가 mixed보다 빠르고 wasm만 느려짐 → **노드 스텝 고정비**가
     축. 마이크로프로브 `probeMachineNode` ≈5.5ns/op(wasm). 다음 엔진 레버:
     IF 전용 단축(조건만 평가 후 한쪽 가지) 또는 REF 셀-값 직로드 강화.
   - 상류: T3 잔여 — 핫 경로에 union 글로벌 쓰기가 남으면 f64 narrowing.
3. **토크나이저는 독립 축이 아니다** — research §6 T1 실측에서 문자 분류
   if-chain은 JIT가 동등 컴파일. 1번의 호출 제거가 곧 이 축의 해법.

**상류 처방 목록 갱신(컴파일러 소스 필요 — 본 머신에 없음):**
P1 f64 `===`/`!==` 비박싱 컴파일(T4) · P2 while counted 인식(≈1.74ns/cell, T2) ·
P3 생성 browser.ts의 `BatchEntry` import 누락 · P4 sc_f_ 즉시값 반환(T1 근본) ·
P5 정수 범위 추론 → i32 산술(research §5.1 — 정수 커널 전반).

### §1-f M3 공개 벤치 — HyperFormula·expr-eval 대비 (2026-11-17)

`examples/calcium/bench.versus.ts` — 하나의 북 생성기(benchBuild 정준 혼합:
IF3/AVG10/ROUNDSQRT/MAXMIN15, 100,000셀·39,800 수식)가 **수식 문자열**을 모든
엔진에 공급. calcium은 wbSetFormula(실제 파서 경로 — benchBuild의 AST 우회 아님),
HF는 buildFromArray. HyperFormula 3.5.0(`licenseKey: 'gpl-v3'` — bench 전용,
제품 반입 없음). 중간값(load 5회 · recalc/incremental 7회).

| 게이트 | calcium native(.so/.node) | calcium wasm | JS twin | HyperFormula | expr-eval |
|---|---|---|---|---|---|
| load(파싱+구축) ms, bun JSC | **39.7** | 61.4 | 22.3 | 329.6 | — |
| load ms, node V8 | **44.5** | 54.7 | 35.8 | 326.9 | — |
| 전체 재계산 ms, bun | **5.15** | 7.55 | 5.81 | 392.8 | — |
| 전체 재계산 ms, node | **5.37** | 6.65 | 5.38 | 348.6 | — |
| 증분(셀 1편집) µs, bun | 160 | 164 | 73 | **12.4** | — |
| 파싱 ns/수식, bun | **447** | 811 | 321 | (일체) | 1,802 |

- **native는 HF 대비 load 8.3×(bun)/7.3×(node), 전체 재계산 76×(bun)/65×(node)
  승** — M3 게이트 "네이티브는 이긴 채 출발" 충족. 트윈(관용적 JS)조차 HF를
  재계산 ~67× 앞선다: 승리의 1차 원인은 알고리즘(SoA+플랫 배열+프레임 머신),
  컴파일이 그것을 증폭.
- **값 패리티 증명**: 39,800/39,800 수식 셀이 상대 1e-9 이내 일치(최대 5e-11,
  ROUND 양자화 variant는 bit-exact). 체크섬 Δ130/4.9e6 = 2.7e-5(합산 순서 ulp).
  서로 다른 두 구현이 같은 북에서 같은 값 — 공개 벤치의 신뢰성 축.
- **HF가 이긴 축(정직 기록)**: 증분 편집 12~14µs vs calcium 73~168µs. 단 calcium
  측 수치는 `benchRecalcDirty`가 재계산 후 **전체 체크섬 검증 패스**(100k셀
  ~1.6ns/cell ≈ 160µs)를 포함 — 검증 없는 순수 dirty-클로저 재계산만 하면
  수µs 대로 내려같은 구조. 공개 시 측정 정의를 명시할 것.
- **기능 갭**: HF는 LET/LAMBDA 미지원(CellError NAME/ERROR) — M1 기능 그대로
  차별점. 파서는 expr-eval 대비 4×(native) 빠름.

**버그 2건 발견·수정(2026-11-17, versus 벤치 준비 중):**

1. **(수정 완료 — in-repo) 생성 클라이언트의 Bun tiering이 엔진 인스턴스를
   분열.** `packages/core/src/codegen.ts`가 내보내는 node/bun 클라이언트 템플릿의
   "tiering refinement": 스칼라 export는 bun:ffi(**libcalcium.so** 인스턴스),
   string/bytes export는 N-API addon(**calcium.node** 인스턴스)로 라우팅 — 마셜링이
   addon C에서 더 빠르다는 이유(~0.65 vs ~0.85µs). 그러나 두 바이너리는 컴파일된
   코어의 **별도 인스턴스**라 상태 있는 모듈은 호출 시그니처별로 상태가 갈라진다:
   calcium에서 `wbSetFormula`(bytes→addon)는 NROWS/NCOLS=0인 빈 책에 파싱되고
   `wbRecalc`(f64→.so)는 다른 인스턴스를 재계산 — 참조 파싱 전부 실패, 체크섬 0.
   진단: probeRefDiag/A~D로 T_CELL 조건의 NCOLS 읽기가 0임을 격리(dbgRect는
   정상 — 전역 읽기 자체가 아니라 인스턴스 분열). **수정**: tiering을 전면
   폐지하고 "한 클라이언트 = 한 엔진 인스턴스" 불변식으로 — bun은 .so 전체,
   node는 addon 전체(또는 addon:false). batch도 addon 임원 대신 mod.batch로.
   codegen.test.ts 2건 갱신, packages/core 120 테스트 통과.
2. **(기록 — API 마찰 6번) `wbSetNumbers`는 정수 전용 big-endian 디코더.**
   8바이트를 `b₀×2⁵⁶+…+b₇` 정수로 해석 — IEEE-754 f64 디코딩이 아니다.
   `Float64Array` 버퍼를 그대로 넘기면 1e19 규모 쓰레기값(소수는 표현 불가).
   versus 벤치는 셀 단위 `wbSetNumber`로 우회. f64 벌크 세터가 없다 — 후보:
   `wbSetF64s` 추가 또는 wbSetNumbers 의미 수정(사용처 없어 파열 변화 없음).

**M2 프런트엔드 제작(2026-11-17) 중 확인된 엔진 API 의미·마찰** — 코어가 아니라
프런트엔드에서 우회한 것들(1~5, 아래). 6번은 M3 벤치 준비 중 발견(§1-f):

1. **0 나누기 = IEEE Infinity(NaN 아님)** — `#ERR!`/`IFERROR`가 못 잡는다(스프레드시트
   관례는 `#DIV/0!`). 데모의 오류 셀은 `=SQRT(0-A1)`(NaN → #ERR!)로 우회.
2. **맨몸 텍스트 = 미바인딩 이름 → 0** — 수식이 아닌 상수 텍스트 셀을 구분할 방법이 없다.
3. **생성된 browser.ts가 `BatchEntry`를 import 없이 참조** — 생성기 버그(3번째 상류 건).
   `site/scripts/sync-calcium.mjs`가 복사본에 import 줄을 패치해 우회.
4. **`wasmUrl`은 절대 URL이어야** — `new URL('calcium.wasm', document.baseURI)`로 해결.
   상대 경로가 그대로 new-URL/fetch를 타면 실패.
5. **`wbClear` 부재** — 데모는 "재시작"이 아니라 초기 북 재적립(reseed)으로 초기화.
6. **`wbSetNumbers` = 정수 전용 big-endian 디코더** — Float64Array를 그대로 넘기면
   1e19 규모 쓰레기값(§1-f 버그 2번). f64 벌크 세터 부재.



---

## 2. 제품 정의 — 무엇이고, 무엇이 아닌가

**하는 것:** 계산 엔진(HyperFormula 포지션). 수식 파싱 → 의존성 그래프 → 평가/증분 재계산 → 값 조회.
**하지 않는 것:** 그리드 UI·렌더링·포맷·undo (호스트 앱의 역할 — 우리는 그 계산 심장).

시장의 구멍: no-code/로우코드(Airtable·NocoDB 계열), 핀툴·프라이싱 엔진, 검증 API, 엣지 워커가 전부
"안전한 수식 평가"를 필요로 하는데, 현실은 (a) `eval`류 보안 구멍 또는 (b) 느린 JS 인터프리터
(expr-eval/jexl/mathjs 급) 또는 (c) 플랫폼마다 각자 구현한 formula 엔진 — **셀 하나의 semantics가
클라이언트/서버/엣지에서 달라지는 버그 클래스**. 하나의 코어가 전 호스트에서 돈다는 scriptca의
가치가 마침표까지 성립하는 유일한 워크로드: **수식 semantics가 자동으로 하나다.**

부수 스토리: wasm 쪽 메모리 회수는 결정적(refcount) — 재계산 중 GC 스파이크가 없어 인터랙티브
지연이 예측 가능하다. 처리량만이 아니라 p99 지연도 지표로 삼는다.

### 언어 스코프 (Excel 호환 부분집합)

- 참조: `A1`, `$A$1`, `A1:B99`, 시트 한정 `Sheet1!A1`
- 함수 1차 ~60개: SUM/AVERAGE/MIN/MAX/COUNT(+IF/S), IF/IFS/AND/OR/NOT, ROUND/ABS/MOD,
  CONCAT/LEN/LEFT/RIGHT/MID, IFERROR
- `LET` + `LAMBDA` (+ MAP/REDUCE 배열 수식) — 클로저를 AST+환경 체인(SoA)으로 표현:
  **재귀 + 할당 축을 정면으로 쌓는 기능**. LAMBDA 재귀 호출은 fibTree 형상.
- 오류 값(#DIV/0! 등)은 f64 NaN + 태그 비트 방식(부록 참조) — 객체 없이 표현

---

## 3. 아키텍처 원칙 (실측에서 나온 규칙)

| # | 규칙 | 근거 |
|---|---|---|
| R1 | **코어 안 객체/클래스 금지** — AST·그래프는 SoA 평행 배열 아레나 (`kind: u8[]`, 자식·다음·env를 `i32[]` 인덱스, 값 `f64[]`) | 프로브 A: refcount 세금으로 JS에 1.05~2.09× 패 |
| R2 | **셀 스토어는 항상 f64** (정수 값이라도) | sumBytes 교훈: u8→f64 변환 비대칭이 JIT 정수 추측에 문을 연다. f64 저장이면 산술은 양쪽 다 f64 — 승부는 경계·호출·메모리 구조로 |
| R3 | **경계는 bytes in/out 단일 coarse 호출** — 수식은 UTF-8 bytes로 편집 시 1회, 값 반환은 f64/배치 | 경계 마셜 세금 상각(research 원인 ②③) |
| R4 | **아레나는 재계산 간 풀 재사용** — 편집마다 재할당하지 않는다 | pipeline 축 + B 프로브의 할당 비용; JS 트윈도 동일 풀링 허용(공정성) |
| R5 | **다형적 디스패치 금지, kind별 jump-table/switch** — deopt 없음은 wasm의 공짜 이점이지만 객체 없이 누린다 | 엔진 편차(재계산 지연 안정성) 지표 |
| R6 | **JS 트윈은 동일 알고리즘·관용적 TS** — 짚투리 금지 | 사이트 신뢰성 원칙(기존 데모와 동일) |
| R8 | **핫 패스 = 단일 프레임 머신** — 디스패치 루프 하나를 평가 최상위에 인라인, 프레임(ftTag·ftA..ftF)·값 스택(vstk)·집계 레지스터(gg)로 재귀 제거. 핫 상태(fp/sp/상수/배열 ref)는 전부 함수 로컬로 국소화 | T1(호출 박싱 ~30ns/call)·T3(union 글로벌 23×) 회피 — 재귀 평가기는 호출당 세금, 글로벌 누산기는 쓰기당 세금. 머신화 + 국소화로 JSC IF3 19.1→6.3ms (§1-b) |

---

## 4. 마일스톤 + 벤치 게이트

| 단계 | 내용 | 통과 게이트 (모두 V8+Gecko 양쪽) |
|---|---|---|
| **M0** | 토크나이저(UTF-8 bytes in) + 재귀 하강 파서 + SoA 트리 워킹 평가기, A1 참조·함수 20개 | **완주(2026-11-16): 패리티 PASS 3엔진 bit-exact · 게이트(파서 ≥2×, 재계산 ≥1.5×) MISS — 원인 = scriptc 세금 T1/T2/T3(§1-b)으로 특정·정량화, 툴체인으로 이관** |
| **M1** | 의존성 그래프 + 증분 재계산 + LET/LAMBDA + 배열 수식 | **기능 완주 + T4(`===` 박싱) 수정까지 반영(2026-11-17, §1-d): 패리티 PASS(증분≡전체 bit-exact 포함) · 재계산 JS 1.17~1.85× 승(Gecko 사실상 패리티) · 증분 V8/Gecko는 wasm 승(1.33~1.48×) — 잔여 = 파서 T1·디스패치 + 상류 처방 2건(T4 비박싱 컴파일, while counted 인식)** |
| **M2** | 사이트 플래그십 데모: 그리드 캔버스 + 수식바 + "10만 셀 재계산 레이스"(wasm/JS 라이브 토글) | **완주(2026-11-17): CalciumPanel(데모 탭 2번째, mandelbrot 다음) — 편집 가능 8×15 북(Enter/Esc/F2/방향키, #ERR!), 수식바, 10만 셀 레이스(전체 benchRecalc(1) + 증분 benchRecalcDirty(1), 7회 중앙값 AB/BA 교차), 패리티 뱃지(체크섬 일치). 브라우저(V8) 실측: 전체 JS 1.03× 대등 · **증분 wasm 2.00× 승**(100µs vs 200µs) · 패리티 ✓. 엔진 wasm은 calcium 전용 클라이언트(`site/src/calcium/`)로 vite 공용 dropin을 우회하고, 빌드는 `sync:calcium`(재빌드-필요시 동기화)로 typecheck/build에 묶임. 검증: 엔진 golden+twin 무변경, typecheck·build 통과, dev 서버 브라우저 E2E(그리드 119셀·레이스 실행·패리티 ✓) |
| **M3** | 멀티호스트 제품화: `@unikit-bridge/*` 패키지, node 서비스/Workers 엣지 프라이싱/RN 오프라인 예제, HyperFormula·expr-eval 대비 공개 벤치 | **공개 벤치 축 완주(2026-11-17, §1-f)** + **파서 shunting-yard·IF3 어블레이션(§1-e)**. 게이트 "네이티브는 이긴 채 출발" 통과. node 프라이싱 스케치 `host-node-pricing.ts`(`bun run host:pricing`). **잔여 = `@unikit-bridge/calcium` 패키지화 · Workers/RN 호스트 예제** |

## 5. 정직한 리스크

- **SUM 등 합산의 정수 추측**(sumBytes 형상) — R2(f64 스토어)로 산술 비대칭을 제거하지만, V8이
  f64 배열 합을 더 잘하는 엔진 편차는 남는다. 게이트는 양 엔진 동시 통과로 방어.
- **문자열 경계** — 수식 편집은 저빈도 coarse 호출로 무해. 다만 문자열 함수(CONCAT 등) 결과가
  커지면 복사 세금이 돌아온다: M1에서 문자열 스토어(bytes arena) + 배치 조회로 완화.
- **LLVM 순수호이스팅(66~78×)은 기대치에서 제외** — 프로브 아티팩트로 판명된 이상 설계에 반영하지
  않는다. M1의 배열 수식(SUMPRODUCT)은 이 레버 없이 counted 루프로 구현 — 재검은 다루지
  않았고, 언제든 필요하면 그때 이야기한다.
- **깊은 재귀의 파괴자** — scriptc의 `sc_release_*_destroy_d`는 깊이 플래그가 있으나, 아레나 설계는
  파괴 자체가 없어(풀 해제) 이 리스크는 구조적으로 회피됨.
- **M1 진행 조건 (M0 실측 후 추가, 2026-11-17 T4 수정 후 갱신)** — 성능 게이트는 툴체인 수정
  전까지 불가능하다는 초기 진단은 **두 번 부분 정정**: (1) T2의 절반은 엔진 측 루프 형태로 회복
  (§1-c counted 루프화), (2) "스캔 인라인 붕괴"로 알았던 증분 게이트의 벽은 사실 **T4 — scriptc
  `===`가 f64 피연산자를 Scratch 값으로 박싱**(§1-d)하는 것이라 엔진 측 처방(`===` 재작성)으로
  제거됐다. 재계산 게이트는 Gecko 1.17×까지 접근, 증분은 V8/Gecko에서 wasm 승. 잔여 = 파서
  T1·토크나이저 + 디스패치 경로. **상류 처방 2건**: f64 `===` 비박싱 컴파일, while counted
  인식(≈1.74ns/cell).

## 6. 경쟁 지형

| 솔루션 | 형태 | 약점(우리의 구멍) |
|---|---|---|
| HyperFormula | JS 엔진 (AGPL/상업) | JS 전용 — wasm/네이티브 없음, 호스트별 성능 운명 |
| expr-eval / jexl / mathjs | JS 표현식 | 스프레드시트 참조 모델·증분 재계산 없음, 느림 |
| CEL (Google) | Go/호스트별 포트 | API 게이트웨이 특화, 브라우저/모바일 스토리 약함 |
| 엔진 내장(앱별 자체 구현) | 제각각 | semantics 분기 버그 — 바로 우리 스토리 |

빈 자리: **wasm + 하나의 코어 + 증분 재계산 + 전 호스트**. 전방위 스프레드시트(Excel 대항)가 아니라
계산 심장 시장을 노린다.

## 7. 이름

- **Calcium** (Ca) — 1순위. `calcium`은 npm에 선점 → 패키지는 스코프로 (`@unikit-bridge/calcium`).
- 차선: **Cellscript** (수식 언어 뉘앙스), **Tally**.

---

## 부록 — 프로브 핵심 ( /tmp/calc-probe 휘발 대비 )

```ts
// A. 객체 형상 (패배 — refcount 세금): class Node {kind,val,l,r} + 재귀 build/evaluate
// B. SoA 형상 (승리): 힙 배치 평행 배열 + 인덱스 재귀
// eval2: kind/val 읽기 전용 평가 (순수 → LLVM이 50×f()로 strength-reduction, 아티팩트)
// eval3: write-back 평가 (불순 = 진짜 eval-only 비용, wasm 1.44~1.60×)
function eval3(i: number, kind: Uint8Array, val: Float64Array, n: number): number {
  const l = 2 * i + 1;
  if (l >= n) return 1;
  const lv = eval3(l, kind, val, n);
  const rv = eval3(2 * i + 2, kind, val, n);
  const k = kind[i]; const v0 = val[i];
  let v: number;
  if (k === 0) v = v0 + lv + rv;
  else if (k === 1) v = v0 + lv * 0.5 + rv * 0.5;
  else v = v0 * 2 + lv + rv;
  val[i] = v;              // 셀 메모이제이션과 동일 형상
  return v;
}
// 측정: Bun 1.4.3(JSC)·Node 26(V8) · 깊이 18 = 524,287 노드 · warmup 3 + 7회 중앙값 · parity 검증
// 재현: scriptca.json exports에 probeTree/probeTree2/probeTree3 (f64[,f64])→f64, --target wasm
```

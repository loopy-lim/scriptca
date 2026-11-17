# 2026-11-16 — 사이트 라이브 데모, 엔진별 WASM vs JS 실측 (Zen 리포트 추적)

**호스트:** Arch linux-x64 (Core Ultra, 32 threads) · **엔진:** Chromium 155 headless(V8), 공식 Firefox 160.0 headless + Marionette(SpiderMonkey — Zen과 같은 계열)
**계기:** "Zen browser에서는 사이트 데모에서 JS가 wasm보다 빠르게 나온다"는 리포트. 재현·원인 분석 후 사이트 카피/하니스 보정 반영.
**방법:** `site/` vite dev(5199)에서 패널과 동일한 배치·바운드로 `measurePair`를 페이지 내 실행(`/.scriptca/generated/dropin/browser.ts` 실경로). 각 엔진 2회 실행, 결과 일관(±10%).
**측정 리그:** `/tmp/wasm-bench/{driver,probe,handwasm,f64probe,marionette-suite}.ts` — 휘발성이므로 핵심 스크립트는 이 문서 부록 참조.

---

## 1. 결과 매트릭스 (ratio = wasm÷js, **1 미만 = wasm 승**)

| 데모 | Chromium 155 (V8) | Firefox 160 (Gecko) | Gecko 승자 |
|---|---|---|---|
| add | 21.7× | ~43× | JS (경계 비용 — 설계상 예정) |
| fib 반복(40) | 2.5× | 1.9× | JS |
| **fib 재귀(30)** | **0.79** (wasm 1.3×승) | **0.38** (wasm 2.6×승) | **WASM** |
| repeat(100) | 3.6× | 2.9× | JS (string 왕복 마셜) |
| **sumBytes(1KB)** | **0.65** (wasm 1.5×승) | **3.5~4× — 뒤집힘** | JS |
| **pipeline(256KB)** | **0.30** (wasm 3.3×승) | **0.67~0.72** (wasm 1.4×승) | **WASM (승리 폭 축소)** |
| grayscale(256²) | 1.13× | 1.4~1.6× | JS |
| boxBlur(256²) | 1.77× | 1.4× | JS |
| sobel(256²) | — | 1.4× | JS |
| mandelbrot(256²,256iter) | 1.24× | 1.0~1.05 | 대등 |

JS 절대속도는 두 엔진이 대등(sumBytes 0.36 vs 0.28µs/KB, pipeline 1587 vs 1333µs) — **기울어진 건 항상 wasm 쪽**. Gecko에서는 10개 중 7개 데모에서 JS 승. Zen 사용자의 "JS가 더 빨라 보인다"는 정확한 관찰.

## 2. 원인 4가지 (특수한 경우)

1. **`number` = f64 정적 컴파일 vs JIT 정수 추측** — scriptc는 TS `number`를 JS 의미대로 항상 f64로 내보냄. `core.lib.ll`의 `sumBytes`는 요소마다 `uitofp` + `f64.add`. V8/SpiderMonkey는 타입 피드백으로 `sum += data[i]`(u8 합, 오버플로 없음)를 **i32 덧셈**으로 추측 → 변환 비용 0. `jsSumBytes` 0.27~0.36ns/byte(≈사이클 1)의 비결. sumBytes가 V8에서 wasm 승 → Gecko에서 JS 4× 승으로 뒤집히는 것도 SpiderMonkey의 typed-array 정수 루프가 특히 좋기 때문.
2. **경계 마셜링 세금** — `bytes` 파라미터 복사 in(`packages/core/src/wasm-loader.ts` `writeBytes`), `bytes` 반환 복사 out(`readResultBytes`의 `slice`). grayscale의 wasm−JS 격차(~26µs)가 512KB in+out 복사 비용과 일치.
3. **호출당 경계 비용** — add·fib-iter·repeat가 지는 구조. 사이트 카피도 이미 그렇게 설명(유지).
4. **pipeline 승리 폭의 엔진 편차** — Gecko는 JS 측(`Float64Array` 할당+GC)이 더 빠르고(1333 vs 1587µs) wasm 측은 이 커널에서 V8 wasm의 2배 시간(958 vs 479µs). 방향 유지, 폭은 3.3×→1.4×.

## 3. 하니스 보정 — Firefox `performance.now()` 1ms 클램핑

Firefox는 `performance.now()`를 **1ms로** 클램핑(Chromium 0.1ms, 실측 `timerMinDeltaMs` 1 vs 0.1). add/fib-iter처럼 샘플 1회가 1ms 미만인 데모는 Zen에서 0/1ms 양자화 = ±100% 노이즈(JS가 "0.00µs"로 표시되는 현상).
**수정:** `site/src/demo/bench.ts` — timed region이 `MIN_SAMPLE_MS=8`을 넘을 때까지 배치를 반복 후 회수 호출수로 나눔. 배치 함수는 count에 대해 순수하므로 반복은 측정 대상을 바꾸지 않음.

## 4. 측정 방법 주의 — Playwright Firefox는 wasm 성능 측정에 부적합

Playwright 빌드 firefox-1495(FF 142.0.1)에서 **모든 wasm이 영구히 Baseline 컴파일러에 갇힘**(tier-up 미발생): scriptca `sumRange`·손조립 초소형 모듈 모두 V8 대비 5~10× 느림, 30회 연속 호출·1M 반복 루프로 예산 소진에도 속도 변화 없음. JS(Ion)는 정상 속도. pref(`wasm_lazy_compilation`, `wasm_delay_tiering`) 무효.
**교훈:** Gecko wasm 성능은 공식 tarball + Marionette(`--headless --marionette`, `WebDriver:ExecuteScript`, 응답은 `{value}` 래핑)로 측정할 것. 손조립 wasm 고립 모듈(본 문서 부록 `f64probe`)로 "모듈 문제 vs 엔진 문제"를 분리하는 검증이 유효.

## 5. scriptc 개선 방향 (요청된 정리)

1. **정수 범위 타입 추론 → i32 산술 emitted** (근본 해결, 공수 큼)
   - 근거: 원인 1. `data[i]`(u8)·인덱스·누산기가 정수 범위로 증명되면 `uitofp`/`f64.add` 대신 `i32.add` 체인 생성. sumBytes·이미지 필터·resize 등 정수 커널이 wasm 승으로 복귀할 가장 직접적 경로.
   - 조건(보수적): 피연산자 전체가 정수임이 증명(리터럴, u8/i32 배열 원소, 정수 인덕션), 합산 오버플로 부재 또는 i64 승격, `-0`/NaN/2^53 경계 미통과. 증명 실패 시 기존 f64 그대로 — 의미론은 언제나 JS.
   - 단위: `sum += data[i]`(u8×n, n<2^24), `(r/n)|0` 픽셀 산술, grayscale luma식부터.
2. **bytes 왕복 복사 절감 — '대여 버퍼' API** (경계 세금, 공수 중)
   - 동일 버퍼를 반복 호출하는 소비 패턴(이미지 파이프라인, 신호 처리)에서 매 호출 복사 in/out이 지배. 로더에 "마지막으로 올린 Uint8Array identity + ptr" 캐시를 두고, core 측에 `(ptr,len)` 진입 export를 노출 — 업로드 1회, 호출 n회.
   - 데모 수준에서는 시맨틱 변경(경계 데모의 순수성 훼손)이므로 사이트가 아닌 **런타임 API 옵션**으로. `batch()`가 디스패치를 amortize했듯, 이건 마셜을 amortize.
3. **string 왕복** — 기존 결론 유지(BENCHMARK.md §8–9): 근본 한계는 코어 측 alloc/copy. coarse export 권고만 유효.
4. **사이트 데모 큐레이션** — 정수 커널은 "JIT 추측 최적화가 이기는 영역"으로 명시(이번 카피 라운드 반영). wasm의 구조적 승리(재귀·할당)를 리드 데모로. ~~파싱류(JSON/토크나이저) 데모가 다음 후보~~ **→ §6 T1 실측으로 철회: 파서 형상도 3엔진 모두 JS 승** (JSC JS 2.14×, V8 JS 1.34×, Gecko 동점). 토크나이저의 문자 분류 if-chain은 JIT가 동등 컴파일하고, scriptc 파서는 토큰당 함수 호출(T1)로 느려진다. 파싱 데모는 T1 수정 후 재검.

## 6. Calcium M0 실측에서 추가 확보된 코드젱 세금 T1–T3 (2026-11-16)

Calcium(`examples/calcium/`, 계획 `docs/plans/2026-11-16-calcium-calc-engine.md` §1-b) 개발 중
IR(`.scriptca/core.lib.ll`)·wat(wabt)·프로브 export로 정량화한 scriptc 코드젠 세금.
같은 알고리즘의 JS 트윈과 프레임 머신 양쪽 대칭 비교, 3엔진(JSC·V8·SpiderMonkey FF160 Marionette).

1. **T1 — 호출 박싱 (~30ns/call).** 모든 scriptc 함수 호출이 `sc_f_` 래퍼: 힙 `ptr` 박스 반환 +
   인자별 `scr_union_release` + `scr_exc_pending()` 예외 폴. 재귀 평가기(호출 지배)가 진 이유의
   대부분. 트윈 대비 재귀 파서가 3엔진 전부에서 패배. **완화: 핫 패스에서 호출 자체를 제거**
   (Calcium R8 프레임 머신 — 단일 디스패치 루프). 근본 수정은 툴체인: 즉시 값 반환 경로
   (escape 분석으로 박스 제거) 또는 `--noexc` 무결과 경로.
2. **T2 — 배열 접근 검사 → 정체는 "루프 형태" (2026-11-17 재분해, 계획 §1-c).**
   원래 진단(Float64Array 접근마다 정수성·경계·왕복 검사 ~12 명령 = 디스패치당 ~10ns)은
   **병목 지점을 잘못 짚었다**. `|0` 호이스트로 IR 검사의 80%를 지워도 런타임 무변화(LLVM -O2가
   이미 상쇄). 어블레이션으로 밝혀진 진짜 축: (a) **counted `for` 루프만 scriptc loop-versioning이
   인식** — 동일 산술의 while 루프와 6.02× 차이(2.21 vs 0.37 ns/cell, while 쪽이 느림).
   data-dependent `break`는 버전닝을 깨지 않는다(for+break+로컬 누산기 = JS twin 대비 1.18×).
   (b) **stride 루프 변수(`cur += NCOLS`)는 버전닝되지만 파생 인덱스(`s + rr*NCOLS`)는 안 된다**
   (1.32 vs 1.80 ns/cell). (c) 누산기를 배열 슬롯(gg) 대신 f64 로컬로 호이스트하면
   −1.15~−3.27 ns/cell. **엔진 측 처방(실측 검증)**: 핫 워크를 counted for(+break)로 쓰고
   누산기는 로컬 — Calcium FT_AGR 재작성으로 재계산 격차 JSC 4.14→2.10·V8 2.88→1.57·
   Gecko 2.38→1.50. **툴체인 이관 항목(유효)**: counted 인식을 while/일반 induction으로
   확장 — while+로컬(4.03)과 for+로컬(2.29)의 1.74ns/cell 차이가 그 상한.
   **후속 정정(2026-11-17): "internal 헬퍼의 거대 함수 인라인 붕괴"설은 철회.** 스캔 플로어의
   진짜 정체는 **T4 — scriptc `===`/`!==`의 Scratch 박싱**: f64 피연산자(특히 load 대 load,
   자기검사 `x === x`)를 비교하면 요소마다 박스 생성 call → 태그 br_table → 언박싱 →
   release call이 붙는다(wabt 확인). Calcium 체크섬 루프가 14.1ns/cell이던 것은 `x === x`
   NaN 검사 때문 — **그리고 그 검사는 중복**(NaN은 `<`/`>` 양쪽 거짓이라 크기 펜스만으로
   제외됨). `===` 재작성(`!(a<b) && !(b<a)` 또는 삭제)으로 순수 스캔 17~18 → 1.6ns/cell,
   증분 게이트 JS 10~13× 승 → V8/Gecko wasm 승. `===` 상수 비교(디스패치)는 박싱 없음.
   **상류 처방: 양쪽 정적 타입이 f64로 좁혀지면 `===`를 박싱 없는 숫자 비교로 컴파일.**
   (인라인은 실제로 일어나지만 무해 — 거대 함수에 인라인된 루프도 본체에 박싱이 없으면
   충분히 빠르다. runCell 분리·재귀 가드는 성능 중립 위생책으로만 유지.)
3. **T3 — union 글로벌 (23×).** 모듈 `let`을 배열 로드값으로 쓰면 박스형 union 글로벌로 하강
   (`@sc_g_e_g_sum = internal global ptr`), 쓰기마다 `scr_union_new_f64` + release.
   프로브: 6 RMW 루프가 글로벌 50.4ns/iter vs Float64Array 슬롯 2.2ns/iter. **완화: 핫 누산기는
   배열 슬롯(gg 레지스터) 또는 함수 로컬로** — Calcium 머신이 둘 다 적용. 근본 수정: 배열 로드에서
   온 값의 정적 타입이 f64로 좁혀지면 글로벌을 `double` 타입으로 내보내기.

**측정 공정성 원칙 (재사용 권고):** JS 트윈은 동일 알고리즘 + 관용적 타입(tag=Uint8, idx=Int32),
수정 검증은 golden 체크섬 bit-exact(재작성 전 구현의 출력을 스냅샷), 마이크로벤치는 LICM 함정
회피(상수 주소·제로 배열은 아무것도 측정 안 함 — 교대 인덱스+시드 내용).

**손 프로필 함정 (2026-11-17):** 코어 `wasm-loader`는 런타임 프로필의 `abi.init_symbol`이
있을 때만 모듈 init을 호출한다. 손으로 짠 프로필에 이 심볼이 빠지면 모듈 const가 0, 모듈 초기화
배열이 빈 채로 돌아가며 — "module-const 바운드 루프가 NaN을 낸다", "모듈레벨 대형 배열이
NaN이다" 같은 **가짜 scriptc 버그**를 만든다(둘 다 이 함정이었고, init 호출 시 전부 정상 —
후보 이슈 철회). 엔진 export의 결과가 이상하면 init 호출부터 확인할 것.

## 부록 — 핵심 검증 스크립트

- 고립 f64 루프(손조립, sumRange 내부 루프와 동일 형상): FF(playwright 빌드) 5.5ns/iter vs FF(공식 160) 0.52 vs Chromium 0.56 — 모듈 무죄·엔진/빌드 문제 입증.
- tier-up 타임라인: `sumRange(1M)` 30회 — Chromium 2400(컴파일)→500µs로 하락, FF(공식) 1회차부터 최속, FF(playwright) 30회 내내 5000-6000µs.
- 상세 재현 스크립트 필요 시 이 문서 작성 세션의 `/tmp/wasm-bench/` 참조(휘발) — 재작성 시 본문 §4의 Marionette 프로토콜 노트로 충분.

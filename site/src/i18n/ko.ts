import type { HostCategory } from './types';

/**
 * Korean dictionary — the source of truth for the `Dict` shape.
 * Every key here must exist in `en.ts` with the same structure.
 */
const ko = {
  meta: {
    title: 'scriptca — 하나의 TypeScript 코어, 모든 런타임',
  },
  nav: {
    usage: '가이드',
    demo: '데모',
    hosts: '호스트',
    bench: '성능',
    docs: '문서',
    github: 'GitHub',
    langAria: '언어 전환 (현재: 한국어)',
    themeLightAria: '다크 모드 켜기',
    themeDarkAria: '라이트 모드 켜기',
  },
  hero: {
    eyebrow: 'Bun · Node · Deno · Tauri · React Native · Lynx · Workers · Vite · Next',
    title1: '하나의 TypeScript 코어.',
    title2: '모든 런타임.',
    sub: 'TypeScript를 scriptc로 네이티브 라이브러리와 WASM으로 컴파일하고, 모든 호스트에 타입 안전 클라이언트를 생성합니다.',
    ctaPrimary: '시작하기',
    ctaSecondary: '라이브 데모 보기',
    quickstartLabel: '빠른 시작',
    quickstart: `bunx @unikit-bridge/scriptca init demo --host bun
cd demo
bun install
bun run doctor && bun run build && bun start
# → {"sum":42,"hi":"hello, bun"}`,
    quickstartNote: 'docs/getting-started.md 기준 검증 완료.',
    router: {
      header: 'src/core.ts → 타깃 라우팅',
      badge: '1 core · N hosts',
      sourceLabel: '단일 입력 코어',
      sourceFile: 'src/core.ts',
      sourceCode: 'export function add(a: number, b: number): number',
      compilerLabel: 'scriptc + scriptca build',
      compilerDetail: '한 코어 → 호스트별 클라이언트',
      targetLabel: '타깃 호스트 선택',
      artifactLabel: '생성 산출물',
      wiringLabel: '연결 방식',
      callSiteLabel: '앱 호출부 (변경 없음)',
      callSiteCode: `import { add } from './src/core';
add(20, 22); // 42`,
      targets: [
        {
          id: 'bun-node',
          label: 'Bun / Node',
          kind: 'NATIVE',
          artifact: 'libcore.so · core.node',
          wiring: 'bun:ffi 또는 타입 N-API 애드온으로 직접 호출',
        },
        {
          id: 'browser',
          label: 'Vite / Next',
          kind: 'WASM DROP-IN',
          artifact: 'core.wasm · browser.ts',
          wiring: '플러그인 resolveId가 ./core import를 가로채 연결',
        },
        {
          id: 'workers',
          label: 'Workers',
          kind: 'WORKERD',
          artifact: 'workers.ts · CompiledWasm',
          wiring: 'workerd export 조건으로 정적 WASM import 해석',
        },
        {
          id: 'mobile',
          label: 'RN / Expo',
          kind: 'BRIDGE',
          artifact: 'react-native.ts · libcore.a',
          wiring: 'metro.config.js의 withScriptcaMetro()가 브리지 연결',
        },
      ],
    },
  },
  usage: {
    eyebrow: '사용 가이드',
    title: '언제, 어떻게 쓰나요',
    sub: '무거운 연산은 코어로, 가벼운 호출은 TS에.',
    steps: [
      {
        title: '코어 작성',
        body: '무거운 연산을 src/core.ts에 평범한 TypeScript 함수로 작성합니다.',
        code: 'export function sumRange(count: number): number',
        lang: 'ts',
      },
      {
        title: '빌드 한 번',
        body: '네이티브 라이브러리·WASM·호스트별 클라이언트가 한 번에 생성됩니다.',
        code: 'scriptca build --target both',
        lang: 'bash',
      },
      {
        title: '호출부 그대로',
        body: "번들러 플러그인이 './core' import를 컴파일된 클라이언트로 이어줍니다.",
        code: "import { sumRange } from './src/core'",
        lang: 'ts',
      },
    ],
    stepsNote: '번들러 없는 호스트(Bun·Node·Deno·Workers)는 createClient() 하나면 충분합니다.',
    goodTitle: '코어에 넣기 좋은 작업',
    goodItems: [
      '재귀·탐색 등 호출이 많은 계산 — 트리 순회, 백트래킹',
      '패스마다 버퍼를 새로 만드는 파이프라인·시뮬레이션',
      '네이티브 실행의 이미지·큰 버퍼 처리 (Uint8Array를 한 번에 넘기기)',
      '메모리 격리가 필요한 로직',
    ],
    badTitle: 'TS에 남겨두세요',
    badItems: [
      '짧은 문자열을 잦게 왕복하는 호출 — 경계 비용이 약 2배',
      '한 번뿐인 가벼운 연산 — 오버헤드가 이득보다 큼',
    ],
    badHint: '꼭 넘겨야 한다면 batch()로 묶거나 굵은 함수 하나로 합치세요.',
    benchLink: '수치 근거는 성능 섹션에서',
  },
  demo: {
    eyebrow: '라이브 데모',
    title: '이 페이지 자체가 데모입니다',
    sub: '이 사이트의 src/core.ts를 WASM으로 컴파일해 브라우저에서 실행합니다.',
    badge: '브라우저 WASM',
    sourceTitle: 'src/core.ts',
    importNote: "import { pipelineStats, fibTree } from '../core'",
    run: '실행',
    running: '측정 중…',
    result: '결과',
    wasmTime: 'WASM',
    jsTime: '순수 JS',
    avgOf: '평균',
    callsUnit: '회',
    tabs: {
      calcium: {
        label: 'calcium',
        desc: '스프레드시트 엔진. 셀을 편집하고 10만 셀 재계산을 JS 트윈과 비교합니다.',
        abi: 'wbRecalc · dirty grid',
        code: `const eng = await createClient()
const js = createTwin()

eng.wbSetFormula(idx, enc('=SUM(A1:A5)'))
eng.wbRecalcDirty()
eng.benchBuild(100_000)
eng.benchRecalc(1)`,
        sheetTitle: '시트 · 8×15',
        fxLabel: '수식',
        gridLabel: 'calcium 시트',
        fxHint: 'Enter · Esc · 방향키 · #ERR!',
        functionsHint: 'SUM · AVERAGE · IF · LET · LAMBDA · …',
        loadingEngine: '엔진 로딩…',
        engineErrorTitle: '엔진을 불러오지 못했습니다',
        engineErrorBody: 'WASM 초기화에 실패했습니다. 다시 시도해 주세요.',
        raceTitle: '10만 셀 재계산',
        raceRun: '측정',
        stageBuilding: '북 빌드 중…',
        stageFull: '전체 재계산…',
        stageIncr: '증분 재계산…',
        fullLabel: '전체 · benchRecalc(1)',
        incrLabel: '증분 · benchRecalcDirty(1)',
        cells: '100,000셀',
        medianOf: '7회 중앙값',
        parityOk: '체크섬 일치',
        parityBad: '체크섬 불일치',
        faster: '더 빠름',
        raceNote: '브라우저마다 수치가 다릅니다.',
      },
      pipeline: {
        label: 'pipeline',
        desc: '패스마다 Float64Array를 새로 할당하는 3-패스 파이프라인.',
        abi: '(bytes) → f64 · 3 buffers',
        code: `const xs = new Float64Array(n)  // normalize
const dx = new Float64Array(n)  // diff
const sm = new Float64Array(n)  // smooth`,
        size: '크기 (64–2048 KB)',
      },
      fib: {
        label: 'fib',
        desc: '반복은 JIT과 대등하고, 재귀는 호출 프레임 비용에서 wasm이 앞섭니다.',
        abi: '(f64) → f64 · fib vs fibTree',
        code: `export function fib(n: number): number
export function fibTree(n: number): number`,
        modeLabel: '구현',
        modeLabels: { iter: '반복', tree: '재귀' },
        n: 'n (10–78)',
        nTree: 'n (24–34)',
      },
    },
    errorTitle: '데모 코어를 불러오지 못했습니다',
    errorBody: 'WASM 모듈 초기화에 실패했습니다. 콘솔을 확인하거나 다시 시도하세요.',
    retry: '다시 시도',
    loading: '데모 로딩 중',
  },
  hosts: {
    eyebrow: '호스트',
    title: '앱이 도는 곳 어디서나',
    sub: '번들러 플러그인 또는 export 조건으로 호스트별 클라이언트를 연결합니다.',
    filters: [
      { id: 'all' as HostCategory, label: '전체 (11)' },
      { id: 'dropin' as HostCategory, label: '번들러 드롭인 (6)' },
      { id: 'conditions' as HostCategory, label: '조건 경로 (4)' },
      { id: 'native' as HostCategory, label: '네이티브 런타임 (1)' },
    ],
    columns: { host: '호스트', how: '연결 방식', verified: '검증 버전' },
    rows: [
      { host: 'Vite', category: 'dropin' as const, how: '자동 드롭인, resolveId가 내장 리졸버보다 먼저 실행', verified: 'Vite 6 dev + build' },
      { host: 'Next.js (webpack)', category: 'dropin' as const, how: '클라이언트 그래프는 브라우저 드롭인, 서버는 node 클라이언트', verified: 'Next 16.4.2' },
      { host: 'Next.js (Turbopack)', category: 'conditions' as const, how: 'resolve 훅이 없어 export 조건 경로 사용', verified: 'Next 16.4.2' },
      { host: 'React Native / Expo', category: 'dropin' as const, how: 'metro.config.js에 withScriptcaMetro()', verified: 'Metro 0.87 · RN 0.88 · Expo 58' },
      { host: 'Electron', category: 'dropin' as const, how: '메인은 네이티브, 렌더러는 WASM 드롭인', verified: 'Electron 33 실물 런타임' },
      { host: 'Astro · SvelteKit · Nuxt · SolidStart', category: 'dropin' as const, how: 'Vite 플러그인 등록 (@unikit-bridge/scriptca/vite)', verified: 'Astro 5.18 · Nuxt 4.6 등' },
      { host: 'Bun · Node', category: 'native' as const, how: '네이티브 공유 라이브러리, bun:ffi / 타입 N-API 애드온', verified: '실물 런타임 호출' },
      { host: 'Deno', category: 'conditions' as const, how: 'deno 플레이버(컴파일된 .js)가 node보다 먼저 해석', verified: 'Deno 2.9' },
      { host: 'Cloudflare Workers', category: 'conditions' as const, how: 'workerd 조건 — 정적 WASM import', verified: 'wrangler 4.151' },
      { host: 'Lynx (Rspeedy)', category: 'conditions' as const, how: 'Rspack 리졸버에 JS 훅이 없어 조건 경로 사용', verified: 'Rspeedy 0.18.2' },
      { host: 'Rollup', category: 'dropin' as const, how: '동일 플러그인, 표준 resolveId 훅', verified: 'rollup 4' },
    ],
  },
  bench: {
    eyebrow: '성능',
    title: '측정된 수치',
    sub: 'examples/bench-core 실측 (M1 Max / linux-x64).',
    tiles: [
      { value: '~24.5 ns', label: 'Node 애드온 · 호출당', tag: 'native' },
      { value: '~47 ns', label: 'Bun · 호출당', tag: 'native' },
      { value: '48 ns', label: '브라우저 WASM · 호출당', tag: 'wasm' },
      { value: '1.1 s → 166 ms', label: '콜드 → 웜 빌드 (6.4×)', tag: 'cache' },
    ],
    boundaryTitle: '호출 비용',
    boundaryColumns: { op: '연산', cost: '비용 (linux-x64)', note: '메모' },
    boundaryRows: [
      { op: 'number 호출', cost: '5–20 ns', note: '직접 바인딩 / 타입 애드온' },
      { op: 'string 왕복', cost: '~0.66–1.0 µs', note: '복사 + UTF-8' },
      { op: 'string 배치', cost: '−31%', note: 'batch()로 N개를 한 번에' },
      { op: '작은 string 다발', cost: '≈ 2× 지연', note: '묶거나 TS에 두기' },
    ],
    calloutTitle: '한 줄 요약',
    calloutBody:
      'V8·SpiderMonkey 모두 단순 루프를 네이티브급으로 컴파일하고, 정수 연산은 추측 최적화로 변환 비용조차 없앱니다 — wasm이 확실히 앞서는 건 호출 많은 재귀와 할당 잦은 파이프라인입니다.',
  },
  footer: {
    tagline: '하나의 TypeScript 코어, 모든 런타임.',
    links: { github: 'GitHub', npm: 'npm', docs: '문서', benchmarks: '벤치마크' },
    license: 'MIT License',
  },
  common: {
    copy: '복사',
    copied: '복사됨',
  },
};

export default ko;

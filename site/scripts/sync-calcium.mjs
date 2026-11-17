/**
 * Sync the Calcium calc engine (examples/calcium) into the site.
 *
 * The engine's build writes gitignored artifacts under
 * examples/calcium/.scriptca/. This script keeps three site-side copies in
 * lockstep with them so engine rebuilds propagate into dev, typecheck and
 * production builds:
 *
 *   .scriptca/calcium.wasm              → site/public/calcium.wasm
 *   .scriptca/generated/browser.ts      → site/src/calcium/generated/browser.ts
 *   .scriptca/generated/types.ts        → site/src/calcium/generated/types.ts
 *   twin.ts                             → site/src/demo/calciumTwin.ts (+ header)
 *
 * When an engine source is newer than the built wasm (or the artifacts are
 * missing) the engine build runs first — it only writes inside
 * examples/calcium/.scriptca/, never a tracked file. Byte-identical copies
 * are skipped so vite's watcher stays quiet. Run via `bun run sync:calcium`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(dirname(fileURLToPath(import.meta.url)));
const engine = join(dirname(site), 'examples', 'calcium');
const artifacts = join(engine, '.scriptca');

const targets = {
  wasm: [join(artifacts, 'calcium.wasm'), join(site, 'public', 'calcium.wasm')],
  browser: [join(artifacts, 'generated', 'browser.ts'), join(site, 'src', 'calcium', 'generated', 'browser.ts')],
  types: [join(artifacts, 'generated', 'types.ts'), join(site, 'src', 'calcium', 'generated', 'types.ts')],
  twin: [join(engine, 'twin.ts'), join(site, 'src', 'demo', 'calciumTwin.ts')],
};

const TWIN_HEADER = `/**
 * Verbatim copy of examples/calcium/twin.ts — the JS twin the Calcium wasm
 * engine races against. Do not edit by hand: scripts/sync-calcium.mjs
 * rewrites this file whenever the source twin changes, so the two stay
 * bit-exact (identical checksums are the demo's parity guarantee).
 */

// @ts-nocheck — vendored oracle, not site code: it targets the engine
// package's own toolchain (bun, no tsc), and its pre-TS5.7 Uint8Array
// typing does not match this tsconfig. Logic must remain byte-identical.

`;

/**
 * The generated browser client references `BatchEntry` in its batch() entry
 * without importing it (the generator only imports it into types.ts, which
 * does not re-export it — invisible under bun, an error under tsc). Patch
 * the copy with the missing type import; everything else stays verbatim.
 */
function patchBrowserClient(source) {
  if (!source.includes('BatchEntry') || source.includes("import type { BatchEntry }")) return source;
  return source.replace(
    "import type { ScriptcaClient } from './types.js';",
    "import type { ScriptcaClient } from './types.js';\nimport type { BatchEntry } from '@unikit-bridge/scriptca/types';",
  );
}

async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Any .ts source (or config) under the engine newer than `ref`? */
async function anySourceNewer(paths, ref) {
  for (const path of paths) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name.endsWith('.ts') && (await mtime(join(path, entry.name))) > ref) return true;
      }
    } else if (info.mtimeMs > ref) {
      return true;
    }
  }
  return false;
}

async function sameBytes(a, b) {
  if (!existsSync(b)) return false;
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return x.equals(y);
}

async function copyIfChanged([from, to], transform) {
  const source = await readFile(from);
  const content = transform ? Buffer.from(transform(source.toString('utf8')), 'utf8') : source;
  if (existsSync(to)) {
    const current = await readFile(to);
    if (current.equals(content)) return false;
  }
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, content);
  console.log(`calcium: ${from.replace(`${site}/../`, '')} → ${to.replace(`${site}/`, 'site/')}`);
  return true;
}

async function main() {
  if (!existsSync(engine)) throw new Error(`sync-calcium: engine package not found at ${engine}`);

  const wasmMtime = await mtime(targets.wasm[0]);
  const needsBuild =
    wasmMtime === 0 ||
    !existsSync(targets.browser[0]) ||
    (await anySourceNewer([join(engine, 'src'), join(engine, 'twin.ts'), join(engine, 'scriptca.json')], wasmMtime));

  if (needsBuild) {
    console.log('calcium: engine sources newer than artifacts — rebuilding examples/calcium…');
    for (const cmd of [
      ['bun', ['run', 'build']],
      ['npm', ['run', 'build']],
    ]) {
      const run = spawnSync(cmd[0], cmd[1], { cwd: engine, stdio: 'inherit' });
      if (run.error?.code !== 'ENOENT') {
        if (run.status !== 0) throw new Error(`sync-calcium: engine build failed (${cmd[0]} run build)`);
        break;
      }
    }
    if (!existsSync(targets.wasm[0]) || !existsSync(targets.browser[0])) {
      throw new Error('sync-calcium: engine build produced no wasm/browser client — check examples/calcium');
    }
  }

  const changed = [];
  changed.push(await copyIfChanged(targets.wasm));
  changed.push(await copyIfChanged(targets.browser, patchBrowserClient));
  changed.push(await copyIfChanged(targets.types));
  changed.push(await copyIfChanged(targets.twin, (src) => TWIN_HEADER + src));

  if (changed.every((c) => !c)) console.log('calcium: site copies up to date');
}

await main();

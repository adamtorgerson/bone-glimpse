// Fails if the production build contains essentia.js (AGPL-3.0), which may
// only run from the dev server. Run by `npm run pack` before packing.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const MARKERS = ['This file is part of Essentia', 'essentia.js-core', 'EssentiaWASM'];
const hits = (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
  .filter((f) => /\.(js|mjs|wasm|html)$/.test(f))
  .filter((f) => {
    const text = readFileSync(join(dir, f), 'latin1');
    return /essentia/i.test(f) || MARKERS.some((m) => text.includes(m));
  });
if (hits.length) {
  console.error(`check-bundle: essentia.js (AGPL-3.0) found in ${dir}: ${hits.join(', ')}`);
  process.exit(1);
}
console.log(`check-bundle: ${dir} has no essentia.js`);

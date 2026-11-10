// Downloads the model files into public/models and verifies every SHA-256:
//  - chordmini/:   ChordMini ONNX export (MIT, musetric/chordmini-onnx)
//  - basic-pitch/: Spotify Basic Pitch tfjs graph model (Apache-2.0, @spotify/basic-pitch on npm)
// The chroma and Essentia schemes need no downloads (Essentia's WASM is an npm dependency).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sources = [
  {
    dir: 'chordmini',
    // Pinned revision (same pin as the musetric reference runtime).
    base: 'https://huggingface.co/musetric/chordmini-onnx/resolve/8ab85fc0f61439900cd07ac21257a43eac57075c/',
    files: [
      { name: 'chordnet.onnx', sha256: '1faee8e1cf168300afe0f47517e76836ac200c3841b0fb430fad7dfea5ad6394' },
      { name: 'config.json', sha256: '1f26c11ebea51ec08f12e813eb213a729fa0ecc407ac7632dfdc7bad67e65aa4' },
      { name: 'cqt-plan.bin', sha256: 'c31f0a6fd2d582d753be6628b5daecdee58acba53cba93b2bc2b5c75dee2ba48' },
    ],
  },
  {
    dir: 'basic-pitch',
    base: 'https://unpkg.com/@spotify/basic-pitch@1.0.1/model/',
    files: [
      { name: 'model.json', sha256: '1ed1aaee3409ec1dc098c8b01f430c0911f6fe9412e7af8086750f9e8f302f68' },
      { name: 'group1-shard1of1.bin', sha256: 'b142a95737a52e1e412d5f92e73d8bb80dfe8d04941acc0702f11f4524fb377c' },
    ],
  },
];

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

for (const source of sources) {
  const modelDir = join(root, 'public/models', source.dir);
  mkdirSync(modelDir, { recursive: true });
  for (const file of source.files) {
    const target = join(modelDir, file.name);
    const label = `${source.dir}/${file.name}`;
    if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) {
      console.log(`ok       ${label}`);
      continue;
    }
    const url = source.base + file.name;
    process.stdout.write(`download ${label} ... `);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    const actual = sha256(data);
    if (actual !== file.sha256) throw new Error(`${label}: SHA-256 mismatch (${actual})`);
    writeFileSync(target, data);
    console.log(`${(data.length / 1e6).toFixed(1)} MB, verified`);
  }
}

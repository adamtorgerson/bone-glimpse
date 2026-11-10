// Downloads the ChordMini ONNX export (MIT, musetric/chordmini-onnx) into
// public/models/chordmini and verifies every file's SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'musetric/chordmini-onnx';
// Pinned revision (same pin as the musetric reference runtime).
const revision = '8ab85fc0f61439900cd07ac21257a43eac57075c';

const files = [
  { name: 'chordnet.onnx', sha256: '1faee8e1cf168300afe0f47517e76836ac200c3841b0fb430fad7dfea5ad6394' },
  { name: 'config.json', sha256: '1f26c11ebea51ec08f12e813eb213a729fa0ecc407ac7632dfdc7bad67e65aa4' },
  { name: 'cqt-plan.bin', sha256: 'c31f0a6fd2d582d753be6628b5daecdee58acba53cba93b2bc2b5c75dee2ba48' },
];

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const modelDir = join(root, 'public/models/chordmini');
mkdirSync(modelDir, { recursive: true });

for (const file of files) {
  const target = join(modelDir, file.name);
  if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) {
    console.log(`ok       ${file.name}`);
    continue;
  }
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${file.name}`;
  process.stdout.write(`download ${file.name} ... `);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(data);
  if (actual !== file.sha256) throw new Error(`${file.name}: SHA-256 mismatch (${actual})`);
  writeFileSync(target, data);
  console.log(`${(data.length / 1e6).toFixed(1)} MB, verified`);
}

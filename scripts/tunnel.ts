// Serves the dev server over HTTPS for the phone through a Cloudflare quick
// tunnel (random https://…trycloudflare.com URL, valid certificate, no
// account), then shows it as a QR code for the Even app.
//
// HTTPS matters: browsers only expose WebGPU, SharedArrayBuffer (multi-threaded
// WASM), AudioWorklet and getUserMedia to secure contexts, and a plain
// http://<LAN-IP> page is not one. Anyone with the URL can reach the dev server
// while this runs; it changes on every start.
//
//   npm run dev:https            (starts Vite too, unless it's already running)
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';

const port = process.argv[2] ?? '5180';
const listening = await new Promise<boolean>((resolve) => {
  const socket = connect(Number(port), 'localhost', () => {
    socket.end();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
});
if (listening) console.log(`Using the dev server already running on port ${port}.`);
const tunnel = spawn('npx', ['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const children: ChildProcess[] = [tunnel];
if (!listening) children.push(spawn('npx', ['vite'], { stdio: ['ignore', 'inherit', 'inherit'] }));
const stop = (): void => {
  for (const c of children) c.kill('SIGTERM');
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => {
  console.error(`${c === tunnel ? 'cloudflared' : 'vite'} exited (${code})`);
  stop();
});

let shown = false;
const onOutput = (data: Buffer): void => {
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(data.toString())?.[0];
  if (!url || shown) return;
  shown = true;
  // The hostname needs a moment to resolve publicly; the QR is fine to scan right away.
  console.log(`\nHTTPS URL for the phone: ${url}/\n`);
  spawnSync('npx', ['evenhub', 'qr', '--url', `${url}/`], { stdio: 'inherit' });
};
tunnel.stdout!.on('data', onOutput);
tunnel.stderr!.on('data', onOutput);

// Shows a QR code for the dev server's LAN address; scan it from the Even app
// (Even Hub tab → developer section → Scan QR) to run BoneGlimpse on the glasses.
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const port = process.argv[2] ?? '5180';
const ip = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
if (!ip) {
  console.error('No LAN IPv4 address found; is this machine on Wi-Fi/Ethernet?');
  process.exit(1);
}
const url = `http://${ip}:${port}/`;
console.log(`Dev server URL for the phone: ${url}  (keep "npm run dev" running)`);
const result = spawnSync('npx', ['evenhub', 'qr', '--url', url], { stdio: 'inherit' });
process.exit(result.status ?? 1);

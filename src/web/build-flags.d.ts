/**
 * True on the Vite dev server (laptop, simulator, QR code on the glasses),
 * false in `vite build` / `npm run pack`: the AGPL Essentia scheme must
 * never end up in a distributed build. Set in vite.config.ts.
 */
declare const __WITH_ESSENTIA__: boolean;

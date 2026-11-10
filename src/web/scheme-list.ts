// Schemes offered by the app. Essentia (essentia.js is AGPL-3.0) is only on
// the dev server, so it runs from the QR code but is never packed into the .ehpk.
import { SCHEME_IDS, type SchemeId } from '../engine/scheme';

export const WEB_SCHEME_IDS: readonly SchemeId[] = SCHEME_IDS.filter((id) => id !== 'essentia' || __WITH_ESSENTIA__);

export const isWebSchemeId = (value: unknown): value is SchemeId => WEB_SCHEME_IDS.includes(value as SchemeId);

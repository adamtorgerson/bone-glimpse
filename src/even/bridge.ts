// Detects whether the page is running inside the Even Realities App WebView
// (or the evenhub-simulator).
//
// waitForEvenAppBridge() alone is not enough: the SDK creates and resolves a
// bridge object in any browser, and only fails later ("Flutter handler not
// available") when a call is made. So once the bridge exists we also probe the
// host with a harmless call; only a real host answers it.
import { type EvenAppBridge, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

export const detectEvenBridge = async (timeoutMs = 2500): Promise<EvenAppBridge | undefined> => {
  try {
    const bridge = await withTimeout(waitForEvenAppBridge(), timeoutMs);
    if (!bridge) return undefined;
    const info = await withTimeout(bridge.getDeviceInfo().catch(() => undefined), timeoutMs);
    return info ? bridge : undefined;
  } catch {
    return undefined;
  }
};

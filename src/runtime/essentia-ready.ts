// essentia.js instantiates its embedded WASM asynchronously; wait for it.
export const essentiaReady = async (module: { calledRun?: boolean }, timeoutMs = 20000): Promise<void> => {
  const started = Date.now();
  while (!module.calledRun) {
    if (Date.now() - started > timeoutMs) throw new Error('essentia.js WASM did not initialise');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// Points the tfjs WASM backend at the .wasm files Vite bundles, then selects it.
// Multi-threading is off: tfjs's threaded build spawns pthread workers from an
// inlined script that breaks once bundled ("e is not defined"), and Basic
// Pitch is small enough that single-threaded SIMD keeps up.
import { env } from '@tensorflow/tfjs-core';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import plain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import simd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import threadedSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import { useTfWasm } from '../runtime/basic-pitch-tfjs';

/** Returns the number of threads tfjs uses. */
export const setupTfWasm = async (): Promise<number> => {
  const resolve = (url: string): string => new URL(url, self.location.href).href;
  env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  // tfjs wants every binary listed even though the threaded one isn't loaded.
  setWasmPaths({
    'tfjs-backend-wasm.wasm': resolve(plain),
    'tfjs-backend-wasm-simd.wasm': resolve(simd),
    'tfjs-backend-wasm-threaded-simd.wasm': resolve(threadedSimd),
  });
  await useTfWasm();
  return 1;
};

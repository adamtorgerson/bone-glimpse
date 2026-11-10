// essentia.js ships no typings for its ES builds; the engine uses its own
// minimal EssentiaApi type, so these stay loose.
declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: { calledRun?: boolean; VectorVectorFloat: import('../engine/schemes/essentia').VectorVectorCtor };
}
declare module 'essentia.js/dist/essentia.js-core.es.js' {
  const Essentia: new (wasm: unknown) => import('../engine/schemes/essentia').EssentiaApi;
  export default Essentia;
}

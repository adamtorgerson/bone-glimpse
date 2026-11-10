// Tiny WAV reader/writer (PCM 8/16/24/32-bit int and 32/64-bit float).

export type DecodedAudio = { sampleRate: number; channels: Float32Array[] };

export const decodeWav = (bytes: Uint8Array): DecodedAudio => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe) format = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      const bytesPerSample = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (bytesPerSample * channelCount));
      const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channelCount; c++) {
          const p = body + (f * channelCount + c) * bytesPerSample;
          let v: number;
          if (format === 3) v = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
          else if (bits === 8) v = (view.getUint8(p) - 128) / 128;
          else if (bits === 16) v = view.getInt16(p, true) / 32768;
          else if (bits === 24) v = ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608);
          else v = view.getInt32(p, true) / 2147483648;
          channels[c][f] = v;
        }
      }
      return { sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
};

/** Arithmetic-mean downmix (matches librosa.load / the model's training pipeline). */
export const toMono = (audio: DecodedAudio): Float32Array => {
  const [first, ...rest] = audio.channels;
  if (!rest.length) return first;
  const out = new Float32Array(first.length);
  for (const ch of audio.channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / audio.channels.length;
  return out;
};

export const encodeWav16 = (samples: Float32Array, sampleRate: number): Uint8Array => {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  }
  return bytes;
};

/** Simulates the Even G2 transport: 16-bit quantisation of 16 kHz audio. */
export const quantize16 = (samples: Float32Array): Float32Array =>
  samples.map((v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))) / 32768);

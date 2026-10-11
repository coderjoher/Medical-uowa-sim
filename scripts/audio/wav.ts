/** 16-bit mono PCM WAV encode/decode (Node Buffer, no dependencies). */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Int16Array;
}

function infoChunk(fields: Record<string, string>): Buffer {
  const parts: Buffer[] = [Buffer.from("INFO", "ascii")];
  for (const [id, text] of Object.entries(fields)) {
    let data = Buffer.from(text + "\0", "latin1");
    if (data.length % 2) data = Buffer.concat([data, Buffer.alloc(1)]);
    const hdr = Buffer.alloc(8);
    hdr.write(id, 0, 4, "ascii");
    hdr.writeUInt32LE(data.length, 4);
    parts.push(hdr, data);
  }
  const body = Buffer.concat(parts);
  const hdr = Buffer.alloc(8);
  hdr.write("LIST", 0, 4, "ascii");
  hdr.writeUInt32LE(body.length, 4);
  return Buffer.concat([hdr, body]);
}

/** Encode float samples in [-1, 1] as a 16-bit mono WAV with optional RIFF INFO metadata (INAM, ICMT, ...). */
export function encodeWav(samples: Float64Array, sampleRate: number, info: Record<string, string> = {}): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16); // byte rate
  fmt.writeUInt16LE(2, 20); // block align
  fmt.writeUInt16LE(16, 22); // bits per sample
  const list = Object.keys(info).length ? infoChunk(info) : Buffer.alloc(0);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0, 4, "ascii");
  dataHdr.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(4 + fmt.length + list.length + dataHdr.length + pcm.length, 4);
  riff.write("WAVE", 8, 4, "ascii");
  return Buffer.concat([riff, fmt, list, dataHdr, pcm]);
}

/** Decode a PCM WAV by walking its chunks. Throws on anything malformed. */
export function decodeWav(buf: Buffer): WavInfo {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  if (buf.readUInt32LE(4) !== buf.length - 8) throw new Error(`RIFF size ${buf.readUInt32LE(4)} != file size - 8 (${buf.length - 8})`);
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | undefined;
  let samples: Int16Array | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (body + size > buf.length) throw new Error(`chunk ${id} overruns file`);
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2);
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new Error("missing fmt chunk");
  if (!samples) throw new Error("missing data chunk");
  if (fmt.format !== 1) throw new Error(`not PCM (format ${fmt.format})`);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, samples };
}

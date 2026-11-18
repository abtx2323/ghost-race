/*!
 * Ghost Race — mp4.js
 * A tiny MP4 writer for one H.264 video track, so clips can be encoded with
 * WebCodecs much faster than real time. Writes a "fast start" file
 * (ftyp, moov, mdat) that X, phones and every desktop player accept.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  function u32(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  function u16(n) {
    return [(n >>> 8) & 255, n & 255];
  }
  function str(s) {
    return Array.from(s, (c) => c.charCodeAt(0));
  }

  // A box is [size][type][payload]. Payload parts may be number arrays or Uint8Arrays.
  function box(type, ...parts) {
    let size = 8;
    for (const p of parts) size += p.length;
    const out = new Uint8Array(size);
    out.set(u32(size), 0);
    out.set(str(type), 4);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  function fullBox(type, version, flags, ...parts) {
    return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  }

  const MATRIX = [].concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  /**
   * samples: [{ data: Uint8Array, key: boolean }] in decode order, no B-frames.
   * avcC: Uint8Array AVCDecoderConfigurationRecord (WebCodecs decoderConfig.description).
   */
  GR.muxMp4 = function muxMp4({ width, height, fps, samples, avcC }) {
    const timescale = fps * 1000;
    const delta = 1000;
    const n = samples.length;
    const mediaDuration = n * delta;
    const movieDuration = Math.round((n / fps) * 1000);

    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));

    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2));
    const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler'), [0]);
    const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

    const avc1 = box(
      'avc1',
      [0, 0, 0, 0, 0, 0], u16(1), // reserved, data_reference_index
      u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined, reserved, pre_defined[3]
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      new Array(32).fill(0), // compressor name
      u16(0x0018), u16(0xffff),
      box('avcC', avcC),
      box('pasp', u32(1), u32(1))
    );
    const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
    const stts = fullBox('stts', 0, 0, u32(1), u32(n), u32(delta));
    const keys = [];
    samples.forEach((smp, i) => smp.key && keys.push(i + 1));
    const stss = fullBox('stss', 0, 0, u32(keys.length), [].concat(...keys.map(u32)));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
    const sizes = new Uint8Array(n * 4);
    let dataLen = 0;
    samples.forEach((smp, i) => {
      sizes.set(u32(smp.data.length), i * 4);
      dataLen += smp.data.length;
    });
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(n), sizes);

    // stco holds the absolute offset of the media data, which depends on the
    // size of moov itself. Its size doesn't depend on the value, so build once
    // with 0, measure, then build again with the real offset.
    const build = (offset) => {
      const stco = fullBox('stco', 0, 0, u32(1), u32(offset));
      const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
      const minf = box('minf', vmhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      const trak = box('trak', tkhd, mdia);
      return box('moov', mvhd, trak);
    };
    const moovSize = build(0).length;
    const moov = build(ftyp.length + moovSize + 8);

    const out = new Uint8Array(ftyp.length + moov.length + 8 + dataLen);
    let o = 0;
    out.set(ftyp, o);
    o += ftyp.length;
    out.set(moov, o);
    o += moov.length;
    out.set(u32(8 + dataLen), o);
    out.set(str('mdat'), o + 4);
    o += 8;
    for (const smp of samples) {
      out.set(smp.data, o);
      o += smp.data.length;
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);

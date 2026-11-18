/*!
 * Ghost Race — export.js
 * Records the race to a video clip with MediaRecorder, and saves a PNG of the
 * results card. All in the browser; nothing is uploaded.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  // X accepts MP4 (H.264). Chrome 126+, Edge and Safari can record MP4 directly;
  // older browsers fall back to WebM.
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1.4D401F',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  GR.canExportVideo = function canExportVideo() {
    return typeof root.MediaRecorder !== 'undefined' && typeof root.HTMLCanvasElement !== 'undefined' && 'captureStream' in root.HTMLCanvasElement.prototype;
  };

  GR.pickVideoMime = function pickVideoMime() {
    if (!GR.canExportVideo()) return null;
    return MIME_CANDIDATES.find((m) => {
      try {
        return root.MediaRecorder.isTypeSupported(m);
      } catch (e) {
        return false;
      }
    }) || null;
  };

  // ------------------------------------------------- fast path: WebCodecs --

  // Constrained Baseline has no B-frames, so frames come out in display
  // order and the MP4 writer can stay simple. Level 4.0 covers 1920x1080
  // and 1080x1920 at 30 fps.
  const FAST_CODECS = ['avc1.42E028', 'avc1.42E02A', 'avc1.42002A', 'avc1.4D0028', 'avc1.640028'];
  const FPS = 30;

  async function pickEncoderConfig(width, height) {
    if (typeof root.VideoEncoder === 'undefined' || typeof root.VideoFrame === 'undefined' || !GR.muxMp4) return null;
    for (const codec of FAST_CODECS) {
      const config = { codec, width, height, bitrate: 10000000, framerate: FPS, avc: { format: 'avc' } };
      try {
        const r = await root.VideoEncoder.isConfigSupported(config);
        if (r && r.supported) return config;
      } catch (e) {
        /* try the next one */
      }
    }
    return null;
  }

  GR.canExportFast = async function canExportFast(width, height) {
    return !!(await pickEncoderConfig(width || 1920, height || 1080));
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function exportFast(o, config) {
    const { race, timeline, opts, width, height, onFrame, onProgress, signal } = o;
    const canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');

    const samples = [];
    let avcC = null;
    let failure = null;
    const enc = new root.VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
        const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (desc && !avcC) {
          avcC = desc instanceof ArrayBuffer ? new Uint8Array(desc.slice(0)) : new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
        }
      },
      error: (e) => (failure = e),
    });
    enc.configure(config);

    const total = Math.ceil(timeline.total * FPS);
    try {
      for (let i = 0; i < total; i++) {
        if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
        if (failure) throw failure;
        const t = i / FPS;
        GR.render(g, width, height, race, GR.frameAt(timeline, race, t), opts);
        const frame = new root.VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        enc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        while (enc.encodeQueueSize > 8) await sleep(2);
        if (i % 5 === 0) {
          if (onFrame) onFrame(canvas, t);
          if (onProgress) onProgress(i / total, 'render');
          await sleep(0);
        }
      }
      await enc.flush();
    } finally {
      if (enc.state !== 'closed') enc.close();
    }
    if (failure) throw failure;
    if (!avcC || samples.length !== total) throw new Error('The video encoder returned an incomplete clip.');
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].ts <= samples[i - 1].ts) throw new Error('The video encoder reordered frames.');
    }
    if (onProgress) onProgress(1, 'render');
    const bytes = GR.muxMp4({ width, height, fps: FPS, samples, avcC });
    return { blob: new Blob([bytes], { type: 'video/mp4' }), mime: 'video/mp4', ext: 'mp4', fast: true };
  }

  /**
   * Export the whole timeline (lights, race, results) as a video.
   * Uses WebCodecs to render faster than real time when the browser can
   * encode H.264, and falls back to recording in real time otherwise.
   * Resolves to { blob, mime, ext, fast }. Rejects with an AbortError if cancelled.
   */
  GR.exportClip = async function exportClip(o) {
    if (!o.forceRealtime) {
      const config = await pickEncoderConfig(o.width, o.height);
      if (config) {
        try {
          return await exportFast(o, config);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (o.onFallback) o.onFallback(e);
        }
      }
    }
    return exportRealtime(o);
  };

  GR.canExportVideoAtAll = function canExportVideoAtAll() {
    return typeof root.VideoEncoder !== 'undefined' || !!GR.pickVideoMime();
  };

  // ------------------------------------------- fallback: real-time record --

  function exportRealtime(o) {
    const { race, timeline, opts, width, height, onFrame, onProgress, signal } = o;
    const mime = GR.pickVideoMime();
    if (!mime) return Promise.reject(new Error("This browser can't record video. Try the latest Chrome, Edge or Safari."));

    const canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    GR.render(g, width, height, race, GR.frameAt(timeline, race, 0), opts);

    const stream = canvas.captureStream(30);
    let rec;
    try {
      rec = new root.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12000000 });
    } catch (e) {
      rec = new root.MediaRecorder(stream);
    }
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise((res) => (rec.onstop = res));

    return new Promise((resolve, reject) => {
      let start = null;
      const finish = async (err) => {
        if (rec.state !== 'inactive') rec.stop();
        await stopped;
        stream.getTracks().forEach((t) => t.stop());
        if (err) return reject(err);
        const type = (rec.mimeType || mime).split(';')[0];
        resolve({ blob: new Blob(chunks, { type }), mime: type, ext: type === 'video/mp4' ? 'mp4' : 'webm', fast: false });
      };
      const tick = (now) => {
        if (signal && signal.aborted) return finish(new DOMException('Export cancelled', 'AbortError'));
        if (start == null) start = now;
        const t = (now - start) / 1000;
        GR.render(g, width, height, race, GR.frameAt(timeline, race, t), opts);
        if (onFrame) onFrame(canvas, t);
        if (onProgress) onProgress(Math.min(1, t / timeline.total), 'record');
        if (t >= timeline.total + 0.3) return finish();
        root.requestAnimationFrame(tick);
      };
      rec.start(250);
      root.requestAnimationFrame(tick);
    });
  }

  GR.exportPng = function exportPng(o) {
    const { race, timeline, opts, width, height } = o;
    const canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    GR.render(canvas.getContext('2d'), width, height, race, GR.frameAt(timeline, race, timeline.total), opts);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  };

  // Saves a file. Inside a Claude artifact, files go through the host's
  // downloads capability (the viewer confirms); everywhere else, a plain link.
  GR.download = async function download(blob, filename) {
    if (root.claude && typeof root.claude.use === 'function') {
      const dl = await root.claude.use('downloads');
      if (!dl) throw new Error("This view can't save files. Open the full site to export.");
      try {
        await dl.save({ filename, data: blob });
      } catch (e) {
        if (e && e.code === 'declined') throw Object.assign(new Error('Save cancelled.'), { name: 'AbortError' });
        throw new Error((e && e.message) || "This view can't save files.");
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = root.document.createElement('a');
    a.href = url;
    a.download = filename;
    root.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
})(typeof window !== 'undefined' ? window : globalThis);

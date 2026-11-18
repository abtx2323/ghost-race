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

  /**
   * Record the whole timeline (lights, race, results) in real time.
   * Resolves to { blob, mime, ext }. Rejects with an AbortError if cancelled.
   */
  GR.exportClip = function exportClip(o) {
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
        resolve({ blob: new Blob(chunks, { type }), mime: type, ext: type === 'video/mp4' ? 'mp4' : 'webm' });
      };
      const tick = (now) => {
        if (signal && signal.aborted) return finish(new DOMException('Export cancelled', 'AbortError'));
        if (start == null) start = now;
        const t = (now - start) / 1000;
        GR.render(g, width, height, race, GR.frameAt(timeline, race, t), opts);
        if (onFrame) onFrame(canvas, t);
        if (onProgress) onProgress(Math.min(1, t / timeline.total));
        if (t >= timeline.total + 0.3) return finish();
        root.requestAnimationFrame(tick);
      };
      rec.start(250);
      root.requestAnimationFrame(tick);
    });
  };

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

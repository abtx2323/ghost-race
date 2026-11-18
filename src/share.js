/*!
 * Ghost Race — share.js
 * Share links: the race is compressed into the part of the URL after "#",
 * which browsers never send to a server. A link carries ghost names, timings,
 * tool types and token counts only: no commands, file names or prompts.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  GR.siteUrl = 'https://abtx2323.github.io/ghost-race/';
  GR.SHARE_PREFIX = '#race=';

  const CATS = ['read', 'search', 'edit', 'shell', 'test', 'web', 'agent', 'plan', 'mcp', 'ask', 'other'];
  const MAX_LINK_CHARS = 400000;
  const MAX_JSON_BYTES = 5 * 1024 * 1024;

  // ------------------------------------------------------------ encoding --

  // Compact form: events are flattened to [dt, kind, cat, tokens, ...] where
  // dt is tenths of a second since the previous event.
  GR.makeSharePayload = function makeSharePayload(runs, opts) {
    opts = opts || {};
    return {
      v: 1,
      f: opts.fromCli ? 'cli' : undefined,
      ti: opts.title ? String(opts.title).slice(0, 80) : '',
      m: opts.mode || 'time',
      i: opts.skipIdle === false ? 0 : 1,
      r: runs.map((run) => {
        const e = [];
        let lastT = 0;
        let lastTok = 0;
        for (const ev of run.events) {
          const t = Math.round(ev.t * 10);
          const tok = Math.round(ev.tokens || 0);
          e.push(Math.max(0, t - lastT), ev.kind === 'tool' ? 0 : ev.kind === 'talk' ? 1 : 2, ev.kind === 'talk' ? -1 : Math.max(0, CATS.indexOf(ev.cat)), Math.max(0, tok - lastTok));
          lastT = Math.max(lastT, t);
          lastTok = Math.max(lastTok, tok);
        }
        return {
          n: String(run.name || 'Ghost').slice(0, 40),
          l: run.modelLabel ? String(run.modelLabel).slice(0, 40) : '',
          s: run.sourceLabel ? String(run.sourceLabel).slice(0, 24) : '',
          o: run.outcome === 'dnf' ? 1 : 0,
          c: run.color || '',
          e,
        };
      }),
    };
  };

  function toB64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return root.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64Url(s) {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad characters');
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = root.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new root.CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes, limit) {
    const reader = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new Error('too large');
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  GR.canShare = function canShare() {
    return typeof root.CompressionStream !== 'undefined' && typeof root.DecompressionStream !== 'undefined';
  };

  GR.encodeShare = async function encodeShare(payload) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    return toB64Url(await deflate(json));
  };

  GR.decodeShare = async function decodeShare(text) {
    const s = String(text || '').replace(/^#?race=/, '');
    if (!s || s.length > MAX_LINK_CHARS) throw new Error('This share link is empty or too long.');
    let payload;
    try {
      const json = await inflate(fromB64Url(s), MAX_JSON_BYTES);
      payload = JSON.parse(new TextDecoder().decode(json));
    } catch (e) {
      throw new Error('This share link is broken or incomplete. Ask for the full link.');
    }
    if (!payload || payload.v !== 1 || !Array.isArray(payload.r) || !payload.r.length) {
      throw new Error("This share link isn't a Ghost Race link this version can read.");
    }
    return payload;
  };

  GR.shareUrl = function shareUrl(encoded) {
    const loc = root.location;
    let base = GR.siteUrl;
    if (loc && /^https?:$/.test(loc.protocol) && (/\.github\.io$/.test(loc.hostname) || /^(localhost|127\.0\.0\.1)$/.test(loc.hostname))) {
      base = loc.origin + loc.pathname;
    }
    return base + GR.SHARE_PREFIX + encoded;
  };

  // ------------------------------------------------------------ decoding --

  // Turn a payload back into runs, through the same hardened Ghost JSON parser
  // that reads files, so a crafted link is no more dangerous than a crafted file.
  GR.runsFromShare = function runsFromShare(payload) {
    const list = payload.r.slice(0, 6);
    const ghost = {
      runs: list.map((r) => {
        const flat = Array.isArray(r.e) ? r.e.slice(0, 200000 * 4) : [];
        const events = [];
        let t = 0;
        for (let i = 0; i + 3 < flat.length; i += 4) {
          const dt = Number(flat[i]);
          t += Number.isFinite(dt) && dt > 0 ? dt : 0;
          const kind = flat[i + 1] === 0 ? 'tool' : flat[i + 1] === 1 ? 'message' : 'error';
          const cat = CATS[flat[i + 2]] || 'other';
          events.push({ t: t / 10, type: kind, name: kind === 'message' ? 'reply' : cat, category: kind === 'message' ? undefined : cat, tokens: flat[i + 3] });
        }
        return { name: typeof r.n === 'string' ? r.n : 'Ghost', outcome: r.o === 1 ? 'dnf' : 'finish', events };
      }),
    };
    const runs = GR.parseLog(JSON.stringify(ghost), 'shared race');
    runs.forEach((run, i) => {
      const r = list[i];
      run.modelLabel = typeof r.l === 'string' && r.l ? r.l.slice(0, 40) : null;
      run.sourceLabel = typeof r.s === 'string' && r.s ? r.s.slice(0, 24) : 'Shared';
      run.color = typeof r.c === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.c) ? r.c : null;
      run.shared = true;
    });
    return {
      runs,
      title: typeof payload.ti === 'string' ? payload.ti.slice(0, 80) : '',
      mode: GR.own(GR.MODES, payload.m) ? payload.m : 'time',
      skipIdle: payload.i !== 0,
      fromCli: payload.f === 'cli',
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);

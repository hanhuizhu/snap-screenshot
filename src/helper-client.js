'use strict';

const { spawn } = require('node:child_process');

/**
 * Talks to the native `winsnap` helper: newline-delimited JSON over stdin/stdout.
 * The helper answers every request exactly once, in order, so a FIFO of pending
 * resolvers is enough to correlate replies.
 */
class HelperClient {
  constructor(bin, { selfPid = process.pid, log = () => {}, timeout = 160 } = {}) {
    this.selfPid = selfPid;
    this.log = log;
    this.timeout = timeout;
    this.pending = [];
    this.buf = '';
    this.greeting = null;
    this.dead = false;

    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => this.log('helper stderr:', String(d).trim()));
    this.child.on('error', (err) => {
      this.dead = true;
      this.log('helper spawn error:', err.message);
      this._drain();
    });
    this.child.on('exit', (code) => {
      this.dead = true;
      this.log('helper exited with', code);
      this._drain();
    });
  }

  _drain() {
    while (this.pending.length) {
      const entry = this.pending.shift();
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (!this.greeting && msg.ready) {
        this.greeting = msg;
        continue;
      }

      const entry = this.pending.shift();
      if (!entry) continue;
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  _send(obj) {
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        resolve(null);
      }, this.timeout);
      this.pending.push(entry);
      try {
        this.child.stdin.write(JSON.stringify(obj) + '\n');
      } catch (err) {
        clearTimeout(entry.timer);
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        resolve(null);
      }
    });
  }

  get axTrusted() {
    return !!(this.greeting && this.greeting.axTrusted);
  }

  async hit(x, y) {
    const res = await this._send({
      cmd: 'hit',
      x: Math.round(x),
      y: Math.round(y),
      selfPid: this.selfPid,
    });
    if (!res || !res.ok || !res.rect) return null;
    return res.rect;
  }

  async windows() {
    const res = await this._send({ cmd: 'windows' });
    return res && res.ok ? res.windows : [];
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    try {
      this.child.stdin.write('{"cmd":"quit"}\n');
    } catch {}
    this._drain();
    setTimeout(() => {
      try { this.child.kill(); } catch {}
    }, 150);
  }
}

module.exports = HelperClient;

'use strict';
// Classic ADB wire protocol: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt
// One shell stream per TCP connection; all writes obey ADB's OKAY flow control.
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

function packet(command, arg0, arg1, body) {
  body = body || Buffer.alloc(0);
  const head = Buffer.alloc(24);
  head.write(command, 0, 4, 'ascii');
  head.writeUInt32LE(arg0 >>> 0, 4);
  head.writeUInt32LE(arg1 >>> 0, 8);
  head.writeUInt32LE(body.length, 12);
  let sum = 0;
  for (const byte of body) sum = (sum + byte) >>> 0;
  head.writeUInt32LE(sum, 16);
  head.writeUInt32LE((head.readUInt32LE(0) ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([head, body]);
}

class AdbShell {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = Buffer.alloc(0);
    this.remote = 0;
    this.inflight = false;
    this.closed = false;
    this.ready = false;
    this.output = '';
  }

  open() {
    return new Promise((resolve, reject) => {
      if (this.options.allowed && !this.options.allowed())
        return reject(new Error('ADB scope ended'));
      let signed = false;
      let publicSent = false;
      const pem = fs.readFileSync(this.options.key);
      const pub = fs.readFileSync(this.options.key + '.pub', 'utf8').trim();
      const socket = this.socket = net.connect(this.options.port || 5555, this.options.host);
      socket.setNoDelay(true);
      this.fail = error => {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(timer);
        this.pending = Buffer.alloc(0);
        socket.destroy();
        reject(error);
        if (this.ready && this.onError) this.onError(error);
      };
      const timer = setTimeout(() => this.fail(new Error('ADB authorization/connect timed out')), 60000);
      this.cancelOpen = () => {
        clearTimeout(timer);
        reject(new Error('ADB connection cancelled'));
      };
      socket.on('connect', () => {
        try { this.send('CNXN', 0x01000000, 4096, Buffer.from('host::\0')); }
        catch (error) { this.fail(error); }
      });
      socket.on('error', error => this.fail(new Error('ADB socket: ' + error.code)));
      socket.on('close', () => {
        if (!this.closed) this.fail(new Error('ADB shell closed'));
      });
      socket.on('data', data => {
        try {
          if (this.options.allowed && !this.options.allowed()) throw new Error('ADB scope ended');
          this.buffer = Buffer.concat([this.buffer, data]);
          while (this.buffer.length >= 24) {
            const head = this.buffer;
            const length = head.readUInt32LE(12);
            if (length > 1024 * 1024 ||
                ((head.readUInt32LE(0) ^ 0xffffffff) >>> 0) !== head.readUInt32LE(20)) {
              throw new Error('Invalid ADB packet');
            }
            if (head.length < 24 + length) break;
            const command = head.toString('ascii', 0, 4);
            const arg0 = head.readUInt32LE(4);
            const arg1 = head.readUInt32LE(8);
            const body = head.slice(24, 24 + length);
            let sum = 0;
            for (const byte of body) sum = (sum + byte) >>> 0;
            if (sum !== head.readUInt32LE(16)) throw new Error('ADB checksum mismatch');
            this.buffer = head.slice(24 + length);
            if (command === 'AUTH' && arg0 === 1) {
              if (!signed) {
                signed = true;
                const digest = Buffer.concat([Buffer.from('3021300906052b0e03021a05000414', 'hex'), body]);
                const signature = crypto.privateEncrypt({key: pem, padding: crypto.constants.RSA_PKCS1_PADDING}, digest);
                this.send('AUTH', 2, 0, signature);
              } else if (!publicSent) {
                publicSent = true;
                this.send('AUTH', 3, 0, Buffer.from(pub + '\0'));
                console.error('Waiting for Fire TV to authorize the TV bridge key.');
              } else throw new Error('ADB key was rejected');
            } else if (command === 'CNXN') {
              this.send('OPEN', 1, 0, Buffer.from('shell:' + this.options.command + '\0'));
            } else if (command === 'OKAY' && arg1 === 1) {
              this.remote = arg0;
              this.inflight = false;
              if (!this.ready) {
                this.ready = true;
                clearTimeout(timer);
                resolve(this);
              }
              this.flush();
            } else if (command === 'WRTE' && arg1 === 1) {
              if (this.output.length + body.length > 65536) throw new Error('ADB shell output limit');
              this.output += body.toString('utf8');
              if (this.onData) this.onData(body);
              this.send('OKAY', 1, arg0);
            } else if (command === 'CLSE') {
              this.send('CLSE', 1, arg0);
              throw new Error('ADB command ended: ' + this.output.slice(0, 256));
            }
          }
        } catch (error) {
          this.fail(error);
        }
      });
    });
  }

  send(command, arg0, arg1, body) {
    if (this.options.allowed && !this.options.allowed()) throw new Error('ADB scope ended');
    this.socket.write(packet(command, arg0, arg1, body));
  }

  write(data) {
    if (this.closed) throw new Error('ADB stream is closed');
    data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (this.pending.length + data.length > 65536) throw new Error('ADB input backpressure limit');
    this.pending = Buffer.concat([this.pending, data]);
    this.flush();
  }

  flush() {
    if (!this.ready || this.inflight || !this.pending.length || this.closed) return;
    if (this.options.allowed && !this.options.allowed()) return this.fail(new Error('ADB scope ended'));
    const data = this.pending.slice(0, 4096);
    this.pending = this.pending.slice(data.length);
    this.inflight = true;
    this.send('WRTE', 1, this.remote, data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.cancelOpen) this.cancelOpen();
    this.pending = Buffer.alloc(0);
    if (!this.socket) return;
    if (this.remote && (!this.options.allowed || this.options.allowed())) this.send('CLSE', 1, this.remote);
    this.socket.end();
    this.socket.destroy();
    // Also settle callers waiting for command output after open() completed.
    if (this.ready && this.onError) this.onError(new Error('ADB shell closed'));
  }
}

module.exports = {AdbShell, packet};

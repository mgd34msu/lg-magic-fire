'use strict';
// The same relative HID mouse descriptor used by the working Fire TV pointer.
const descriptor = [5,1,9,2,161,1,9,1,161,0,5,9,25,1,41,3,21,0,37,1,149,3,117,1,
  129,2,149,1,117,5,129,3,5,1,9,48,9,49,9,56,21,129,37,127,117,8,149,3,129,6,192,192];

class Mouse {
  constructor(write, gain) {
    this.write = write;
    this.gain = gain;
    this.buttons = 0;
    this.positions = {};
    this.lastHorizontal = 1;
  }
  send(event) { this.write(JSON.stringify(Object.assign({id: 1}, event)) + '\n'); }
  register() {
    this.send({command: 'register', name: 'Magic Fire Mouse', vid: 0x1209, pid: 0x4d46, descriptor});
  }
  report(dx, dy, wheel) {
    dx = dx || 0; dy = dy || 0; wheel = wheel || 0;
    if (dx) this.lastHorizontal = Math.sign(dx);
    do {
      const x = Math.max(-127, Math.min(127, dx));
      const y = Math.max(-127, Math.min(127, dy));
      const w = Math.max(-127, Math.min(127, wheel));
      this.send({command: 'report', report: [this.buttons, x & 255, y & 255, w & 255]});
      dx -= x; dy -= y; wheel -= w;
    } while (dx || dy || wheel);
  }
  reset(device, x, y) {
    const old = this.positions[device];
    this.positions[device] = {x, y, rx: old ? old.rx : 0, ry: old ? old.ry : 0};
  }
  move(device, x, y) {
    const old = this.positions[device];
    if (!old) { this.reset(device, x, y); return; }
    const dx = (x - old.x) * this.gain + old.rx;
    const dy = (y - old.y) * this.gain + old.ry;
    const ix = Math.trunc(dx), iy = Math.trunc(dy);
    old.x = x; old.y = y; old.rx = dx - ix; old.ry = dy - iy;
    if (ix || iy) this.report(ix, iy, 0);
  }
  release() { this.buttons = 0; this.report(); }
  keepAlive() {
    if (this.buttons) return; // Never synthesize motion during a drag.
    // Inward first at an edge, then back. One write keeps the reports adjacent.
    const step = -this.lastHorizontal;
    const report = x => JSON.stringify({id: 1, command: 'report', report: [0, x & 255, 0, 0]}) + '\n';
    this.write(report(step) + report(-step));
  }
}
module.exports = {Mouse, descriptor};

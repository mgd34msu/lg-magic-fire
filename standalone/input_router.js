'use strict';
// Scope and button decisions stay separate from the established mouse engine.
const navigation = {28: 'select', 352: 'select', 103: 'dpad_up', 108: 'dpad_down',
  105: 'dpad_left', 106: 'dpad_right'};
const media = {119: 127, 165: 88, 163: 87, 168: 89, 166: 86, 207: 126, 208: 90};

class InputRouter {
  constructor(mouse, key, mediaKey, targetApp, cursor) {
    if (typeof targetApp !== 'string' || !/^com\.webos\.app\.hdmi[1-4]$/.test(targetApp))
      throw new Error('A validated target HDMI app is required');
    this.targetApp = targetApp;
    this.cursor = cursor;
    this.mouse = mouse;
    this.key = key;
    this.mediaKey = mediaKey;
    this.active = false;
    this.devices = {};
    this.held = new Set();
  }
  async handle(e) {
    if (e.kind === 'device' && e.name.indexOf('LGE M-RCU') === 0) {
      this.devices[e.device] = {x: e.axes[0][0], y: e.axes[1][0], dirty: false};
      return;
    }
    if (e.kind === 'foreground') {
      const enabled = e.active === true && e.app === this.targetApp;
      if (enabled !== this.active) {
        this.active = enabled;
        if (this.cursor) this.cursor.scope(enabled);
        if (!enabled) {
          this.mouse.release();
          for (const key of Array.from(this.held)) {
            await this.key(key, 0);
            this.held.delete(key);
          }
        }
        this.mouse.positions = {};
      }
      return;
    }
    const p = this.devices[e.device];
    if (!p || !this.active) return;
    if (e.kind === 'pointer-reset') {
      p.x = e.x; p.y = e.y; p.dirty = false;
      this.mouse.reset(e.device, e.x, e.y);
      return;
    }
    if (e.kind !== 'event' || e.active !== true) return;
    if (e.type === 3 && (e.code === 0 || e.code === 1)) {
      p[e.code === 0 ? 'x' : 'y'] = e.value;
      p.dirty = true;
    } else if (e.type === 0 && e.code === 0) {
      if (p.dirty) {
        if (this.cursor) this.cursor.activity();
        this.mouse.move(e.device, p.x, p.y);
      }
      p.dirty = false;
    } else if (e.type === 2 && e.code === 8) {
      if (this.cursor) this.cursor.activity();
      this.mouse.report(0, 0, e.value);
    } else if (e.type === 1) {
      if (e.code === 272 && e.value !== 2) {
        if (this.cursor) this.cursor.activity();
        this.mouse.buttons = e.value;
        this.mouse.report();
      } else if (navigation[e.code] && e.value !== 2) {
        const key = navigation[e.code];
        if (e.value === 1) this.held.add(key);
        await this.key(key, e.value);
        if (!e.value) this.held.delete(key);
      } else if ((e.code === 412 || e.code === 158) && e.value === 1) {
        await this.key('back', 1);
      } else if (e.code === 164 && e.value === 1) {
        await this.key('playPause', 1);
      } else if (media[e.code] && e.value === 1) {
        await this.mediaKey(media[e.code]);
      }
    }
  }
}
module.exports = {InputRouter};

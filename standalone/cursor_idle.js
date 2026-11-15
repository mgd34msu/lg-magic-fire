'use strict';

// Visibility has its own clock. Keepalive reports must never extend real activity.
class CursorIdle {
  constructor(seconds, visibility, pulse, now) {
    this.timeout = seconds * 1000;
    this.visibility = visibility;
    this.pulse = pulse;
    this.now = now || (() => Date.now());
    this.active = false;
    this.visible = false;
    this.lastActivity = -Infinity;
    this.lastPulse = -Infinity;
  }
  scope(active) {
    this.active = active;
    if (!active) {
      this.lastActivity = -Infinity;
      this.setVisible(false);
    }
  }
  setVisible(visible) {
    if (visible === this.visible) return;
    this.visibility(visible);
    this.visible = visible;
  }
  activity() {
    if (!this.active) return;
    this.lastActivity = this.now();
    this.setVisible(true);
  }
  tick() {
    if (!this.active || this.now() - this.lastActivity >= this.timeout) {
      this.setVisible(false);
      return;
    }
    // Android's native cursor timer can be shorter than our configured timeout.
    // A balanced pair keeps that timer awake without changing the motion baseline.
    if (this.now() - this.lastPulse >= 2000) {
      this.pulse();
      this.lastPulse = this.now();
    }
  }
}
module.exports = {CursorIdle};

'use strict';

// Updated directly from the reader, outside the async input queue. A late
// connection or queued press must not outlive the input/power state that allowed it.
class Scope {
  constructor(targetApp, inactive, now) {
    this.targetApp = targetApp;
    this.inactive = inactive;
    this.now = now || (() => {
      const stamp = process.hrtime();
      return stamp[0] * 1000 + stamp[1] / 1000000;
    });
    this.active = false;
    this.generation = 0;
    this.checkedAt = -Infinity;
  }
  observe(event) {
    if (event.kind !== 'foreground') return;
    if (event.active === true && event.app === this.targetApp) {
      // A heartbeat after a suspension cannot revive work authorized before it.
      this.tick();
      if (!this.active) this.generation++;
      this.active = true;
      this.checkedAt = this.now();
    } else {
      this.revoke();
    }
  }
  valid(generation) {
    return this.active && generation === this.generation && this.now() - this.checkedAt < 1500;
  }
  tick() {
    if (this.active && !this.valid(this.generation)) this.revoke();
  }
  revoke() {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    this.inactive();
  }
}

module.exports = {Scope};

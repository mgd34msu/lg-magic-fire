'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');
const Scope = require('../standalone/scope').Scope;

function harness(options) {
  const state = {requests: [], writes: [], shells: [], exits: [], logs: [], clock: 0, options: options || {}};
  const lines = state.lines = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  class TestScope extends Scope {
    constructor(app, inactive) { super(app, inactive, () => state.clock); }
  }
  class FakeShell {
    constructor(config) {
      this.options = config;
      this.output = config.command === 'hid -' ? '' :
        config.command.indexOf('dumpsys input') === 0 ? 'Magic Fire Mouse\nMAGIC_FIRE_DONE:0' : 'CURSOR_READY';
      this.closed = false;
      state.shells.push(this);
    }
    open() {
      assert(this.options.allowed(), 'opening an ADB shell requires live scope');
      if (state.options.holdAdb) return new Promise((resolve, reject) => { this.cancel = reject; });
      if (this.options.command.indexOf('dumpsys input') === 0)
        Promise.resolve().then(() => this.onError(new Error('command completed')));
      return Promise.resolve(this);
    }
    write(data) {
      assert(this.options.allowed(), 'ADB write after scope was revoked');
      state.writes.push(String(data));
    }
    close() {
      this.closed = true;
      if (this.cancel) this.cancel(new Error('cancelled'));
    }
  }
  const https = {
    request(config, callback) {
      const req = new EventEmitter();
      req.config = config;
      req.end = () => {
        state.requests.push(req);
        if (state.options.holdStatus && config.path === '/v1/FireTV/status') return;
        Promise.resolve().then(() => {
          if (req.destroyed) return;
          const response = new EventEmitter();
          response.statusCode = state.options.httpStatus || 200;
          callback(response);
          response.emit('data', Buffer.from('{}'));
          response.emit('end');
          req.emit('close');
        });
      };
      req.destroy = error => {
        req.destroyed = true;
        req.emit('error', error);
        req.emit('close');
      };
      return req;
    }
  };
  const settings = {fire_tv_host: 'fire.example', pointer_gain: .6, adb_port: 5555, hdmi_input: 3, cursor_idle_seconds: 5};
  const processMock = new EventEmitter();
  processMock.env = {};
  processMock.exit = code => state.exits.push(code);
  const modules = {
    fs: {readFileSync: () => '{"client_token":"fixture"}'}, path, https,
    child_process: {spawn: () => child}, readline: {createInterface: () => lines}, crypto: require('crypto'),
    ws: class extends EventEmitter {}, './adb': {AdbShell: FakeShell},
    './hid_mouse': require('../standalone/hid_mouse'), './input_router': require('../standalone/input_router'),
    './cursor_idle': require('../standalone/cursor_idle'), './scope': {Scope: TestScope},
    './settings': {loadSettings: () => settings, targetApp: () => 'com.webos.app.hdmi3'}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../standalone/bridge.js'), 'utf8'), {
    require: name => { assert(modules[name], 'Unexpected dependency/network path: ' + name); return modules[name]; },
    __dirname: '/fixture', process: processMock, Buffer, Date, Set, Promise,
    setTimeout, clearTimeout, setInterval: callback => { state.tick = callback; return 1; }, clearInterval: () => {},
    console: {log: line => state.logs.push(line)}
  });
  state.send = event => lines.emit('line', JSON.stringify(event));
  state.scope = (app, active) => state.send({kind: 'foreground', app, active});
  state.selected = () => state.scope('com.webos.app.hdmi3', true);
  state.press = code => state.send({kind: 'event', device: 'remote', type: 1, code, value: 1, active: true});
  state.send({kind: 'device', device: 'remote', name: 'LGE M-RCU', axes: {0: [960], 1: [540]}});
  return state;
}

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  const idle = harness();
  await flush();
  assert.equal(idle.requests.length, 0, 'boot must not contact or launch Fire TV');
  idle.scope('LG-power:Active Standby', false);
  idle.press(103);
  idle.scope('com.webos.app.hdmi4', false);
  idle.press(103);
  idle.selected();
  idle.send({kind: 'pointer-reset', device: 'remote', x: 960, y: 540});
  await flush();
  assert.equal(idle.requests.length, 0, 'power/input observations alone must not contact Fire TV');
  idle.press(103);
  await flush();
  assert.equal(idle.requests.length, 2, 'physical scoped input opens a session and forwards the press');
  assert.equal(idle.requests[0].config.path, '/v1/FireTV/status');
  assert.equal(idle.requests[1].config.path, '/v1/FireTV?action=dpad_up');
  assert(idle.requests.every(req => req.config.port === 8080), 'no runtime DIAL launch');
  idle.scope('LG-power:Active Standby', false);
  assert(idle.shells.every(shell => shell.closed), 'standby immediately disconnects all ADB sessions');
  const requests = idle.requests.length, writes = idle.writes.length;
  idle.tick();
  idle.press(103);
  await flush();
  assert.equal(idle.requests.length, requests, 'standby must not send synthetic key releases or reopen connections');
  assert.equal(idle.writes.length, writes, 'standby must not send cleanup or keepalive mouse input');

  const pending = harness({holdStatus: true});
  pending.selected();
  pending.press(103);
  pending.press(108);
  await flush();
  assert.equal(pending.requests.length, 1);
  pending.scope('com.webos.app.hdmi4', false);
  assert(pending.requests[0].destroyed, 'input change cancels in-flight HTTP immediately');
  pending.selected();
  pending.options.holdStatus = false;
  await flush();
  assert.equal(pending.requests.length, 1, 'queued old-generation input must not replay after returning');
  assert.equal(pending.shells.length, 0, 'late HTTP completion must not initialize a mouse');
  pending.press(412);
  await flush();
  assert.equal(pending.requests.length, 3, 'new physical input can reconnect after returning');
  pending.clock = 1500;
  pending.tick();
  assert(pending.shells.every(shell => shell.closed), 'stale LG scope must close all connections');
  const afterExpiry = pending.requests.length;
  pending.press(103);
  await flush();
  assert.equal(pending.requests.length, afterExpiry, 'no forwarding with stale power/input observations');

  const resumed = harness();
  resumed.selected();
  resumed.press(412);
  await flush();
  resumed.clock = 2000;
  resumed.selected();
  assert(resumed.shells.every(shell => shell.closed), 'a heartbeat after suspension cannot revive the old session');
  const resumedRequests = resumed.requests.length;
  await flush();
  assert.equal(resumed.requests.length, resumedRequests, 'resuming observations alone must stay idle');

  const authorizing = harness({holdAdb: true});
  authorizing.selected();
  authorizing.press(103);
  await flush();
  assert.equal(authorizing.shells.length, 1);
  authorizing.scope('LG-power:Screen Off', false);
  await flush();
  assert(authorizing.shells[0].closed, 'input change cancels pending ADB authorization');
  assert.equal(authorizing.writes.length, 0, 'no HID registration after cancelled authorization');

  const unavailable = harness({httpStatus: 503});
  unavailable.selected();
  unavailable.press(103);
  await flush();
  assert.equal(unavailable.exits.length, 0, 'Fire TV failures must leave the LG listener running');
  assert.equal(unavailable.requests.length, 1, 'a failed status probe must not launch the remote service');
  unavailable.press(103);
  await flush();
  assert.equal(unavailable.requests.length, 1, 'failed connections are rate limited');
  console.log('Bridge startup, standby, input changes, cancellation, and retry checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

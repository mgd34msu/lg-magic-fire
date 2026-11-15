'use strict';
// Runs on the TV's stock Node 8. Python reads evdev and owns recovery leases.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const cp = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const WebSocket = require('ws');
const AdbShell = require('./adb').AdbShell;
const Mouse = require('./hid_mouse').Mouse;
const InputRouter = require('./input_router').InputRouter;
const CursorIdle = require('./cursor_idle').CursorIdle;
const settingsLoader = require('./settings');
const directory = __dirname;
const settingsPath = path.resolve(process.env.MAGIC_FIRE_SETTINGS || path.join(directory, 'settings.json'));
const settings = settingsLoader.loadSettings(settingsPath);
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')));
const config = {host: settings.fire_tv_host, client_token: credentials.client_token,
  gain: settings.pointer_gain, adb_port: settings.adb_port};
const expectedApp = settingsLoader.targetApp(settings);
const log = message => console.log(new Date().toISOString() + ' ' + message);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


function request(route, data) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : Buffer.from(JSON.stringify(data));
    const req = https.request({
      host: config.host, port: 8080, path: route, method: body ? 'POST' : 'GET',
      rejectUnauthorized: false, agent: false,
      headers: {'x-api-key': '0987654321', 'x-client-token': config.client_token,
        'Content-Type': 'application/json', 'Content-Length': body ? body.length : 0}
    }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', data => {
        length += data.length;
        if (length > 1048576) return req.destroy(new Error('Native response limit'));
        chunks.push(data);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error('Fire TV HTTP ' + res.statusCode));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Fire TV request timed out')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

class Voice {
  constructor() {
    this.socket = null;
    this.owned = false;
    this.bytes = 0;
    this.pending = Buffer.alloc(0);
  }
  async start() {
    if (this.owned) await this.stop();
    try {
      await request('/v1/FireTV/voiceCommand?action=start', {});
      this.owned = true;
      const socket = this.socket = new WebSocket('wss://' + config.host + ':9090/', {
        rejectUnauthorized: false, perMessageDeflate: false, handshakeTimeout: 5000,
        headers: {'x-api-key': '0987654321', 'x-client-token': config.client_token}
      });
      socket.on('error', error => log('Voice socket error: ' + error.message));
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      this.bytes = 0;
      this.pending = Buffer.alloc(0);
      log('Alexa listening');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  audio(data) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Alexa audio socket is not open');
    if (this.socket.bufferedAmount > 256 * 1024) throw new Error('Alexa audio backpressure limit');
    const joined = Buffer.concat([this.pending, data]);
    const length = joined.length & ~1;
    if (length) {
      this.socket.send(joined.slice(0, length), {binary: true});
      this.bytes += length;
    }
    this.pending = joined.slice(length);
  }
  async stop() {
    try {
      if (this.owned) {
        await request('/v1/FireTV/voiceCommand?action=stop', {});
        this.owned = false;
      }
    } finally {
      if (this.socket) {
        const socket = this.socket;
        this.socket = null;
        socket.close();
        const timer = setTimeout(() => socket.terminate(), 1000);
        socket.once('close', () => clearTimeout(timer));
      }
      this.pending = Buffer.alloc(0);
    }
  }
}

let adb = null;
let agent = null;
let exiting = false;
let queue = Promise.resolve();
let count = 0;
const voice = new Voice();
let mouse = null;
let router = null;
let cursorShell = null;
let cursorTimer = null;

async function fireKey(key, value) {
  if (key === 'playPause') {
    if (value === 1) await request('/v1/media?action=play', {});
  } else if (key === 'back') {
    if (value === 1) await request('/v1/FireTV?action=back', {});
  } else {
    await request('/v1/FireTV?action=' + key,
      {keyActionType: value === 1 ? 'keyDown' : 'keyUp'});
  }
}

async function shellCommand(command) {
  const shell = new AdbShell({host: config.host, port: config.adb_port, key: path.join(directory, 'adbkey'),
    command: command + '; magic_fire_rc=$?; echo MAGIC_FIRE_DONE:$magic_fire_rc'});
  let timer;
  const completed = new Promise((resolve, reject) => {
    shell.onError = error => {
      if (shell.output.indexOf('MAGIC_FIRE_DONE:0') !== -1) resolve(shell.output);
      else reject(error);
    };
    timer = setTimeout(() => reject(new Error('ADB command timeout')), 6000);
  });
  try {
    const results = await Promise.all([shell.open(), completed]);
    return results[1];
  } finally {
    clearTimeout(timer);
    shell.close();
  }
}

async function event(e) {
  if (e.kind === 'voice-start') {
    if (router.active) await voice.start();
    return;
  }
  if (e.kind === 'voice-audio') {
    if (router.active && voice.owned) voice.audio(Buffer.from(e.pcm, 'base64'));
    return;
  }
  if (e.kind === 'voice-end') {
    await voice.stop();
    log('Alexa session ended (' + e.reason + ')');
    return;
  }
  const previous = router.active;
  await router.handle(e);
  if (previous !== router.active) {
    if (!router.active) await voice.stop();
    log(router.active ? 'Fire TV cursor active on HDMI ' + settings.hdmi_input : 'LG controls restored; Fire TV forwarding paused');
  }
}

async function shutdown(error) {
  if (exiting) return;
  exiting = true;
  clearInterval(cursorTimer);
  if (error) log('Stopping: ' + error.message);
  // Restore TV control first, independently of Fire TV availability.
  if (agent) {
    agent.kill('SIGTERM');
    await Promise.race([new Promise(resolve => agent.once('exit', resolve)), sleep(1500)]);
  }
  if (router) {
    try { await router.handle({kind: 'foreground', app: null, active: false}); } catch (_) {}
  }
  try { await voice.stop(); } catch (_) {}
  if (cursorShell) {
    try { cursorShell.write('show\n'); await sleep(100); } catch (_) {}
    cursorShell.close();
  }
  if (adb) adb.close();
  process.exit(error ? 1 : 0);
}

async function start() {
  // Activate the LAN remote service explicitly once per bridge start.
  await new Promise((resolve, reject) => {
    const req = http.request({host: config.host, port: 8009, path: '/apps/FireTVRemote', method: 'POST'}, res => {
      res.resume();
      res.on('end', () => res.statusCode === 201 ? resolve() : reject(new Error('DIAL HTTP ' + res.statusCode)));
    });
    req.setTimeout(5000, () => req.destroy(new Error('DIAL timed out')));
    req.on('error', reject);
    req.end();
  });
  await sleep(500);
  await request('/v1/FireTV/status');
  const gain = config.gain === undefined ? .6 : config.gain;
  if (!Number.isFinite(gain) || gain < .1 || gain > 2) throw new Error('Invalid pointer gain');
  adb = new AdbShell({host: config.host, port: config.adb_port, key: path.join(directory, 'adbkey'), command: 'hid -'});
  await adb.open();
  adb.onError = error => shutdown(error);
  mouse = new Mouse(data => adb.write(data), gain);
  mouse.register();
  const readyUntil = Date.now() + 6000;
  let registered = false;
  while (Date.now() < readyUntil) {
    const devices = await shellCommand('dumpsys input');
    if (devices.indexOf('Magic Fire Mouse') !== -1) { registered = true; break; }
    await sleep(200);
  }
  if (!registered) throw new Error('Fire TV mouse did not register');
  cursorShell = new AdbShell({host: config.host, port: config.adb_port,
    key: path.join(directory, 'adbkey'),
    command: 'CLASSPATH=/data/local/tmp/lg-magic-fire-cursor.jar app_process /system/bin PointerVisibility'});
  await cursorShell.open();
  cursorShell.onError = error => shutdown(error);
  const cursorDeadline = Date.now() + 6000;
  while (cursorShell.output.indexOf('CURSOR_READY') === -1) {
    if (cursorShell.closed || Date.now() > cursorDeadline) throw new Error('Cursor visibility helper did not start');
    await sleep(50);
  }
  cursorShell.write('hide\n');
  const cursor = new CursorIdle(settings.cursor_idle_seconds,
    visible => cursorShell.write(visible ? 'show\n' : 'hide\n'), () => mouse.keepAlive());
  cursorTimer = setInterval(() => {
    try { cursor.tick(); } catch (error) { shutdown(error); }
  }, 100);
  router = new InputRouter(mouse, fireKey, code => shellCommand('input keyevent ' + code), expectedApp, cursor);
  agent = cp.spawn('python', ['-B', '-u', path.join(directory, 'tv_agent.py'), 'bridge', '0',
    crypto.randomBytes(16).toString('hex')], {stdio: ['ignore', 'pipe', 'inherit'],
      env: Object.assign({}, process.env, {MAGIC_FIRE_SETTINGS: settingsPath})});
  agent.on('error', error => shutdown(error));
  agent.on('exit', code => { if (!exiting) shutdown(new Error('TV input agent exited: ' + code)); });
  const lines = readline.createInterface({input: agent.stdout});
  lines.on('line', line => {
    if (exiting) return;
    count++;
    if (count > 10000) return shutdown(new Error('Input processing backlog'));
    queue = queue.then(() => event(JSON.parse(line))).then(() => { count--; })
      .catch(error => shutdown(error));
  });
  log('Magic Fire started: established Fire TV mouse, gain ' + gain);
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('uncaughtException', error => shutdown(error));
process.on('unhandledRejection', error => shutdown(error));
start().catch(error => shutdown(error));

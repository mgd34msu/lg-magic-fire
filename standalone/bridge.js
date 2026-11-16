'use strict';
// Runs on the TV's stock Node 8. Python reads evdev and owns recovery leases.
const fs = require('fs');
const path = require('path');
const https = require('https');
const cp = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const WebSocket = require('ws');
const AdbShell = require('./adb').AdbShell;
const Mouse = require('./hid_mouse').Mouse;
const InputRouter = require('./input_router').InputRouter;
const CursorIdle = require('./cursor_idle').CursorIdle;
const settingsLoader = require('./settings');
const Scope = require('./scope').Scope;
const directory = __dirname;
const settingsPath = path.resolve(process.env.MAGIC_FIRE_SETTINGS || path.join(directory, 'settings.json'));
const settings = settingsLoader.loadSettings(settingsPath);
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')));
const config = {host: settings.fire_tv_host, client_token: credentials.client_token,
  gain: settings.pointer_gain, adb_port: settings.adb_port};
const expectedApp = settingsLoader.targetApp(settings);
const log = message => console.log(new Date().toISOString() + ' ' + message);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


function request(session, route, data) {
  return new Promise((resolve, reject) => {
    if (!permitted(session)) return reject(new Error('Fire TV scope ended'));
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
        if (!permitted(session)) return reject(new Error('Fire TV scope ended'));
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error('Fire TV HTTP ' + res.statusCode));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Fire TV request timed out')), 5000);
    session.requests.add(req);
    req.on('close', () => { clearTimeout(timer); session.requests.delete(req); });
    req.on('error', reject);
    req.end(body);
  });
}

class Voice {
  constructor(session) {
    this.session = session;
    this.socket = null;
    this.owned = false;
    this.bytes = 0;
    this.pending = Buffer.alloc(0);
  }
  async start() {
    if (this.owned) await this.stop();
    try {
      await request(this.session, '/v1/FireTV/voiceCommand?action=start', {});
      if (!permitted(this.session)) throw new Error('Fire TV scope ended');
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
    if (!permitted(this.session)) return;
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
  abandon() {
    this.owned = false;
    if (this.socket) this.socket.terminate();
    this.socket = null;
    this.pending = Buffer.alloc(0);
  }
  async stop() {
    try {
      const owned = this.owned;
      this.owned = false;
      if (owned && permitted(this.session))
        await request(this.session, '/v1/FireTV/voiceCommand?action=stop', {});
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

let session = null;
let agent = null;
let exiting = false;
let queue = Promise.resolve();
let count = 0;
let retryAt = 0;
const devices = {};
const scope = new Scope(expectedApp, disposeSession);

function permitted(candidate) {
  return !exiting && candidate === session && scope.valid(candidate.generation);
}

function disposeSession() {
  const previous = session;
  session = null;
  if (!previous) return;
  // Disconnect instead of injecting cleanup input after the user has left or
  // powered off. Closing hid removes its mouse, including any held buttons.
  previous.voice.abandon();
  previous.requests.forEach(req => req.destroy(new Error('Fire TV scope ended')));
  previous.shells.forEach(shell => shell.close());
  log('LG controls restored; Fire TV connections closed');
}

async function fireKey(candidate, key, value) {
  if (!permitted(candidate)) return;
  if (key === 'playPause') {
    if (value === 1) await request(candidate, '/v1/media?action=play', {});
  } else if (key === 'back') {
    if (value === 1) await request(candidate, '/v1/FireTV?action=back', {});
  } else {
    await request(candidate, '/v1/FireTV?action=' + key,
      {keyActionType: value === 1 ? 'keyDown' : 'keyUp'});
  }
}

function newShell(candidate, command) {
  if (!permitted(candidate)) throw new Error('Fire TV scope ended');
  const shell = new AdbShell({host: config.host, port: config.adb_port,
    key: path.join(directory, 'adbkey'), command, allowed: () => permitted(candidate)});
  candidate.shells.add(shell);
  return shell;
}

async function shellCommand(candidate, command) {
  const shell = newShell(candidate, command + '; magic_fire_rc=$?; echo MAGIC_FIRE_DONE:$magic_fire_rc');
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
    if (!permitted(candidate)) throw new Error('Fire TV scope ended');
    return results[1];
  } finally {
    clearTimeout(timer);
    shell.close();
    candidate.shells.delete(shell);
  }
}

async function initialize(candidate) {
  // Never POST /apps/FireTVRemote here. DIAL launch can assert HDMI-CEC active
  // source and power on the TV. Pairing is the explicit service activation step.
  await request(candidate, '/v1/FireTV/status');
  const adb = newShell(candidate, 'hid -');
  await adb.open();
  adb.onError = error => failed(candidate, error);
  const mouse = candidate.mouse = new Mouse(data => {
    if (!permitted(candidate)) throw new Error('Fire TV scope ended');
    adb.write(data);
  }, config.gain);
  mouse.register();
  const readyUntil = scope.now() + 6000;
  let registered = false;
  while (scope.now() < readyUntil) {
    const info = await shellCommand(candidate, 'dumpsys input');
    if (info.indexOf('Magic Fire Mouse') !== -1) { registered = true; break; }
    await sleep(200);
  }
  if (!registered) throw new Error('Fire TV mouse did not register');
  const cursorShell = newShell(candidate,
    'CLASSPATH=/data/local/tmp/lg-magic-fire-cursor.jar app_process /system/bin PointerVisibility');
  await cursorShell.open();
  cursorShell.onError = error => failed(candidate, error);
  const cursorDeadline = scope.now() + 6000;
  while (cursorShell.output.indexOf('CURSOR_READY') === -1) {
    if (!permitted(candidate)) throw new Error('Fire TV scope ended');
    if (cursorShell.closed || scope.now() > cursorDeadline) throw new Error('Cursor visibility helper did not start');
    await sleep(50);
  }
  if (!permitted(candidate)) throw new Error('Fire TV scope ended');
  cursorShell.write('hide\n');
  candidate.cursor = new CursorIdle(settings.cursor_idle_seconds,
    visible => cursorShell.write(visible ? 'show\n' : 'hide\n'), () => mouse.keepAlive());
  const router = candidate.router = new InputRouter(mouse,
    (key, value) => fireKey(candidate, key, value),
    code => shellCommand(candidate, 'input keyevent ' + code), expectedApp, candidate.cursor);
  for (const device of Object.keys(devices)) await router.handle(devices[device]);
  if (!permitted(candidate)) throw new Error('Fire TV scope ended');
  await router.handle({kind: 'foreground', app: expectedApp, active: true});
  log('Fire TV cursor active on HDMI ' + settings.hdmi_input + ', gain ' + config.gain);
}

function failed(candidate, error) {
  if (candidate !== session) return;
  log('Fire TV session: ' + error.message);
  retryAt = scope.now() + 5000;
  disposeSession();
}

async function event(e, generation) {
  // No connection on startup, foreground polling, or pointer reset. Only a
  // physical event while the TV is awake on the selected input opens a session.
  if (!scope.valid(generation) || e.kind === 'foreground') return;
  if (!session) {
    if (scope.now() < retryAt || (e.kind !== 'event' && e.kind !== 'voice-start')) return;
    if (e.kind === 'event' && e.active !== true) return;
    session = {generation, requests: new Set(), shells: new Set()};
    session.voice = new Voice(session);
    session.ready = initialize(session);
  }
  const candidate = session;
  try {
    await candidate.ready;
    if (!permitted(candidate) || candidate.generation !== generation) return;
    if (e.kind === 'voice-start') {
      await candidate.voice.start();
    } else if (e.kind === 'voice-audio') {
      if (candidate.voice.owned) candidate.voice.audio(Buffer.from(e.pcm, 'base64'));
    } else if (e.kind === 'voice-end') {
      await candidate.voice.stop();
      log('Alexa session ended (' + e.reason + ')');
    } else {
      await candidate.router.handle(e);
    }
  } catch (error) {
    failed(candidate, error);
  }
}

const cursorTimer = setInterval(() => {
  scope.tick();
  if (session && permitted(session) && session.cursor) {
    try { session.cursor.tick(); } catch (error) { failed(session, error); }
  }
}, 100);

async function shutdown(error) {
  if (exiting) return;
  exiting = true;
  clearInterval(cursorTimer);
  if (error) log('Stopping: ' + error.message);
  scope.revoke();
  disposeSession();
  if (agent) {
    agent.kill('SIGTERM');
    await Promise.race([new Promise(resolve => agent.once('exit', resolve)), sleep(1500)]);
  }
  process.exit(error ? 1 : 0);
}

function start() {
  // Observe LG first. Fire TV must remain untouched while this process waits.
  agent = cp.spawn('python', ['-B', '-u', path.join(directory, 'tv_agent.py'), 'bridge', '0',
    crypto.randomBytes(16).toString('hex')], {stdio: ['ignore', 'pipe', 'inherit'],
      env: Object.assign({}, process.env, {MAGIC_FIRE_SETTINGS: settingsPath})});
  agent.on('error', error => shutdown(error));
  agent.on('exit', code => { if (!exiting) shutdown(new Error('TV input agent exited: ' + code)); });
  const lines = readline.createInterface({input: agent.stdout});
  lines.on('line', line => {
    if (exiting) return;
    try {
      const e = JSON.parse(line);
      scope.observe(e); // Immediately cancels in-flight initialization and input.
      if (e.kind === 'device') devices[e.device] = e;
      if (e.kind === 'pointer-reset' && devices[e.device]) {
        devices[e.device].axes = {0: [e.x], 1: [e.y]};
      }
      const generation = scope.generation;
      count++;
      if (count > 10000) return shutdown(new Error('Input processing backlog'));
      queue = queue.then(() => event(e, generation)).then(() => { count--; })
        .catch(error => shutdown(error));
    } catch (error) {
      shutdown(error);
    }
  });
  lines.on('close', () => scope.revoke());
  log('Magic Fire listening; waiting for remote activity on an awake HDMI ' + settings.hdmi_input);
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('uncaughtException', error => shutdown(error));
process.on('unhandledRejection', error => shutdown(error));
start();

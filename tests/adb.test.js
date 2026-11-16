'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const EventEmitter = require('events');

function harness() {
  const state = {allowed: true, writes: [], timers: new Set()};
  const socket = state.socket = new EventEmitter();
  socket.setNoDelay = () => {};
  socket.write = data => state.writes.push(data.toString('ascii', 0, 4));
  socket.end = () => {};
  socket.destroy = () => { state.destroyed = true; socket.emit('close'); };
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../standalone/adb'), 'utf8'), {
    module, Buffer, setTimeout: callback => { state.timers.add(callback); return callback; },
    clearTimeout: callback => state.timers.delete(callback), console,
    require: name => name === 'net' ? {connect: () => socket} : name === 'fs' ?
      {readFileSync: () => 'fixture-key'} : require(name)
  });
  state.shell = new module.exports.AdbShell({host: 'fire.example', key: '/fixture/key', command: 'hid -',
    allowed: () => state.allowed});
  state.packet = module.exports.packet;
  return state;
}

(async () => {
  const denied = harness();
  denied.allowed = false;
  await assertRejected(denied.shell.open());
  assert.equal(denied.timers.size, 0, 'inactive scope cannot begin authorization');

  const pending = harness();
  const opening = pending.shell.open();
  pending.socket.emit('connect');
  pending.shell.close();
  await assertRejected(opening);
  assert.equal(pending.timers.size, 0, 'cancellation clears the authorization timer');
  assert(pending.destroyed, 'cancellation closes the socket');

  const late = harness();
  const lateOpening = late.shell.open();
  late.allowed = false;
  late.socket.emit('connect');
  await assertRejected(lateOpening);
  assert.deepEqual(late.writes, [], 'a late connection cannot handshake after scope loss');

  const data = harness();
  const dataOpening = data.shell.open();
  data.socket.emit('connect');
  data.allowed = false;
  data.socket.emit('data', data.packet('CNXN', 0, 0));
  await assertRejected(dataOpening);
  assert.deepEqual(data.writes, ['CNXN'], 'late authorization cannot open a shell');

  const flow = harness();
  const ready = flow.shell.open();
  flow.socket.emit('connect');
  flow.socket.emit('data', flow.packet('CNXN', 0, 0));
  flow.socket.emit('data', flow.packet('OKAY', 2, 1));
  await ready;
  let cancellation = null;
  flow.shell.onError = error => { cancellation = error; };
  flow.shell.write('first report');
  flow.shell.write('queued report');
  assert(flow.shell.pending.length > 0);
  const before = flow.writes.length;
  flow.allowed = false;
  flow.socket.emit('data', flow.packet('OKAY', 2, 1));
  assert.equal(flow.writes.length, before, 'flow-control acknowledgements cannot flush stale input');
  assert.equal(flow.shell.pending.length, 0, 'stale reports are discarded');
  assert(flow.destroyed);

  const command = harness();
  const commandReady = command.shell.open();
  command.socket.emit('connect');
  command.socket.emit('data', command.packet('CNXN', 0, 0));
  command.socket.emit('data', command.packet('OKAY', 2, 1));
  await commandReady;
  command.shell.onError = error => { cancellation = error; };
  cancellation = null;
  command.shell.close();
  assert(cancellation, 'closing a ready shell settles callers waiting for command output');
  console.log('ADB scope, cancellation, and queued-report checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

async function assertRejected(promise) {
  let rejected = false;
  try { await promise; } catch (_) { rejected = true; }
  assert(rejected, 'operation must reject');
}

'use strict';
const assert = require('assert');
const {Mouse} = require('../standalone/hid_mouse');
function testMouse(gain) {
  const events = [];
  return {events, mouse: new Mouse(s => s.trim().split('\n').forEach(line => events.push(JSON.parse(line))), gain)};
}
function delta(events) {
  const signed = b => b > 127 ? b - 256 : b;
  return events.reduce((p, e) => [p[0] + signed(e.report[1]), p[1] + signed(e.report[2])], [0, 0]);
}
{
  const {mouse, events} = testMouse(.6);
  mouse.reset('remote', 500, 500);
  for (let x = 501; x <= 600; x++) mouse.move('remote', x, 500);
  assert(Math.abs(delta(events)[0] - 60) <= 1, 'fine motion must preserve fractional gain');
}
{
  const {mouse, events} = testMouse(.6);
  mouse.reset('remote', 1800, 500);
  mouse.reset('remote', 960, 540);
  assert.equal(events.length, 0, 'hidden LG recenter must not move the Fire cursor');
  mouse.move('remote', 970, 540);
  assert.deepEqual(delta(events), [6, 0]);
}
{
  const {mouse, events} = testMouse(1);
  mouse.reset('remote', 0, 0);
  mouse.move('remote', 500, -300);
  assert.deepEqual(delta(events), [500, -300], 'large deltas must not wrap HID bytes');
  mouse.buttons = 1;
  mouse.report();
  mouse.release();
  assert.equal(events[events.length - 1].report[0], 0, 'leaving HDMI must release mouse buttons');
}
console.log('Pointer checks passed');
for (const direction of [-1, 1]) {
  const {mouse, events} = testMouse(.6);
  mouse.report(direction, 0, 0);
  events.length = 0;
  mouse.keepAlive();
  assert.deepEqual(delta(events), [0, 0], 'keepalive pair must have zero net HID displacement');
  assert.equal(events[0].report[1], (-direction) & 255, 'first pulse must point inward at the last edge');
  assert(events.every(e => e.report[0] === 0 && e.report[3] === 0), 'keepalive must not click or scroll');
  events.length = 0;
  mouse.buttons = 1;
  mouse.keepAlive();
  assert.equal(events.length, 0, 'no synthetic motion during a drag');
}

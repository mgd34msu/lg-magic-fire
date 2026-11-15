'use strict';
const assert = require('assert');
const {Mouse} = require('../standalone/hid_mouse');
const {InputRouter} = require('../standalone/input_router');

(async () => {
  const reports = [], keys = [];
  const mouse = new Mouse(line => reports.push(JSON.parse(line)), .6);
  const router = new InputRouter(mouse, async (key, value) => keys.push([key, value]),
    async code => keys.push(['media', code]), 'com.webos.app.hdmi3');
  await router.handle({kind: 'device', device: 'remote', name: 'LGE M-RCU - Builtin [0]',
    axes: {0: [960], 1: [540]}});
  const press = code => ({kind: 'event', device: 'remote', type: 1, code, value: 1, active: true});
  for (const app of ['com.webos.app.hdmi1', 'example.custom.home', 'LG-UI:inputPicker', null]) {
    await router.handle({kind: 'foreground', app, active: true});
    await router.handle(press(412));
    await router.handle(press(103));
    await router.handle(press(272));
  }
  assert.equal(reports.length, 0, 'no mouse forwarding outside HDMI 3');
  assert.equal(keys.length, 0, 'no key forwarding outside HDMI 3');
  await router.handle({kind: 'foreground', app: 'com.webos.app.hdmi3', active: true});
  for (const code of [773, 241, 114, 115, 113, 1037, 1038]) await router.handle(press(code));
  assert.equal(reports.length, 0, 'native LG buttons never affect the Fire mouse');
  assert.equal(keys.length, 0, 'Home/Input/volume/app keys never go to Fire TV');
  await router.handle(press(412));
  assert.deepEqual(keys, [['back', 1]], 'MR20 Back must use actual code 412');
  await router.handle(press(103));
  await router.handle(press(272));
  await router.handle({kind: 'foreground', app: 'com.webos.app.hdmi2', active: false});
  assert.equal(router.active, false);
  assert.equal(mouse.buttons, 0, 'leaving Fire TV releases click');
  assert(keys.some(k => k[0] === 'dpad_up' && k[1] === 0), 'leaving Fire TV releases held navigation');
  const count = keys.length;
  await router.handle(press(412));
  assert.equal(keys.length, count, 'stale queued Fire events must not leak onto another input');
  for (let input = 1; input <= 4; input++) {
    const calls = [];
    const scoped = new InputRouter(mouse, async key => calls.push(key), async () => {}, 'com.webos.app.hdmi' + input);
    await scoped.handle({kind: 'device', device: 'remote', name: 'LGE M-RCU', axes: {0: [0], 1: [0]}});
    for (let candidate = 1; candidate <= 4; candidate++) {
      await scoped.handle({kind: 'foreground', app: 'com.webos.app.hdmi' + candidate, active: true});
      await scoped.handle(press(412));
    }
    assert.deepEqual(calls, ['back'], 'only the configured HDMI may forward buttons');
  }
  console.log('HDMI scope and native-button routing checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

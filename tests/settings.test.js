'use strict';
const assert = require('assert');
const {validateSettings, targetApp} = require('../standalone/settings');
const base = {tv_host: 'tv.example', fire_tv_host: 'fire.example'};
assert.equal(validateSettings(base).cursor_idle_seconds, 5);
for (let input = 1; input <= 4; input++)
  assert.equal(targetApp(validateSettings(Object.assign({}, base, {hdmi_input: input}))), 'com.webos.app.hdmi' + input);
for (const invalid of [{hdmi_input: 0}, {hdmi_input: 2.5}, {hdmi_input: true},
  {pointer_gain: NaN}, {pointer_gain: 0}, {cursor_idle_seconds: 0}, {adb_port: 65536}, {typo: 1}])
  assert.throws(() => validateSettings(Object.assign({}, base, invalid)));
console.log('Settings validation checks passed');

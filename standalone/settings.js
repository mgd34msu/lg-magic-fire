'use strict';
const fs = require('fs');
const defaults = {hdmi_input: 3, pointer_gain: .6, adb_port: 5555, cursor_idle_seconds: 5};
const fields = ['tv_host', 'fire_tv_host'].concat(Object.keys(defaults));

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be a JSON object');
  for (const key of Object.keys(value)) {
    if (fields.indexOf(key) === -1) throw new Error('Unknown setting: ' + key);
  }
  const result = Object.assign({}, defaults, value);
  for (const key of ['tv_host', 'fire_tv_host']) {
    if (typeof result[key] !== 'string' || !/^[A-Za-z0-9_.:%-]+$/.test(result[key]))
      throw new Error(key + ' must be a host name or IP address, without a URL or port');
    if (result[key].indexOf(':') !== -1 && result[key].split(':').length < 3)
      throw new Error(key + ' must not contain a port; use adb_port for ADB');
  }
  for (const item of [['hdmi_input', 1, 4], ['adb_port', 1, 65535],
    ['pointer_gain', .1, 2], ['cursor_idle_seconds', 1, 3600]]) {
    const key = item[0], number = result[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < item[1] || number > item[2])
      throw new Error(key + ' must be between ' + item[1] + ' and ' + item[2]);
    if ((key === 'hdmi_input' || key === 'adb_port') && !Number.isInteger(number))
      throw new Error(key + ' must be a whole number');
  }
  return result;
}

function loadSettings(file) {
  return validateSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
}
const targetApp = settings => 'com.webos.app.hdmi' + settings.hdmi_input;
module.exports = {validateSettings, loadSettings, targetApp};

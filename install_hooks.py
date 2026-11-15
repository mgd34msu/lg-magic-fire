#!/usr/bin/env python
"""Restore mappings changed by the earlier prototype; the bridge uses no hooks."""
from __future__ import print_function
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
TARGET = '/home/root/.config/lginputhook/keybinds.json'
BACKUP = os.path.join(BASE, 'keybinds.before.json')
KEYS = ('773', '1037', '1038')


def write_json(path, value):
    temp = path + '.magic-fire.tmp'
    with open(temp, 'w') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')
    os.chmod(temp, 0o600)
    os.rename(temp, path)


def owned(key):
    return {'action': 'exec', 'command': 'python ' + BASE + '/button_action.py ' + key}


def main():
    if sys.argv[1:] != ['remove']:
        raise RuntimeError('Only restoration is supported: install_hooks.py remove')
    with open(TARGET) as f:
        current = json.load(f)
    original = dict(current)
    if not os.path.exists(BACKUP):
        print('No prototype mapping backup; native mappings unchanged')
        return
    with open(BACKUP) as f:
        before = json.load(f)
    for key in KEYS:
        if current.get(key) != owned(key):
            continue
        if key in before:
            current[key] = before[key]
        else:
            current.pop(key, None)
    if current != original:
        write_json(TARGET, current)
    print('Original LG button mappings retained')


if __name__ == '__main__':
    main()

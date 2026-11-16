#!/usr/bin/env python3
"""Install/update the standalone bridge using already-authorized SSH and ADB keys."""
import io
import argparse
import json
from pathlib import Path
import subprocess
import tarfile
from magic_fire import TV, ROOT
from bridge_settings import load_settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test', action='store_true', help='Run without enabling startup at TV boot')
    parser.add_argument('--settings', help='Path to settings.json')
    parser.add_argument('--dry-run', action='store_true', help='Validate settings and print the plan without connecting')
    args = parser.parse_args()
    settings = load_settings(args.settings)
    if args.dry_run:
        print(json.dumps({'settings': settings, 'enable_boot_startup': not args.test}, indent=2))
        return
    tv = TV(settings['tv_host'])
    state = json.loads((ROOT / '.state/firetv.json').read_text())
    for required in (ROOT / '.state/tv-adbkey', ROOT / '.state/tv-adbkey.pub',
                     ROOT / 'cursor/cursor-visibility.jar',
                     ROOT / 'standalone/node_modules/ws/package.json'):
        if not required.exists():
            raise RuntimeError('Missing deployment input: ' + str(required))
    if state.get('host') != settings['fire_tv_host']:
        raise RuntimeError('Credentials belong to a different Fire TV; run magic_fire.py setup --pair')
    host = settings['fire_tv_host']
    serial = '%s:%d' % ('[' + host + ']' if ':' in host else host, settings['adb_port'])
    subprocess.run(['adb', 'connect', serial], check=True)
    subprocess.run(['adb', '-s', serial, 'push', str(ROOT / 'cursor/cursor-visibility.jar'),
                    '/data/local/tmp/lg-magic-fire-cursor.jar'], check=True)
    buffer = io.BytesIO()

    def metadata(item):
        item.uid = item.gid = 0
        item.uname = item.gname = 'root'
        item.mtime = 1600000000
        item.mode &= 0o700
        if item.isfile():
            item.mode = 0o600
        return item

    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name in ('bridge.js', 'adb.js', 'hid_mouse.js', 'input_router.js', 'cursor_idle.js', 'scope.js', 'settings.js', 'service.sh', 'package.json',
                     'package-lock.json', 'node_modules'):
            archive.add(ROOT / 'standalone' / name, arcname=name, filter=metadata)
        for name in ('tv_agent.py', 'tv_reader.py', 'tv_control.py', 'pointer_source.py', 'bridge_settings.py', 'install_hooks.py'):
            archive.add(ROOT / name, arcname=name, filter=metadata)
        for local, remote in (('tv-adbkey', 'adbkey'), ('tv-adbkey.pub', 'adbkey.pub')):
            archive.add(ROOT / '.state' / local, arcname=remote, filter=metadata)
        data = json.dumps({'client_token': state['client_token']}).encode()
        item = tarfile.TarInfo('config.json')
        item.size = len(data)
        metadata(item)
        archive.addfile(item, io.BytesIO(data))
        public = json.dumps(settings, indent=2).encode()
        item = tarfile.TarInfo('settings.json')
        item.size = len(public)
        metadata(item)
        archive.addfile(item, io.BytesIO(public))
    subprocess.run(tv.ssh + [
        'set -e; umask 077; '
        'if [ -f /media/developer/magic-fire/service.sh ]; then '
        'sh /media/developer/magic-fire/service.sh stop; fi; '
        'mkdir -p /media/developer/magic-fire; '
        'tar -xf - -C /media/developer/magic-fire; '
        'chmod 700 /media/developer/magic-fire/service.sh; '
        'node --check /media/developer/magic-fire/bridge.js; '
        'node --check /media/developer/magic-fire/adb.js'
    ], input=buffer.getvalue(), check=True)
    setup = '''
import os,sys
sys.path.insert(0,'/media/developer/magic-fire')
# Python 2 validates .pyc files by mtime. Deployment timestamps are normalized
# for the TV's clock, so remove older caches before importing updated modules.
for name in ('tv_agent.pyc','tv_reader.pyc','tv_control.pyc','pointer_source.pyc','bridge_settings.pyc','install_hooks.pyc','button_action.pyc'):
 cache='/media/developer/magic-fire/'+name
 if os.path.exists(cache): os.unlink(cache)
import install_hooks
p='/var/lib/webosbrew/init.d/magic-fire'
body='#!/bin/sh\\n/bin/sh /media/developer/magic-fire/service.sh start\\n'
if os.path.exists(p) and open(p).read()!=body:
 raise RuntimeError('An unrelated magic-fire boot script already exists')
if os.path.exists('/media/developer/magic-fire/keybinds.before.json'):
 sys.argv=['install_hooks.py','remove']
 install_hooks.main()
'''
    if args.test:
        setup += "\nif os.path.exists(p): os.unlink(p)\n"
    else:
        setup += "\nwith open(p+'.tmp','w') as f: f.write(body)\nos.chmod(p+'.tmp',0o700)\nos.rename(p+'.tmp',p)\n"
    subprocess.run(tv.ssh + ['python -B -'], input=setup.encode(), check=True)
    subprocess.run(tv.ssh + ['/bin/sh /media/developer/magic-fire/service.sh start'], check=True)
    print('Restored Fire TV mouse bridge on the TV. Boot startup: %s. Log: /tmp/magic-fire.log' %
          ('disabled for testing' if args.test else 'enabled'))


if __name__ == '__main__':
    main()

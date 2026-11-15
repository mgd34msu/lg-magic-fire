#!/usr/bin/env python3
"""Inspect and maintain the passive Magic Remote bridge installed on the TV."""
import argparse
import http.client
import getpass
import io
import json
import os
from pathlib import Path
import shlex
import ssl
import subprocess
import sys
import tarfile
import uuid
from bridge_settings import load_settings, target_app

ROOT = Path(__file__).resolve().parent
TV_AGENT = '/tmp/magic-fire-diagnostics/tv_agent.py'


class TV:
    def __init__(self, host):
        self.ssh = ['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes']
        control = os.environ.get('MAGIC_FIRE_SSH_CONTROL')
        if control:
            self.ssh += ['-S', control]
        self.ssh += ['root@' + host]

    def stage(self, settings=None):
        settings = settings or load_settings()
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            for name in ('tv_agent.py', 'tv_reader.py', 'tv_control.py', 'pointer_source.py', 'bridge_settings.py'):
                archive.add(ROOT / name, arcname=name)
            payload = json.dumps(settings).encode()
            item = tarfile.TarInfo('settings.json')
            item.mode = 0o600
            item.size = len(payload)
            archive.addfile(item, io.BytesIO(payload))
        subprocess.run(self.ssh + [
            'umask 077; mkdir -p /tmp/magic-fire-diagnostics; '
            'tar -xf - -C /tmp/magic-fire-diagnostics'
        ], input=data.getvalue(), check=True)

    def agent(self, action, seconds):
        session = uuid.uuid4().hex
        process = subprocess.Popen(self.ssh + ['exec ' + shlex.join(
            ['python', '-B', '-u', TV_AGENT, action, str(seconds), session])], stdout=subprocess.PIPE)
        process.remote_session = session
        return process

    def stop(self, process):
        if process.poll() is None:
            script = ('import os,sys,signal; s=sys.argv[1]; '
                      'p="/tmp/magic-fire-"+s+".pid"; '
                      'pid=int(open(p).read()) if os.path.exists(p) else 0; '
                      'cmd=open("/proc/%d/cmdline"%pid).read() if pid and os.path.exists("/proc/%d"%pid) else ""; '
                      'os.kill(pid,signal.SIGTERM) if s in cmd else None')
            subprocess.run(self.ssh + [shlex.join(['python', '-c', script, process.remote_session])],
                           timeout=8, check=False)
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=3)


class NativeRemote:
    def __init__(self, state_path, settings):
        state = json.loads(Path(state_path).read_text())
        self.host = settings['fire_tv_host']
        if state.get('host') != self.host:
            raise ValueError('Saved credentials belong to another Fire TV. Use setup --pair.')
        self.token = state['client_token']

    def status(self):
        connection = http.client.HTTPSConnection(self.host, 8080, timeout=5,
                                                 context=ssl._create_unverified_context())
        try:
            connection.request('GET', '/v1/FireTV/status', headers={
                'x-api-key': '0987654321', 'x-client-token': self.token})
            response = connection.getresponse()
            body = response.read(65536)
            if response.status != 200:
                raise RuntimeError('Fire TV status: HTTP %d' % response.status)
            return json.loads(body)
        finally:
            connection.close()


def setup(settings, state_path, pair=False):
    """Provision credentials only when explicitly requested by the installer."""
    state_path = Path(state_path)
    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    keys = ROOT / '.state'
    keys.mkdir(mode=0o700, exist_ok=True)
    key = keys / 'tv-adbkey'
    if not key.exists():
        subprocess.run(['adb', 'keygen', str(key)], check=True, stdout=subprocess.DEVNULL)
    key.chmod(0o600)
    Path(str(key) + '.pub').chmod(0o600)
    if state_path.exists() and not pair:
        state = json.loads(state_path.read_text())
        if state.get('host') != settings['fire_tv_host']:
            raise ValueError('Saved credentials belong to another Fire TV. Use setup --pair.')
        print('Credentials already exist; use setup --pair to pair again.')
        return
    host = settings['fire_tv_host']
    dial = http.client.HTTPConnection(host, 8009, timeout=5)
    try:
        dial.request('POST', '/apps/FireTVRemote')
        response = dial.getresponse()
        response.read(65536)
        if response.status != 201:
            raise RuntimeError('Could not activate Fire TV remote service: HTTP %d' % response.status)
    finally:
        dial.close()

    def request(route, data):
        connection = http.client.HTTPSConnection(host, 8080, timeout=10,
                                                 context=ssl._create_unverified_context())
        try:
            connection.request('POST', route, json.dumps(data), headers={
                'x-api-key': '0987654321', 'Content-Type': 'application/json'})
            response = connection.getresponse()
            body = response.read(65536)
            if response.status != 200:
                raise RuntimeError('Pairing failed: HTTP %d' % response.status)
            return json.loads(body)
        finally:
            connection.close()
    request('/v1/FireTV/pin/display', {'friendlyName': 'LG Magic Fire'})
    pin = getpass.getpass('Enter the PIN displayed on Fire TV: ').strip()
    if not pin.isdigit() or len(pin) != 4:
        raise ValueError('PIN must contain four digits')
    token = request('/v1/FireTV/pin/verify', {'pin': pin}).get('description')
    if not isinstance(token, str) or not token.strip() or token == 'OK':
        raise RuntimeError('Fire TV did not return a pairing credential')
    temporary = state_path.with_suffix('.tmp')
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump({'host': host, 'client_token': token}, output)
        output.write('\n')
    temporary.chmod(0o600)
    temporary.replace(state_path)
    print('Pairing saved privately. During deployment, allow the bridge ADB key on Fire TV.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', help='Path to settings.json')
    parser.add_argument('--tv', help='Override the TV host for this command')
    parser.add_argument('--state', default=str(ROOT / '.state/firetv.json'))
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('status', 'start', 'stop', 'config'):
        commands.add_parser(name)
    provision = commands.add_parser('setup', help='Generate the TV ADB key and pair the Fire TV LAN remote')
    provision.add_argument('--pair', action='store_true', help='Replace saved LAN pairing credentials')
    logs = commands.add_parser('logs')
    logs.add_argument('--lines', type=int, default=30)
    capture = commands.add_parser('capture', help='Read remote events without intercepting any controls')
    capture.add_argument('--seconds', type=float, default=30)
    args = parser.parse_args()
    settings = load_settings(args.settings)
    if args.command == 'config':
        print(json.dumps(dict(settings, target_app=target_app(settings)), indent=2, sort_keys=True))
        return
    if args.command == 'setup':
        setup(settings, args.state, args.pair)
        return
    tv = TV(args.tv or settings['tv_host'])
    if args.command in ('start', 'stop', 'status'):
        result = subprocess.run(tv.ssh + ['/bin/sh /media/developer/magic-fire/service.sh ' + args.command])
        if args.command == 'status':
            print(json.dumps(NativeRemote(args.state, settings).status(), indent=2))
        elif result.returncode:
            raise SystemExit(result.returncode)
    elif args.command == 'logs':
        if not 1 <= args.lines <= 1000:
            raise ValueError('Log line count must be 1 to 1000')
        subprocess.run(tv.ssh + ['tail -n %d /tmp/magic-fire.log' % args.lines], check=True)
    elif args.command == 'capture':
        if not 0 < args.seconds <= 300:
            raise ValueError('Capture duration must be 1 to 300 seconds')
        tv.stage(settings)
        process = tv.agent('capture', args.seconds)
        try:
            for line in process.stdout:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            if process.wait():
                raise RuntimeError('TV capture failed')
        finally:
            tv.stop(process)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Stopped.', file=sys.stderr)
    except Exception as error:
        print('%s: %s' % (type(error).__name__, error), file=sys.stderr)
        raise SystemExit(1)

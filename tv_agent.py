#!/usr/bin/env python
"""TV-side probes. Compatible with the LG's stock Python 2.7; no packages needed."""
from __future__ import print_function

import glob
import json
import os
import select
import signal
import socket
import subprocess
import sys
import time
from bridge_settings import load_settings, target_app, target_input


def status(**fields):
    sys.stderr.write(json.dumps(fields) + '\n')
    sys.stderr.flush()


def emit(**fields):
    print(json.dumps(fields))
    sys.stdout.flush()


def luna(uri, payload, timeout=3):
    # On this firmware, EOF on luna-send's stdin can discard a request.
    p = subprocess.Popen(['luna-send', '-n', '1', 'luna://' + uri,
                          json.dumps(payload)], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    try:
        deadline = time.time() + timeout
        data = b''
        while time.time() < deadline:
            remaining = deadline - time.time()
            if remaining <= 0 or not select.select([p.stdout], [], [], remaining)[0]:
                break
            chunk = os.read(p.stdout.fileno(), 4096)
            if not chunk:
                break
            data += chunk
            try:
                return json.loads(data)
            except ValueError:
                pass
        raise RuntimeError('No complete Luna reply: ' + uri)
    finally:
        if p.poll() is None:
            p.terminate()
        p.wait()


def foreground(settings=None):
    settings = settings or load_settings()
    # webOS can keep reporting the last HDMI app while the panel is off.
    # Unknown/missing power state must never authorize Fire TV traffic.
    power = luna('com.webos.service.tvpower/power/getPowerState', {})
    if power.get('returnValue') is not True or power.get('state') != 'Active':
        return 'LG-power:' + str(power.get('state', 'unknown'))
    expected_app = target_app(settings)
    app = luna('com.webos.applicationManager/getForegroundAppInfo', {}).get('appId')
    if app == expected_app:
        state = luna('com.webos.surfacemanager/getCurrentState', {}).get('currentState')
        if state != 'none':
            return 'LG-UI:' + str(state)
        # The application manager can still report HDMI beneath LG Settings.
        # Release the remote while any TV overlay owns the foreground window.
        windows = luna('com.webos.surfacemanager/getForegroundWindowInfo', {}).get('windows', [])
        for window in windows:
            if window.get('appId') != app:
                return window.get('appId')
        inputs = luna('com.webos.service.eim/getAllInputStatus', {}).get('devices', [])
        if not any(d.get('id') == target_input(settings) and d.get('activate') for d in inputs):
            return 'other-input'
    return app


def guard(pid, seconds):
    """Restore LG voice even if the capturing process crashes or is killed."""
    paused = False
    try:
        with open('/proc/%d/status' % pid) as f:
            text = f.read()
        if '\nState:\tT' not in text:
            os.kill(pid, signal.SIGSTOP)
            paused = True
        print('ready')
        sys.stdout.flush()
        if seconds > 0:
            select.select([sys.stdin], [], [], seconds)
        else:
            # A short renewable lease also restores the assistant when
            # the parent hangs. EOF restores it after a crash or SIGKILL.
            while select.select([sys.stdin], [], [], 8)[0]:
                if not os.read(sys.stdin.fileno(), 64):
                    break
    finally:
        if paused:
            try:
                with open('/proc/%d/comm' % pid) as f:
                    if f.read().strip() == 'voiceconductor':
                        os.kill(pid, signal.SIGCONT)
            except (IOError, OSError):
                pass


def pause_assistant(seconds, required=True):
    for path in glob.glob('/proc/[0-9]*/comm'):
        try:
            with open(path) as f:
                match = f.read().strip() == 'voiceconductor'
            if match:
                pid = int(path.split('/')[2])
                p = subprocess.Popen([sys.executable, __file__, 'guard', str(pid),
                                      str(seconds)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, close_fds=True)
                if not select.select([p.stdout], [], [], 2)[0]:
                    p.stdin.close()
                    raise RuntimeError('LG voice guard did not become ready')
                if p.stdout.readline().strip() != b'ready':
                    raise RuntimeError('LG voice guard failed')
                return p
        except (IOError, OSError):
            continue
    if required:
        raise RuntimeError('LG voiceconductor was not found')
    return None


class Microphone(object):
    def __init__(self):
        self.stream = None
        self.sock = None
        self.started = 0
        self.total = 0

    def open(self):
        self.stream = subprocess.Popen([
            'luna-send', '-i', 'luna://com.webos.service.voiceinput/startStreaming',
            json.dumps({'deviceId': 'remote1', 'deviceType': 'remote',
                        'keyType': 'thinQtv', 'subscribe': True})
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        try:
            if not select.select([self.stream.stdout], [], [], 2)[0]:
                raise RuntimeError('Microphone service timed out')
            reply = json.loads(self.stream.stdout.readline())
            if reply.get('returnValue') is False:
                raise RuntimeError('Microphone refused: ' + str(reply.get('errorCode')))
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(2)
            self.sock.connect(reply.get('socketPath', '/tmp/voiceinput_remote1.soc'))
            self.started = time.time()
            self.total = 0
        except Exception:
            self.close()
            raise

    def close(self):
        if self.sock:
            self.sock.close()
            self.sock = None
        if self.stream:
            self.stream.terminate()
            self.stream.wait()
            self.stream = None


def capture(seconds, bridge=False):
    from tv_reader import capture as passive_capture
    return passive_capture(seconds, bridge)


def terminate(signum, frame):
    raise SystemExit(128 + signum)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    action = sys.argv[1]
    pidfile = '/tmp/magic-fire-' + sys.argv[3] + '.pid' if action != 'guard' and len(sys.argv) == 4 else None
    if pidfile:
        with open(pidfile, 'w') as f:
            f.write(str(os.getpid()))
        os.chmod(pidfile, 0o600)
    try:
        if action == 'guard':
            guard(int(sys.argv[2]), float(sys.argv[3]))
        elif action == 'capture':
            capture(float(sys.argv[2]))
        elif action == 'bridge':
            capture(float(sys.argv[2]), bridge=True)
        else:
            raise SystemExit('Unknown action')
    finally:
        if pidfile:
            os.unlink(pidfile)

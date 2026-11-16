"""Read the Magic Remote only on the user's configured HDMI input."""
from __future__ import print_function
import base64
import fcntl
import glob
import json
import os
import select
import struct
import subprocess
import threading
import time
from tv_agent import Microphone, emit, foreground, luna, pause_assistant
from tv_control import CaptureLease, NativeButtons
from pointer_source import PointerRecenter
from bridge_settings import load_settings, target_app


def capture(seconds, bridge=False):
    settings = load_settings()
    expected_app = target_app(settings)
    fds, axes, cutoff, recentered = {}, {}, {}, {}
    mic = Microphone()
    state = {'active': False, 'until': 0, 'guardian': None,
             'native_ui': False, 'saw_lg_ui': False, 'scope_after': 0}
    snapshot = [(None, 0)]
    stopped = threading.Event()
    lease = CaptureLease([])
    home_log = None
    warps = {}

    def checked(uri, payload):
        if uri.endswith('/setVolume'):
            raise RuntimeError('Absolute volume changes are forbidden in the bridge')
        result = luna(uri, payload)
        if result.get('returnValue') is not True:
            raise RuntimeError('LG native key service rejected ' + uri)
        return result

    def release(reason, inhibit=False):
        # Release before any service call, microphone cleanup, or child wait.
        lease.release()
        state['active'] = False
        if inhibit:
            state['until'] = time.time() + 2
            state['native_ui'] = True
            state['saw_lg_ui'] = False
        emit(kind='foreground', app=reason, active=False)
        if mic.sock:
            mic.close()
            emit(kind='voice-end', reason='LG-control-active')
        guardian = state['guardian']
        if guardian:
            guardian.stdin.close()
            guardian.wait()
            state['guardian'] = None

    def original_home():
        try:
            with open('/home/root/.config/lginputhook/keybinds.json') as f:
                entry = json.load(f).get('773', {})
        except IOError:
            entry = {}
        if entry.get('action') == 'exec':
            p = subprocess.Popen(['/bin/sh', '-c', entry['command']], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
            p.wait()
        else:
            checked('com.webos.service.networkinput/sendSpecialKey', {'rcu': 'true', 'key': 'HOME'})

    native = NativeButtons(checked, lambda: release('LG-controls', True), original_home)

    def observe_scope():
        while not stopped.is_set():
            try:
                app = foreground(settings)
            except Exception:
                app = None
            snapshot[0] = (app, time.time())
            stopped.wait(.2)

    try:
        for path in sorted(glob.glob('/dev/input/event*')):
            fd = None
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                name = fcntl.ioctl(fd, 0x81004506 - 0x100000000, b'\0' * 256).split(b'\0')[0]
                if not isinstance(name, str):
                    name = name.decode('utf-8', 'replace')
                if not name.startswith('LGE M-RCU'):
                    os.close(fd)
                    continue
                fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.FD_CLOEXEC)
                fcntl.ioctl(fd, 0x400445a0, struct.pack('i', 0))
                ranges = {}
                for axis in (0, 1):
                    ranges[axis] = struct.unpack('iiiiii', fcntl.ioctl(
                        fd, 0x80184540 + axis - 0x100000000, b'\0' * 24))
                axes[fd] = [ranges[0][0], ranges[1][0]]
                fds[fd] = path
                emit(kind='device', device=path, name=name, axes=ranges)
            except (IOError, OSError):
                if fd is not None:
                    os.close(fd)
        if not fds:
            raise RuntimeError('No Magic Remote input devices found')
        lease.devices = list(fds)
        if bridge:
            try:
                home_log = open('/tmp/lginput-hook-lginput2.log')
                home_log.seek(0, 2)
            except IOError:
                pass
        observer = threading.Thread(target=observe_scope)
        observer.daemon = True
        observer.start()
        deadline = time.time() + seconds if seconds else float('inf')
        heartbeat = 0
        fmt = 'llHHi'
        size = struct.calcsize(fmt)
        while time.time() < deadline:
            app, checked_at = snapshot[0]
            if state['native_ui']:
                if app and app != expected_app:
                    state['saw_lg_ui'] = True
                elif app == expected_app and state['saw_lg_ui']:
                    state['native_ui'] = False
            desired = (app == expected_app and time.time() - checked_at < 1.5
                       and checked_at >= state['scope_after'] and time.time() >= state['until']
                       and not state['native_ui'])
            if desired != state['active']:
                if desired:
                    if bridge:
                        lease.acquire()
                        try:
                            # Some power transitions leave voiceconductor absent.
                            # Pointer/buttons must not enter a restart loop for it.
                            state['guardian'] = pause_assistant(0, required=False)
                        except Exception:
                            lease.release()
                            raise
                    state['active'] = True
                    warps.clear()
                    if home_log:
                        home_log.seek(0, 2)
                    emit(kind='foreground', app=app, active=True)
                    for fd in fds:
                        axes[fd] = [struct.unpack('iiiiii', fcntl.ioctl(
                            fd, 0x80184540 + a - 0x100000000, b'\0' * 24))[0] for a in (0, 1)]
                        emit(kind='pointer-reset', device=fds[fd], x=axes[fd][0], y=axes[fd][1])
                else:
                    release(app)
            if time.time() >= heartbeat:
                guardian = state['guardian']
                if guardian:
                    if guardian.poll() is not None:
                        raise RuntimeError('LG voice guard exited')
                    guardian.stdin.write(b'.')
                    guardian.stdin.flush()
                emit(kind='foreground', app=app, active=state['active'])
                heartbeat = time.time() + .5
            watch = list(fds) + ([mic.sock] if mic.sock else [])
            ready, _, _ = select.select(watch, [], [], .02)
            if mic.sock and mic.sock in ready:
                ready.remove(mic.sock)
                audio = mic.sock.recv(3200)
                if audio:
                    mic.total += len(audio)
                    emit(kind='voice-audio', pcm=base64.b64encode(audio).decode('ascii'))
                else:
                    mic.close()
                    emit(kind='voice-end', reason='microphone-closed')
            for fd in ready:
                data = os.read(fd, size * 64)
                captured = fd in lease.owned
                moved = False
                for i in range(0, len(data), size):
                    sec, usec, typ, code, value = struct.unpack(fmt, data[i:i + size])
                    stamp = sec + usec / 1000000.0
                    if (not captured and state['native_ui'] and typ == 1 and value == 1
                            and code in (412, 158, 28, 352, 272, 241)):
                        # LG receives this event directly. Wait for a fresh
                        # post-action scope check before any recapture.
                        state['native_ui'] = False
                        state['until'] = time.time() + .25
                        state['scope_after'] = state['until']
                    if typ == 3 and code in (0, 1):
                        if stamp <= cutoff.get(fd, 0):
                            continue
                        if fd in warps and state['active']:
                            pending_warp = warps[fd]
                            confirmed = pending_warp.sample(code, value, time.time())
                            if confirmed is not None:
                                del warps[fd]
                                axes[fd] = list(confirmed)
                                baseline = confirmed if pending_warp.rebased else (960, 540)
                                emit(kind='pointer-reset', device=fds[fd], x=baseline[0], y=baseline[1])
                                for a in (0, 1):
                                    emit(kind='event', device=fds[fd], type=3, code=a,
                                         value=confirmed[a], active=True)
                                emit(kind='event', device=fds[fd], type=0, code=0, value=0, active=True)
                            continue
                        axes[fd][code] = value
                        moved = True
                    if bridge and captured and typ == 1:
                        if native.handle(code, value):
                            continue
                    emit(kind='event', device=fds[fd], type=typ, code=code,
                         value=value, active=state['active'], time=stamp)
                    if bridge and state['active'] and typ == 1 and code == 428:
                        if value == 1 and not mic.sock:
                            try:
                                if state['guardian'] is None:
                                    state['guardian'] = pause_assistant(0, required=False)
                                emit(kind='voice-start')
                                mic.open()
                            except Exception as error:
                                emit(kind='voice-end', reason=str(error))
                        elif value == 0 and mic.sock:
                            while select.select([mic.sock], [], [], 0)[0]:
                                audio = mic.sock.recv(3200)
                                if not audio:
                                    break
                                mic.total += len(audio)
                                emit(kind='voice-audio', pcm=base64.b64encode(audio).decode('ascii'))
                            total = mic.total
                            mic.close()
                            emit(kind='voice-end', reason='button-released', pcm_bytes=total)
                if bridge and state['active'] and moved:
                    x, y = axes[fd]
                    if (x < 350 or x > 1570 or y < 200 or y > 880) and time.time() - recentered.get(fd, 0) > .3:
                        recentered[fd] = time.time()
                        result = luna('com.webos.service.mrcu/cursor/setPosition', {'posX': 960, 'posY': 540})
                        if result.get('returnValue'):
                            cutoff[fd] = time.time()
                            warps[fd] = PointerRecenter(axes[fd], time.time())
            # Observe the preexisting Home hook; never modify its mapping.
            if home_log and state['active']:
                if 'state=1 uinput_code=773' in home_log.read(8192):
                    release('LG-Home', True)
            if mic.sock and time.time() - mic.started > 20:
                mic.close()
                emit(kind='voice-end', reason='maximum-duration')
    finally:
        stopped.set()
        try:
            lease.release()
        finally:
            for fd in fds:
                os.close(fd)
        if home_log:
            home_log.close()
        mic.close()
        guardian = state['guardian']
        if guardian:
            guardian.stdin.close()
            guardian.wait()

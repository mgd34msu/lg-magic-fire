"""HDMI-scoped capture and LG key routing, independent of pointer translation."""
from __future__ import print_function
import fcntl

GRAB = 0x40044590
FIRE_KEYS = frozenset((28, 103, 108, 105, 106, 158, 352, 412, 272, 428, 164,
                       119, 165, 163, 168, 166, 207, 208))


class CaptureLease(object):
    def __init__(self, devices, ioctl=fcntl.ioctl):
        self.devices = list(devices)
        self.ioctl = ioctl
        self.owned = set()

    def acquire(self):
        try:
            for fd in self.devices:
                if fd not in self.owned:
                    self.ioctl(fd, GRAB, 1)
                    self.owned.add(fd)
        except Exception:
            self.release()
            raise

    def release(self):
        errors = []
        for fd in list(self.owned):
            try:
                self.ioctl(fd, GRAB, 0)
                self.owned.remove(fd)
            except Exception as error:
                errors.append(error)
        if errors:
            raise errors[0]


class NativeButtons(object):
    def __init__(self, call, leave_fire, home):
        self.call = call
        self.leave_fire = leave_fire
        self.home = home

    def handle(self, code, value):
        if code in FIRE_KEYS or code in (1198, 1199):
            return False
        if value not in (1, 2):
            return True
        # Volume must work without navigating away from the playing video.
        if code in (114, 115):
            method = 'volumeUp' if code == 115 else 'volumeDown'
            self.call('com.webos.audio/' + method, {})
            return True
        if code == 113:
            self.call('com.webos.service.networkinput/sendSpecialKey', {'rcu': 'true', 'key': 'MUTE'})
            return True
        # Release BEFORE asking LG to open any UI. Its D-pad and Back must be
        # delivered directly to LG for the entire time that UI is present.
        self.leave_fire()
        if code == 773:
            self.home()
        elif code == 241:
            try:
                self.call('com.webos.surfacemanager/showInputPicker', {})
            except RuntimeError:
                self.call('com.webos.applicationManager/launch', {'id': 'com.webos.app.inputcommon'})
        elif code in (1037, 1038):
            self.call('com.webos.applicationManager/launch',
                      {'id': 'netflix' if code == 1037 else 'amazon'})
        elif 0 <= code <= 766:
            self.call('com.webos.service.networkinput/test/sendKeyCode', {'keyCode': code})
        # Unmapped vendor notifications must not terminate the input reader.
        # Capture is already released above so native LG control stays usable.
        return True

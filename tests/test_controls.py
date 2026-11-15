import unittest
from tv_control import CaptureLease, NativeButtons, FIRE_KEYS


class NativeControlTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.native = NativeButtons(
            lambda uri, payload: self.calls.append((uri, payload)),
            lambda: self.calls.append('release'),
            lambda: self.calls.append('original-home'))

    def test_home_preserves_original_action_and_releases_first(self):
        self.native.handle(773, 1)
        self.assertEqual(self.calls, ['release', 'original-home'])

    def test_input_releases_before_opening_lg_picker(self):
        self.native.handle(241, 1)
        self.assertEqual(self.calls, ['release', ('com.webos.surfacemanager/showInputPicker', {})])

    def test_volume_uses_lg_without_fire_or_input_changes(self):
        for key in (115, 114):
            self.native.handle(key, 1)
            self.native.handle(key, 0)
        self.assertEqual(self.calls, [('com.webos.audio/volumeUp', {}), ('com.webos.audio/volumeDown', {})])

    def test_volume_repeat_is_relative_and_release_does_nothing(self):
        for value in (1, 2, 2, 0):
            self.native.handle(114, value)
        self.assertEqual(self.calls, [('com.webos.audio/volumeDown', {})] * 3)

    def test_input_fallback_still_releases_before_lg_ui(self):
        def call(uri, payload):
            self.calls.append((uri, payload))
            if uri.endswith('showInputPicker'):
                raise RuntimeError('Unavailable')
        self.native.call = call
        self.native.handle(241, 1)
        self.assertEqual(self.calls[0], 'release')
        self.assertEqual(self.calls[-1], ('com.webos.applicationManager/launch', {'id': 'com.webos.app.inputcommon'}))

    def test_back_uses_actual_remote_code_and_stays_with_fire(self):
        self.assertIn(412, FIRE_KEYS)
        self.assertFalse(self.native.handle(412, 1))
        self.assertEqual(self.calls, [])

    def test_unknown_key_restores_lg_without_crashing(self):
        self.assertTrue(self.native.handle(1500, 1))
        self.assertEqual(self.calls, ['release'])

    def test_pointer_vendor_notifications_do_not_release_or_crash(self):
        for code in (1198, 1199):
            for value in (1, 0):
                self.assertFalse(self.native.handle(code, value))
        self.assertEqual(self.calls, [])

    def test_partial_acquisition_rolls_back(self):
        actions = []
        def ioctl(fd, request, value):
            actions.append((fd, value))
            if fd == 2 and value:
                raise OSError('busy')
        lease = CaptureLease([1, 2], ioctl)
        with self.assertRaises(OSError):
            lease.acquire()
        self.assertEqual(actions, [(1, 1), (2, 1), (1, 0)])
        self.assertFalse(lease.owned)

    def test_release_attempts_all_devices_even_if_one_fails(self):
        released = []
        def ioctl(fd, request, value):
            if not value:
                released.append(fd)
                if fd == 1:
                    raise OSError('closed')
        lease = CaptureLease([1, 2], ioctl)
        lease.acquire()
        with self.assertRaises(OSError):
            lease.release()
        self.assertEqual(set(released), {1, 2})


if __name__ == '__main__':
    unittest.main()

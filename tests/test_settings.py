import unittest
from unittest.mock import patch
from bridge_settings import validate_settings, target_app, target_input
from tv_agent import foreground


class SettingsTests(unittest.TestCase):
    def settings(self, **kwargs):
        return validate_settings(dict(tv_host='tv.example', fire_tv_host='fire.example', **kwargs))

    def test_all_inputs_require_matching_physical_input(self):
        for number in range(1, 5):
            settings = self.settings(hdmi_input=number)
            app = target_app(settings)
            replies = [{'appId': app}, {'currentState': 'none'}, {'windows': [{'appId': app}]},
                       {'devices': [{'id': target_input(settings), 'activate': True}]}]
            with patch('tv_agent.luna', side_effect=replies):
                self.assertEqual(foreground(settings), app)
            replies[-1] = {'devices': [{'id': 'HDMI_%d' % (number % 4 + 1), 'activate': True}]}
            with patch('tv_agent.luna', side_effect=replies):
                self.assertEqual(foreground(settings), 'other-input')

    def test_defaults_and_rejections(self):
        self.assertEqual(self.settings()['cursor_idle_seconds'], 5)
        for key, value in [('hdmi_input', 0), ('hdmi_input', 2.5), ('hdmi_input', True),
                           ('pointer_gain', float('nan')), ('pointer_gain', 0),
                           ('cursor_idle_seconds', 0), ('adb_port', 65536), ('typo', 1)]:
            with self.assertRaises(ValueError):
                self.settings(**{key: value})

    def test_lg_overlay_releases_scope(self):
        settings = self.settings(hdmi_input=2)
        with patch('tv_agent.luna', side_effect=[{'appId': target_app(settings)},
                                                {'currentState': 'settings'}]):
            self.assertEqual(foreground(settings), 'LG-UI:settings')


if __name__ == '__main__':
    unittest.main()

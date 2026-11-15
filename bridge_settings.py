"""Public settings shared by development tools and the stock Python 2 TV reader."""
import json
import math
import os
import re

DEFAULTS = {'hdmi_input': 3, 'pointer_gain': .6, 'adb_port': 5555, 'cursor_idle_seconds': 5}
FIELDS = frozenset(('tv_host', 'fire_tv_host')) | frozenset(DEFAULTS)
try:
    STRING = (basestring,)
except NameError:
    STRING = (str,)


def validate_settings(value):
    if not isinstance(value, dict):
        raise ValueError('Settings must be a JSON object')
    unknown = set(value) - FIELDS
    if unknown:
        raise ValueError('Unknown setting: ' + ', '.join(sorted(unknown)))
    result = dict(DEFAULTS)
    result.update(value)
    for key in ('tv_host', 'fire_tv_host'):
        host = result.get(key)
        if not isinstance(host, STRING) or not re.match(r'^[A-Za-z0-9_.:%-]+$', host):
            raise ValueError(key + ' must be a host name or IP address, without a URL or port')
        if ':' in host and host.count(':') < 2:
            raise ValueError(key + ' must not contain a port; use adb_port for ADB')
    for key, minimum, maximum in (('hdmi_input', 1, 4), ('adb_port', 1, 65535),
                                   ('pointer_gain', .1, 2), ('cursor_idle_seconds', 1, 3600)):
        number = result[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            raise ValueError(key + ' must be a number')
        if math.isnan(number) or math.isinf(number) or not minimum <= number <= maximum:
            raise ValueError('%s must be between %s and %s' % (key, minimum, maximum))
        if key in ('hdmi_input', 'adb_port'):
            if int(number) != number:
                raise ValueError(key + ' must be a whole number')
            result[key] = int(number)
    return result


def load_settings(path=None):
    filename = path or os.environ.get('MAGIC_FIRE_SETTINGS') or os.path.join(os.path.dirname(__file__), 'settings.json')
    try:
        with open(filename) as source:
            value = json.load(source)
    except IOError:
        raise ValueError('Settings file missing: %s. Copy settings.example.json to settings.json and edit it.' % filename)
    except ValueError:
        raise ValueError('Settings file contains invalid JSON: ' + filename)
    return validate_settings(value)


def target_app(settings):
    return 'com.webos.app.hdmi%d' % settings['hdmi_input']


def target_input(settings):
    return 'HDMI_%d' % settings['hdmi_input']

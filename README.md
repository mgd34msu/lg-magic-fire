# lg-magic-fire

Use an LG Magic Remote's pointer, wheel, buttons, and microphone with a Fire TV through a rooted LG webOS TV. The bridge runs on the TV; a computer is needed for installation and maintenance only. Fire TV needs network ADB, not root.

**Experimental and hardware-specific.** Developed on an LG 86NANO90UNA (webOS 5.6.2, MR20 remote) and Fire TV Cube AFTGAZL (Fire OS 7.7.1.7 / Android 9). Other models and firmware need verification. This project does not root either device.

## Behavior

| Control | On the configured Fire TV HDMI input |
| --- | --- |
| Pointer | Native Fire TV mouse cursor, configurable movement gain |
| Wheel / pointer click | Mouse scroll / left click |
| D-pad / OK / Back | Fire TV navigation / select / back |
| Microphone | Hold to speak to Alexa; release to submit, maximum 20 seconds |
| Home | LG Home, preserving an existing custom LG input-hook action |
| Input | LG input picker |
| Volume / mute | LG TV controls |

Forwarding requires the configured HDMI app and physical input to be active, with no LG foreground menu. Leaving that input releases captured devices and held Fire TV buttons. LG menus retain LG navigation. Application support for mouse input varies; some interfaces expect D-pad navigation.

The cursor hides after **5 seconds without pointer activity** and returns on movement, wheel, or mouse click. This timer does not disconnect the remote. The remote provides motion coordinates, not a reliable measurement of whether it is aimed at the screen: moving it while pointed away can still move the cursor and reset the timer.

## Requirements

- Rooted webOS TV with root SSH, Python 2.7, Node 8.12+, `luna-send`, and readable LGE M-RCU evdev devices.
- Fire TV on the same trusted network with ADB debugging enabled, `/system/bin/hid`, and `app_process`. The cursor helper targets Android 9 / API 28+.
- Installation computer with Python 3.9+, Node/npm, OpenSSH, and Android platform tools (`adb`). Python uses only the standard library.
- Root SSH authentication configured for noninteractive commands, or a password-authenticated SSH control connection as shown below.

The bridge uses undocumented LG services and Fire TV LAN protocols, which may change with firmware. Use a private LAN; do not expose these services to the internet.

## Install

```sh
git clone https://github.com/mgd34msu/lg-magic-fire.git
cd lg-magic-fire
npm ci --prefix standalone --ignore-scripts
cp settings.example.json settings.json
```

Edit `settings.json` with your device addresses and the HDMI port connected to Fire TV. Validate without contacting either device:

```sh
python3 magic_fire.py config
python3 deploy.py --test --dry-run
```

Ensure `ssh root@YOUR_TV_IP` works. For password authentication instead of an installed SSH key, establish an SSH control connection:

```sh
export MAGIC_FIRE_SSH_CONTROL="${TMPDIR:-/tmp}/lg-magic-fire-ssh"
ssh -M -S "$MAGIC_FIRE_SSH_CONTROL" -o ControlPersist=600 -fnNT root@YOUR_TV_IP
```

Pair the LAN remote service. This displays a PIN on Fire TV and prompts for it in the terminal. Credentials and a dedicated bridge ADB key are saved privately in `.state/`:

```sh
python3 magic_fire.py setup
adb connect YOUR_FIRE_TV_IP:5555
python3 deploy.py --test
```

Accept Fire TV's ADB authorization prompts, including the dedicated TV bridge key when it first connects. Select “Always allow” for unattended reconnection. The supervisor retries if initial authorization is delayed. Use the configured ADB port if it differs from 5555.

`--test` runs the bridge with boot startup disabled. Check pointer, click, wheel, Back, and hold-to-talk manually. Check that Home and Input return to LG navigation and controls work on other inputs. Deployment does not send test presses, switch inputs, or adjust volume.

When satisfied, enable boot startup:

```sh
python3 deploy.py
```

This installs `/var/lib/webosbrew/init.d/magic-fire`, requiring a compatible webOSbrew boot-hook directory. Use `--test` if your rooting setup does not provide it. No computer or persistent installation SSH session is needed at runtime.

## Settings

`settings.json` is excluded from Git. Start with `settings.example.json`:

```json
{
  "tv_host": "192.168.1.50",
  "fire_tv_host": "192.168.1.51",
  "hdmi_input": 3,
  "pointer_gain": 0.6,
  "adb_port": 5555,
  "cursor_idle_seconds": 5
}
```

| Setting | Meaning / range |
| --- | --- |
| `tv_host` | Root SSH host name or IP of LG TV |
| `fire_tv_host` | Fire TV host name or IP; pair again after changing it |
| `hdmi_input` | Fire TV's physical HDMI port, 1–4 |
| `pointer_gain` | Movement multiplier, 0.1–2; lower is slower; default 0.6 |
| `adb_port` | Fire TV ADB port, 1–65535; default 5555 |
| `cursor_idle_seconds` | Inactivity before hiding, 1–3600 seconds; default 5 |

Both runtimes validate settings and reject unknown keys. Changes require deployment or restart; settings are not hot-reloaded. Edit the local file, then run `python3 deploy.py --test` to apply. Use `--settings PATH` on deployment and **before** the subcommand on `magic_fire.py`, or set `MAGIC_FIRE_SETTINGS`.

Alternatively, edit `/media/developer/magic-fire/settings.json` on the TV and restart its service. A later deployment replaces it with the local settings. Private credentials remain separate in `config.json`.

## Maintenance and recovery

```sh
python3 magic_fire.py status
python3 magic_fire.py logs --lines 50
python3 magic_fire.py stop
python3 magic_fire.py start
```

Runtime: `/media/developer/magic-fire/`. Log: `/tmp/magic-fire.log`. Stopping releases input capture and restores the LG voice handler. A supervisor retries after failures. An independent voice guardian also restores LG voice if its parent dies or stops renewing its lease.

To disable the bridge including startup, run on the TV:

```sh
sh /media/developer/magic-fire/service.sh stop
rm -f /var/lib/webosbrew/init.d/magic-fire
```

Runtime files remain available for inspection. Remove the runtime directory only after stopping for a complete uninstall. Deployment installs no new `lginputhook` mappings; `install_hooks.py` only restores exact entries owned by the earlier prototype when its backup exists.

For dropouts, inspect the log for ADB disconnects, authorization errors, or repeated agent exits. Verify the selected HDMI and close LG menus. Use `python3 magic_fire.py setup --pair` to replace invalid LAN credentials. DHCP reservations help avoid address changes; if Fire TV's address changes, edit settings and pair again.

`python3 magic_fire.py capture --seconds 30` is a passive diagnostic reader that does not intercept controls. Its output includes physical remote events; review it before sharing.

## How it works

The TV reader captures LGE M-RCU devices only within the HDMI scope. Capture suppresses the LG pointer. Relative mouse reports travel directly over ADB to Android's `hid` utility, producing Fire TV's native cursor. Hidden LG coordinates are recentered near their bounds to avoid invisible edges. Delayed reports are filtered; failed recenters rebase without restarting the bridge.

`cursor/PointerVisibility.java` changes only the system mouse icon. Android's native fade timer can be shorter than a configured timeout. To keep it awake, the bridge sends adjacent one-unit inward/back HID reports every two seconds while the cursor should be visible. They have zero net HID displacement, never click or scroll, and are skipped during drags. Android acceleration and app hover handling can still make this workaround observable. Only real remote activity extends the configured idle timer.

Navigation and voice use Fire TV's paired LAN remote service. Microphone audio is forwarded only during a scoped press-and-hold and is not saved. Capture descriptors are close-on-exec and released before service cleanup. LG volume actions are relative and only follow physical presses.

## Development

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm test --prefix standalone
node --check standalone/bridge.js
```

Tests use mocks and fixtures without device connections. They cover HDMI selection, native LG routing, cleanup, pointer scaling/recentering, settings, and idle visibility. They do not establish compatibility with every device or app. See [CONTRIBUTING.md](CONTRIBUTING.md).

The prebuilt `cursor/cursor-visibility.jar` is included alongside its source, so installation needs no Android SDK. Rebuild with a JDK and SDK platform/build tools 35:

```sh
ANDROID_SDK_ROOT=/path/to/android-sdk sh cursor/build.sh
```

Runtime JavaScript stays compatible with Node 8.12; TV Python with Python 2.7. Installation tools use modern Python/Node.

## References and license

- [Android ADB protocol](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt)
- [Amazon ADB setup](https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html)
- [LG Magic Remote](https://webostv.developer.lge.com/develop/guides/magic-remote)
- [LibreControl Fire TV protocol research](https://github.com/LibreControl/fire-tv/blob/main/docs/protocol.md)
- [LG microphone research](https://github.com/lasharor/cleanyourtv-WebOS/blob/main/helper/voice.js)

[MIT](LICENSE). The pinned `ws` dependency has its own MIT license. No LG or Amazon proprietary binaries, private keys, pairing tokens, or capture logs are included.

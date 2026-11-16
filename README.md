# lg-magic-fire

Use an **LG Magic Remote's pointer, wheel, buttons, and microphone with a Fire TV**, through a rooted LG webOS TV. The bridge runs on the TV and creates a native mouse on Fire TV. A computer is needed for installation and maintenance only; Fire TV needs network ADB access, but does not need root.

**Experimental and hardware-specific.** Development and hardware testing used an LG 86NANO90UNA running webOS 5.6.2 with an MR20 remote, and a Fire TV Cube AFTGAZL running Fire OS 7.7.1.7 / Android 9. Other models and firmware need verification. This project does not root either device.

## Contents

- [Controls and everyday behavior](#controls-and-everyday-behavior)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands and maintenance](#commands-and-maintenance)
- [Troubleshooting](#troubleshooting)
- [Disable or uninstall](#disable-or-uninstall)
- [How it works](#how-it-works)
- [Project layout and development](#project-layout-and-development)
- [Security and privacy](#security-and-privacy)
- [References and license](#references-and-license)

## Controls and everyday behavior

| Control | Behavior while Fire TV forwarding is active |
| --- | --- |
| Pointer movement | Moves Fire TV's native mouse cursor, with configurable movement gain |
| Wheel | Scrolls as a mouse wheel |
| Pointer click | Left mouse button; holding it allows dragging where the app supports it |
| D-pad / OK | Fire TV navigation / select |
| Back | Fire TV back |
| Microphone | Hold to speak to Alexa; release to submit, with a maximum session of 20 seconds |
| Home | Opens LG Home, preserving an existing custom LG input-hook action |
| Input | Opens the LG input picker |
| Volume / mute | Controls the LG TV |

Forwarding requires all of the following:

- The configured HDMI application is in the foreground.
- The corresponding physical HDMI input is active.
- No LG foreground menu or overlay owns the controls.

Opening LG Home, the input picker, or another LG menu releases captured devices so that navigation goes to LG. Leaving the configured input also releases held Fire TV navigation and mouse buttons. Volume changes remain relative to physical button presses and do not switch inputs.

The cursor hides after **five seconds without pointer activity** by default. Movement, wheel input, or a mouse click shows it again. D-pad navigation does not extend this timer, and hiding the cursor does not disconnect the remote.

The remote supplies motion coordinates, rather than a reliable indication that it is aimed at the screen. Moving it while pointed away can still move the cursor and reset the timer. Mouse support also varies by Fire TV app: some interfaces require D-pad navigation even when the cursor is visible.

## Requirements

| Component | Requirements |
| --- | --- |
| LG TV | Already rooted webOS, root SSH access, Python 2.7, Node 8.12+, `luna-send`, and readable `LGE M-RCU` evdev devices |
| Fire TV | Network ADB debugging enabled, `/system/bin/hid`, and `app_process`; the cursor helper targets Android 9 / API 28+ |
| Installation computer | Git, Python 3.9+, Node/npm, OpenSSH, and Android platform tools (`adb`) |
| Network | Both devices reachable from the installation computer, and Fire TV reachable from the LG TV, on a trusted LAN |
| Boot startup | A compatible webOSbrew `/var/lib/webosbrew/init.d/` directory; otherwise use test mode |

The Python tools use only the standard library. The TV-side JavaScript dependency is the pinned `ws` package, installed on the computer and copied to the TV during deployment. A prebuilt cursor helper is included, so normal installation does not require a JDK or Android SDK.

SSH must work noninteractively, either with an installed key or with the password-authenticated control connection described below. At runtime, the service starts Node through `/usr/bin/node` and invokes Python as `python`.

The bridge uses undocumented LG services and Fire TV LAN protocols, which may change with firmware. It contacts these Fire TV TCP ports:

| Port | Purpose |
| --- | --- |
| `8009` | Activates the Fire TV LAN remote service |
| `8080` | Pairing, remote commands, status, and voice session control over HTTPS |
| `9090` | Microphone audio over a secure WebSocket |
| `5555` by default | ADB mouse reports, cursor helper, and deployment; configurable with `adb_port` |

Keep these services on a private LAN. Do not expose SSH, ADB, or the remote service to the internet. See [SECURITY.md](SECURITY.md) for credential handling and reporting guidance.

## Installation

Run the following commands on the installation computer from the repository directory unless a step explicitly says to run on the TV. Replace `YOUR_TV_IP` and `YOUR_FIRE_TV_IP` with your device addresses.

### 1. Get the project and install its dependency

```sh
git clone https://github.com/mgd34msu/lg-magic-fire.git
cd lg-magic-fire
npm ci --prefix standalone --ignore-scripts
cp settings.example.json settings.json
```

Edit `settings.json` with the LG TV address, Fire TV address, and the physical HDMI port connected to Fire TV. The default port is **HDMI 3**; change it if your cable is connected elsewhere. See [Configuration](#configuration) for every supported setting.

Validate the settings and inspect the deployment mode without contacting either device:

```sh
python3 magic_fire.py config
python3 deploy.py --test --dry-run
```

`config` also prints the derived HDMI application ID, such as `com.webos.app.hdmi3`. A dry run validates settings and prints the plan; it does not check SSH, ADB, credentials, installed dependencies, or hardware compatibility.

### 2. Verify root SSH access to the TV

```sh
ssh root@YOUR_TV_IP
```

Exit the TV shell before continuing on the computer. The tools use SSH with `BatchMode=yes`, so they cannot prompt for a password themselves.

If you use password authentication, establish a reusable SSH control connection first:

```sh
export MAGIC_FIRE_SSH_CONTROL="${TMPDIR:-/tmp}/lg-magic-fire-ssh"
ssh -M -S "$MAGIC_FIRE_SSH_CONTROL" -o ControlPersist=600 -fnNT root@YOUR_TV_IP
```

Run deployment and maintenance commands in the same terminal so they inherit `MAGIC_FIRE_SSH_CONTROL`. Reestablish the connection if it expires. An installed SSH key does not require this step.

### 3. Pair the Fire TV LAN remote service

```sh
python3 magic_fire.py setup
```

Fire TV displays a four-digit PIN. Enter it in the terminal; the prompt hides your input. Setup creates:

- `.state/firetv.json`: the paired Fire TV address and private LAN remote token.
- `.state/tv-adbkey` and `.state/tv-adbkey.pub`: a dedicated ADB key pair for the bridge running on the TV.

These files are excluded from Git. Keep them private and retain them for later deployments. Running setup again reuses existing credentials; use `setup --pair` when you need to replace the LAN pairing.

### 4. Authorize ADB and deploy in test mode

Enable ADB debugging on Fire TV, then connect from the computer:

```sh
adb connect YOUR_FIRE_TV_IP:5555
```

Accept the computer's ADB authorization prompt on Fire TV. Use your configured port if it differs from `5555`. You can inspect the connection with `adb devices`; the target should appear as `device`, rather than `unauthorized` or `offline`.

Deploy the bridge:

```sh
python3 deploy.py --test
```

Deployment copies the cursor helper to Fire TV, installs the runtime and private credentials on the LG TV, and starts the service. When the TV bridge first connects, accept its **separate ADB authorization prompt** on Fire TV. Select “Always allow” for unattended reconnection. Authorizing the computer's key alone does not authorize the bridge's key. The supervisor retries if authorization is delayed.

**Test mode runs the real bridge immediately and disables its boot startup.** If an existing project-owned boot hook is present, `--test` removes it. Deployment stops an existing bridge before replacing its runtime files.

### 5. Verify the controls manually

Select the configured Fire TV HDMI input and close LG menus, then check:

- Pointer movement, wheel scrolling, clicking, and cursor hiding after inactivity.
- D-pad, OK, and Back in a Fire TV interface.
- Hold-to-talk with the microphone button, then release to submit to Alexa.
- Home and Input returning to LG navigation.
- Volume and mute continuing to control the LG TV.
- Native LG navigation on another HDMI input and after stopping the bridge.

Deployment does not send test button presses, switch inputs, or adjust volume. Mocked tests cannot replace this hardware check.

Inspect service state and recent logs from the computer:

```sh
python3 magic_fire.py status
python3 magic_fire.py logs --lines 50
```

A successful bridge startup logs `Magic Fire started: established Fire TV mouse`. Entering the configured input logs `Fire TV cursor active on HDMI` followed by the input number. A running supervisor alone does not confirm that Fire TV connections and input capture are ready.

### 6. Enable startup at TV boot

Once the hardware checks pass:

```sh
python3 deploy.py
```

This deploys and starts the service again, and installs `/var/lib/webosbrew/init.d/magic-fire`. The boot-hook directory must already exist in your rooting setup. If it is unavailable, keep using `--test` and start the service manually when needed.

After installation, neither a computer nor a persistent installation SSH session is needed for runtime operation.

## Configuration

Copy [settings.example.json](settings.example.json) to `settings.json`:

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

| Setting | Required / default | Accepted values and meaning |
| --- | --- | --- |
| `tv_host` | Required | LG TV host name or IP address for root SSH |
| `fire_tv_host` | Required | Fire TV host name or IP address; pair again after changing it |
| `hdmi_input` | `3` | Whole number from `1` to `4`; physical HDMI port connected to Fire TV |
| `pointer_gain` | `0.6` | Number from `0.1` to `2`; lower values make movement slower |
| `adb_port` | `5555` | Whole number from `1` to `65535`; Fire TV network ADB port |
| `cursor_idle_seconds` | `5` | Number from `1` to `3600`; inactivity before hiding the cursor |

Hosts must not include a URL scheme or port. Both the Python and JavaScript runtimes validate settings and reject unknown keys, invalid types, and out-of-range values.

### Selecting a settings file

Installation tools resolve settings in this order:

1. The explicit `--settings PATH` argument.
2. The `MAGIC_FIRE_SETTINGS` environment variable.
3. `settings.json` in the repository directory.

For `magic_fire.py`, global options go **before** the subcommand:

```sh
python3 magic_fire.py --settings /path/to/living-room.json config
python3 deploy.py --settings /path/to/living-room.json --test --dry-run
```

Or set the environment variable for subsequent commands:

```sh
export MAGIC_FIRE_SETTINGS=/path/to/living-room.json
python3 magic_fire.py config
```

### Applying changes

Settings are read at startup and are not hot-reloaded. Edit the local file and redeploy with the desired startup mode:

```sh
# Apply settings, start now, and disable boot startup.
python3 deploy.py --test

# Apply settings, start now, and enable boot startup instead.
python3 deploy.py
```

Restarting alone reads the settings already installed on the TV; it does not copy local changes. You can also edit `/media/developer/magic-fire/settings.json` directly on the TV, then stop and start its service. A later deployment replaces that file with the local settings.

The LAN token remains separate in the TV's private `config.json`. If Fire TV's address changes, update the local settings, run `python3 magic_fire.py setup --pair`, then redeploy. DHCP reservations help keep device addresses stable.

## Commands and maintenance

### Computer-side command reference

| Command | Purpose |
| --- | --- |
| `python3 magic_fire.py config` | Validate and print local settings, including the target HDMI application; no device connection |
| `python3 magic_fire.py setup` | Generate the bridge ADB key if missing and pair the LAN remote service if credentials are missing |
| `python3 magic_fire.py setup --pair` | Replace the saved LAN remote pairing token; retains an existing bridge ADB key |
| `python3 deploy.py --test --dry-run` | Validate settings and show a deployment plan without device connections |
| `python3 deploy.py --test` | Install/update and start now, with boot startup disabled |
| `python3 deploy.py` | Install/update and start now, with boot startup enabled |
| `python3 magic_fire.py status` | Print LG supervisor state and query the Fire TV LAN remote status |
| `python3 magic_fire.py logs --lines 50` | Read recent TV runtime logs; default 30 lines, accepted range 1–1000 |
| `python3 magic_fire.py stop` | Stop the running supervisor and bridge |
| `python3 magic_fire.py start` | Start the installed service; does not deploy files or change the boot hook |
| `python3 magic_fire.py capture --seconds 30` | Passively read remote events; default 30 seconds, maximum 300 |

There is no `restart` subcommand. Stop, then start:

```sh
python3 magic_fire.py stop
python3 magic_fire.py start
```

`status` performs two separate checks. Fire TV can answer its status request while the LG bridge is stopped, and a running LG supervisor can be retrying a failed bridge. Check the logs to confirm readiness. The Fire TV query requires the saved local pairing credentials.

Additional global options for `magic_fire.py` are `--tv HOST`, which overrides the SSH target for that command, and `--state PATH`, which selects the local LAN pairing file. Deployment always reads `.state/firetv.json` and the dedicated ADB key in the repository's `.state/` directory; it does not accept a custom state path.

### Runtime locations

| Location | Contents |
| --- | --- |
| `/media/developer/magic-fire/` on LG TV | Runtime code, dependency, installed settings, LAN token, and bridge ADB key |
| `/var/lib/webosbrew/init.d/magic-fire` on LG TV | Optional boot startup script |
| `/tmp/magic-fire.log` on LG TV | Supervisor and bridge output |
| `/tmp/magic-fire-supervisor.pid` and `/tmp/magic-fire-node.pid` on LG TV | Supervisor and bridge process IDs |
| `/tmp/magic-fire-diagnostics/` on LG TV | Files staged by the passive capture command |
| `/data/local/tmp/lg-magic-fire-cursor.jar` on Fire TV | Cursor visibility helper copied during deployment |
| `.state/` on the computer | Private LAN pairing credentials and dedicated bridge ADB key pair |

The supervisor retries an exited bridge after five seconds. Stopping the service releases input capture and restores the LG voice handler. An independent voice guardian also restores LG voice if its parent dies or stops renewing its lease.

### Updating an installation

Pull the desired revision, refresh the pinned dependency, then redeploy:

```sh
git pull --ff-only
npm ci --prefix standalone --ignore-scripts
python3 deploy.py --test
```

Recheck hardware behavior after an update, then run `python3 deploy.py` if you want boot startup enabled. Existing local settings and `.state/` credentials are reused; setup is only needed when credentials are missing or pairing needs replacement.

## Troubleshooting

Start with `python3 magic_fire.py logs --lines 100`. The error text usually identifies whether the failure concerns SSH, the LAN remote service, ADB, or TV input capture.

| Symptom or message | What to check |
| --- | --- |
| Settings file missing or invalid | Copy the example, use valid JSON, check the selected path, and run `magic_fire.py config`. Unknown keys are rejected. |
| SSH permission denied or a command cannot prompt | Verify `ssh root@YOUR_TV_IP`. Configure a key or establish the control connection in the same terminal as the tools. |
| `Missing deployment input` | Run `npm ci --prefix standalone --ignore-scripts` and `magic_fire.py setup`; confirm the checked-in cursor JAR is present. |
| Deployment reports missing `.state/firetv.json` | Run `magic_fire.py setup` before deployment. |
| Credentials belong to another Fire TV | Correct `fire_tv_host`, then run `magic_fire.py setup --pair`. |
| `DIAL HTTP`, `DIAL timed out`, or Fire TV HTTP errors | Verify Fire TV is reachable and the LAN remote service ports are accessible. Re-pair if the saved token is no longer accepted. |
| ADB `unauthorized`, `Waiting for Fire TV to authorize the TV bridge key`, or authorization timeout | Accept the appropriate key on Fire TV. The installation computer and TV bridge use different keys. Check `adb_port` and ADB debugging. |
| `Fire TV mouse did not register` | Check ADB connectivity, `/system/bin/hid`, and firmware compatibility. |
| `Cursor visibility helper did not start` | Check the deployed cursor JAR, `app_process`, and Android API compatibility. |
| `No Magic Remote input devices found` | Confirm root access and that the remote exposes readable `LGE M-RCU` event devices on this TV. |
| Supervisor runs but forwarding does not work | Inspect repeated startup failures, select the configured physical HDMI input, and close LG menus. |
| Cursor moves but an app does not respond to clicks | Try D-pad navigation; Fire TV apps differ in mouse support. |
| Repeated disconnects or bridge/agent exits | Inspect the preceding log error, verify network stability and authorization, and check for firmware-specific service failures. |

To collect remote events without intercepting controls:

```sh
python3 magic_fire.py capture --seconds 30
```

Capture stages diagnostics on the TV and streams event records to the terminal. It does not enable bridge capture or microphone forwarding. Its output includes physical remote events; review it before sharing.

For a compatibility report, include the TV and remote models, webOS version, Fire TV model, Fire OS version, HDMI port, whether an LG menu was open, reproduction steps, and relevant redacted log lines. See [CONTRIBUTING.md](CONTRIBUTING.md). Never attach `.state/`, private settings, pairing tokens, ADB keys, audio, or raw remote captures.

## Disable or uninstall

For a temporary stop from the computer:

```sh
python3 magic_fire.py stop
```

This leaves any boot hook in place, so the bridge can start again after a TV reboot. To stop it and disable boot startup, run these commands **on the LG TV**:

```sh
sh /media/developer/magic-fire/service.sh stop
rm -f /var/lib/webosbrew/init.d/magic-fire
```

Runtime files remain available for inspection or a later manual start. For a full file removal, stop the service and remove its boot hook first, then run **on the LG TV**:

```sh
rm -rf /media/developer/magic-fire
```

Optionally remove the helper from Fire TV, from the computer using the configured ADB address and port:

```sh
adb -s YOUR_FIRE_TV_IP:5555 shell rm -f /data/local/tmp/lg-magic-fire-cursor.jar
```

Removing files does not revoke the LAN pairing or ADB authorization on Fire TV. Revoke those separately on Fire TV if you no longer want the credentials to work. Local `.state/` files also remain until you remove them.

Deployment installs no new `lginputhook` mappings. `install_hooks.py` is a migration cleanup tool: when an earlier prototype's backup exists, it restores only exact entries owned by that prototype.

## How it works

The runtime has three main parts:

1. **LG input reader:** Python reads the remote's evdev devices and checks the foreground LG application, overlays, and physical input through Luna services. It captures devices only within the configured HDMI scope, suppressing the LG pointer while forwarding is active.
2. **TV bridge:** Node routes navigation and voice through Fire TV's paired LAN remote service. Its ADB client sends relative HID mouse reports directly to Android's `hid` utility, producing Fire TV's native cursor. The TV does not need an installed `adb` executable for runtime operation.
3. **Fire TV cursor helper:** A small Java helper runs through `app_process` and changes the system mouse icon's visibility. It is separate from mouse motion and button routing.

### Pointer translation and visibility

The LG remote exposes bounded coordinates. The reader recenters hidden LG coordinates near their bounds so they do not become invisible edges for the Fire TV pointer. Delayed reports are filtered, and failed recenters rebase the motion source without restarting the bridge. The mouse engine scales relative movement while retaining fractional gain.

Android's native cursor fade timer can be shorter than the configured timeout. To keep it awake while the cursor should be visible, the bridge sends adjacent one-unit inward/back HID reports every two seconds. They have zero net HID displacement, never click or scroll, and are skipped during drags. Android acceleration and app hover handling can still make this workaround observable. Only real pointer activity extends the configured idle timer.

### Voice and cleanup

While the configured HDMI scope is active, the reader temporarily pauses LG's `voiceconductor` under a renewable guardian lease. A held microphone button opens the LG microphone stream and forwards audio to Alexa over the paired Fire TV voice connection. Release, leaving the scope, or reaching the 20-second limit ends the session. The bridge does not save microphone audio.

Input descriptors are close-on-exec and released before service cleanup. Held Fire TV keys and mouse buttons are released when scope ends. The voice guardian is independent of the main process so LG voice can recover after a crash or an expired lease.

## Project layout and development

| Path | Role |
| --- | --- |
| `magic_fire.py` | Computer-side setup, configuration, status, service commands, logs, and passive capture |
| `deploy.py` | Packages and deploys the runtime, cursor helper, credentials, and optional boot hook |
| `bridge_settings.py` / `standalone/settings.js` | Settings loading and validation for the Python and JavaScript runtimes |
| `tv_agent.py` | LG Luna queries, microphone streaming, and voice guardian |
| `tv_reader.py` / `tv_control.py` | Remote event reading, capture leases, HDMI scope, and native LG button routing |
| `pointer_source.py` | Pointer recenter confirmation and stale-coordinate handling |
| `standalone/bridge.js` | Fire TV LAN remote and voice orchestration |
| `standalone/adb.js` / `standalone/hid_mouse.js` | ADB wire protocol and relative HID mouse reports |
| `standalone/input_router.js` / `standalone/cursor_idle.js` | Fire TV event routing and cursor idle timing |
| `standalone/service.sh` | TV supervisor and service lifecycle |
| `cursor/` | Java cursor helper source, build script, and prebuilt JAR |
| `tests/` | Hardware-free Python and JavaScript checks |
| `install_hooks.py` | Cleanup for mappings owned by the earlier prototype |

### Run checks without devices

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm test --prefix standalone
node --check standalone/bridge.js
```

Tests use mocks and fixtures without device connections. They cover HDMI selection, native LG routing, capture cleanup, pointer scaling/recentering, settings, and idle visibility. They do not establish compatibility with every device or app, or validate live ADB, microphone streaming, and firmware services.

Keep runtime JavaScript compatible with Node 8.12 and TV Python compatible with Python 2.7. Installation tools use Python 3.9+ and modern Node/npm. See [CONTRIBUTING.md](CONTRIBUTING.md) for regression coverage and hardware reporting expectations.

### Rebuild the cursor helper

The prebuilt `cursor/cursor-visibility.jar` is included alongside its source. To rebuild it, install a JDK with `javac` and `jar`, Android SDK platform 35, and build-tools 35.0.0, then run:

```sh
ANDROID_SDK_ROOT=/path/to/android-sdk sh cursor/build.sh
```

The script also accepts `ANDROID_HOME` as an SDK path fallback, `ANDROID_API` to select a platform, and `ANDROID_BUILD_TOOLS` to select a build-tools version. It compiles Java 8 bytecode, uses `d8` with minimum API 28, writes intermediates under `build/cursor/`, and replaces the checked-in JAR. Redeploy after rebuilding to copy the helper to Fire TV.

## Security and privacy

The bridge runs as root on the LG TV and holds an authorized Fire TV ADB key. Protect both device access and backups of the installation directories.

- Personal settings, credentials, logs, and captures are excluded from Git. Deployment installs private credentials with owner-only permissions.
- The Fire TV LAN service uses TLS, but this client does not validate its certificate against a trusted certificate authority.
- The static `x-api-key` in source identifies the protocol; the private pairing token is the credential. ADB uses a separate dedicated key.
- Audio is forwarded only during a scoped microphone press-and-hold and is not saved by the bridge. Alexa processes it according to your Amazon settings.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and credential recovery.

## References and license

- [Android ADB protocol](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt)
- [Amazon ADB setup](https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html)
- [LG Magic Remote](https://webostv.developer.lge.com/develop/guides/magic-remote)
- [LibreControl Fire TV protocol research](https://github.com/LibreControl/fire-tv/blob/main/docs/protocol.md)
- [LG microphone research](https://github.com/lasharor/cleanyourtv-WebOS/blob/main/helper/voice.js)

Licensed under [MIT](LICENSE). The pinned `ws` dependency has its own MIT license. No LG or Amazon proprietary binaries, private keys, pairing tokens, or capture logs are included.

# Contributing

Include TV and remote models, webOS version, Fire TV model, Fire OS version,
the relevant redacted log lines, and reproduction steps in an issue. Describe
the HDMI input and whether an LG menu was open. Do not include `.state/`,
ADB keys, tokens, private settings, audio, or raw remote captures.

Run the Python tests and `npm test --prefix standalone` before submitting a
change. Keep TV code compatible with Python 2.7 and Node 8.12. Add meaningful
regression coverage for capture, routing, pointer, or voice cleanup changes.
Unit tests must not connect to hardware or invoke audio services.

Report hardware observations separately from mocked checks. Confirm native
LG controls on other inputs and recovery after stopping the bridge. Avoid
changing pointer translation as a side effect of button or settings work.
Keep volume relative and tied to actual user presses.

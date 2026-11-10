# dsh-bt-remote-voice

Turn a **Bluetooth voice remote** into push-to-talk speech input for DeepSeek Harness.

Hold the remote's voice key, speak, release — the audio captured by the remote's own
microphone becomes text. No host microphone required, no cloud service, no native build.

> Verified on real hardware: **Xiaomi Bluetooth Voice Remote (ARN9)** and
> **Xiaomi Bluetooth Remote 2 Pro (RC003)**. Any device exposing the standard ATVV
> service works via `profiles/generic-atvv.json`.

## Why

Most voice-input setups assume a working host microphone. Mini PCs, industrial boxes and
dev boards attached to an HDMI display usually have none — but a Bluetooth voice remote is
often already within reach. Such remotes do not use HFP/HSP; they stream **ATVV**
(Android TV Voice over BLE) as IMA/DVI ADPCM, 120-byte frames, 16 kHz.

## Linux prerequisites

1. **Disable the BlueZ HID host plugin** — mandatory. With HID attached the device switches
   its voice path to a vendor-encrypted channel and standard ATVV receives nothing.

   ```ini
   # /etc/bluetooth/main.conf
   [General]
   DisablePlugins = input
   sudo systemctl restart bluetooth
   ```

2. Allow the user to read evdev / write uinput (see the Chinese README for the udev rule).
3. Pair, trust and connect the remote.

## Install

```bash
dsh plugin --profile desktop add dsh-bt-remote-voice
```

Restart DSH fully afterwards — ES module cache survives bundle remounts.

## Use

Hold the voice key, speak, release. Recognized text is delivered through the plugin event.
The settings page shows state, matched profile, HID-plugin diagnostics and a log.

## Agent tool

`bt_remote_voice` with actions `status | scan | connect | disconnect | open_mic | close_mic | recent_log`.

## Adding a device

Drop a JSON into `profiles/`. No code change needed.

## License

MIT

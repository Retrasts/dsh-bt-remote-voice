#!/usr/bin/env python3
"""
evdev 按键辅助进程。

为什么不用 Node 直接做：独占一个输入设备需要 `EVIOCGRAB` ioctl，创建虚拟键盘需要
写 `/dev/uinput` 的二进制结构，Node 侧都要原生模块。这个脚本只用 Python 标准库
（fcntl / struct / select），随插件一起分发，Node 通过 stdin/stdout 用 JSON 行协议
驱动它，插件本身仍然是零原生依赖。

协议（每行一个 JSON）：
  父进程 -> 子进程
    {"cmd":"grab","event":"event11","voiceKeys":[62,63],"forward":true}
    {"cmd":"set","voiceKeys":[62,63]}
    {"cmd":"stop"}
  子进程 -> 父进程
    {"ev":"ready","event":"/dev/input/event11","name":"bluez-hog-device","grabbed":true}
    {"ev":"key","code":62,"value":1,"voice":true}
    {"ev":"forward","code":28,"value":1}
    {"ev":"error","message":"..."}
    {"ev":"stopped"}
"""

import json
import os
import select
import struct
import sys

EVIOCGRAB = 0x40044590
INPUT_EVENT_SIZE = 24  # struct input_event on 64-bit Linux

# uinput 常量
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_DEV_SETUP = 0x405c5503
EV_SYN = 0x00
EV_KEY = 0x01
EV_MSC = 0x04
KEY_MAX = 0x2FF

state = {"voice_keys": {62, 63}, "forward": True, "uinput": None, "event": None}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def open_uinput(name="DSH Bluetooth Remote"):
    """创建虚拟键盘；失败时返回 None（按键只上报，不转发）。"""
    try:
        import fcntl
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    except OSError as exc:
        emit({"ev": "error", "message": f"打不开 /dev/uinput: {exc}"})
        return None
    try:
        import fcntl
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for code in range(1, KEY_MAX):
            try:
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            except OSError:
                break
        # struct uinput_setup: id(bustype,vendor,product,version) + name[80] + ff_effects_max
        setup = struct.pack(
            "HHHH80sI",
            0x0005,      # BUS_BLUETOOTH
            0x0000,      # vendor（让系统把它当普通键盘）
            0x0000,      # product
            0x0001,      # version
            name.encode()[:79],
            0,
        )
        fcntl.ioctl(fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        return fd
    except OSError as exc:
        emit({"ev": "error", "message": f"创建虚拟键盘失败: {exc}"})
        try:
            os.close(fd)
        except OSError:
            pass
        return None


def write_key(fd, code, value):
    if fd is None:
        return
    try:
        # struct input_event (64-bit): tv_sec, tv_usec, type, code, value
        ts = 0
        os.write(fd, struct.pack("qqHHi", ts, ts, EV_KEY, code, value))
        os.write(fd, struct.pack("qqHHi", ts, ts, EV_SYN, 0, 0))
    except OSError as exc:
        emit({"ev": "error", "message": f"写 uinput 失败: {exc}"})


def grab(event_name):
    path = event_name if event_name.startswith("/dev/") else os.path.join("/dev/input", event_name)
    state["path"] = path
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as exc:
        emit({"ev": "error", "message": f"打不开 {path}: {exc}"})
        return None
    try:
        import fcntl
        fcntl.ioctl(fd, EVIOCGRAB, 1)
        grabbed = True
    except OSError as exc:
        grabbed = False
        emit({"ev": "error", "message": f"独占失败（按键仍会进入桌面）: {exc}"})
    name = ""
    base = os.path.basename(path)
    try:
        with open(f"/sys/class/input/{base}/device/name") as fh:
            name = fh.read().strip()
    except OSError:
        pass
    emit({"ev": "ready", "event": path, "name": name, "grabbed": grabbed})
    return fd


def main():
    fd = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        cmd = msg.get("cmd")
        if cmd == "grab":
            state["voice_keys"] = set(msg.get("voiceKeys") or [62, 63])
            state["forward"] = bool(msg.get("forward", True))
            fd = grab(msg.get("event") or "event0")
            if fd is None:
                continue
            if state["forward"]:
                state["uinput"] = open_uinput()
            state["event"] = fd
            run_loop(fd, state.get('path'))
            emit({"ev": "stopped"})
            fd = None
        elif cmd == "set":
            state["voice_keys"] = set(msg.get("voiceKeys") or state["voice_keys"])
        elif cmd == "stop":
            break
    if state["uinput"] is not None:
        try:
            import fcntl
            fcntl.ioctl(state["uinput"], UI_DEV_DESTROY)
            os.close(state["uinput"])
        except OSError:
            pass
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def run_loop(fd, path=None):
    import time
    last = time.time()
    last_check = time.time()
    try:
        inode = os.stat(path).st_ino if path else None
    except OSError:
        inode = None
    while True:
        # 设备重连后 /dev/input/eventN 会被换成新的 inode，旧 fd 变成 (deleted)。
        # 这时独占其实已经失效（F5 会漏到桌面），必须退出让上层重新打开。
        now = time.time()
        if path and now - last_check > 3:
            last_check = now
            try:
                cur = os.stat(path).st_ino
            except OSError:
                emit({"ev": "error", "message": f"设备节点消失: {path}"})
                break
            if inode is not None and cur != inode:
                emit({"ev": "error", "message": f"设备节点已重建（inode {inode} -> {cur}），退出以便重新独占"})
                break
        r, _, _ = select.select([fd, sys.stdin], [], [], 0.25)
        if sys.stdin in r:
            line = sys.stdin.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
                if msg.get("cmd") == "set":
                    state["voice_keys"] = set(msg.get("voiceKeys") or state["voice_keys"])
                elif msg.get("cmd") == "stop":
                    break
            except ValueError:
                pass
        if fd in r:
            try:
                data = os.read(fd, INPUT_EVENT_SIZE * 64)
            except OSError:
                break
            for i in range(0, len(data) - INPUT_EVENT_SIZE + 1, INPUT_EVENT_SIZE):
                sec, usec, typ, code, value = struct.unpack("qqHHi", data[i:i + INPUT_EVENT_SIZE])
                if typ == EV_MSC:
                    continue
                if typ == EV_SYN:
                    continue
                if typ != EV_KEY:
                    continue
                if code in state["voice_keys"]:
                    emit({"ev": "key", "code": code, "value": value, "voice": True})
                    continue
                if state["forward"]:
                    write_key(state["uinput"], code, value)
                    emit({"ev": "forward", "code": code, "value": value})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

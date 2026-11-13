#!/usr/bin/env python3
"""
独立按键守护：常驻独占蓝牙遥控器的 evdev 节点，与 DSH 解耦。

为什么独立：设备每次重连内核都会重建 /dev/input/eventN（inode 变化），旧 fd 的
EVIOCGRAB 事实上失效但进程还活着，F5 就漏到浏览器触发页面刷新。把这件事放在 DSH
插件里意味着「插件没跑 / 插件重启 / 设备重连」任一情况下都会漏。做成 systemd 用户
服务后，它只依赖「设备存在」这一个条件。

行为：
  - 按 MAC 找到遥控器的 event 节点（名字可能退化成 bluez-hog-device）
  - EVIOCGRAB 独占，语音键吞掉，其余键转发到虚拟键盘
  - 每 2 秒自检：节点消失或 inode 变化就重开
  - 设备暂时不在时静默等待，出现即抓
"""
import fcntl
import json
import os
import select
import struct
import sys
import time

MAC = os.environ.get("MI_MAC", "e8:55:40:b1:c6:1a").lower()
VOICE_KEYS = {int(x) for x in os.environ.get("MI_VOICE_KEYS", "62,63").split(",")}
FORWARD = os.environ.get("MI_FORWARD", "1") != "0"
VERBOSE = os.environ.get("MI_VERBOSE", "1") != "0"

EVIOCGRAB = 0x40044590
INPUT_EVENT_SIZE = 24
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_DEV_CREATE = 0x5501
UI_DEV_SETUP = 0x405c5503
EV_SYN, EV_KEY, EV_MSC = 0x00, 0x01, 0x04
KEY_MAX = 0x2FF


def log(msg):
    if VERBOSE:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def find_event():
    """按 uniq MAC 找遥控器的 event 节点。"""
    try:
        blocks = open("/proc/bus/input/devices").read().split("\n\n")
    except OSError:
        return None
    for block in blocks:
        if MAC not in block.lower():
            continue
        name = ""
        event = None
        for line in block.splitlines():
            if line.startswith("N: Name="):
                name = line[9:].strip().strip('"')
            elif line.startswith("H: Handlers="):
                for tok in line[12:].split():
                    if tok.startswith("event"):
                        event = "/dev/input/" + tok
        if event:
            return event, name
    return None, None


def open_uinput():
    try:
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    except OSError as exc:
        log(f"打不开 /dev/uinput: {exc}")
        return None
    try:
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for code in range(1, KEY_MAX):
            try:
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            except OSError:
                break
        setup = struct.pack("HHHH80sI", 0x0005, 0x0000, 0x0000, 0x0001,
                            b"mi-remote-passthrough"[:79], 0)
        fcntl.ioctl(fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        return fd
    except OSError as exc:
        log(f"创建虚拟键盘失败: {exc}")
        try:
            os.close(fd)
        except OSError:
            pass
        return None


def write_key(fd, code, value):
    if fd is None:
        return
    try:
        os.write(fd, struct.pack("qqHHi", 0, 0, EV_KEY, code, value))
        os.write(fd, struct.pack("qqHHi", 0, 0, EV_SYN, 0, 0))
    except OSError:
        pass


def serve(path, ui):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as exc:
        log(f"打不开 {path}: {exc}")
        return
    try:
        fcntl.ioctl(fd, EVIOCGRAB, 1)
    except OSError as exc:
        log(f"独占失败: {exc}")
        os.close(fd)
        return
    try:
        inode = os.stat(path).st_ino
    except OSError:
        inode = None
    log(f"已独占 {path}（语音键 {sorted(VOICE_KEYS)} 吞掉，其余转发={FORWARD}）")
    last_check = time.time()
    while True:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                data = os.read(fd, INPUT_EVENT_SIZE * 128)
            except OSError:
                break
            for i in range(0, len(data) - INPUT_EVENT_SIZE + 1, INPUT_EVENT_SIZE):
                _s, _u, typ, code, value = struct.unpack("qqHHi", data[i:i + INPUT_EVENT_SIZE])
                if typ != EV_KEY:
                    continue
                if code in VOICE_KEYS:
                    continue                      # 语音键不给桌面
                if FORWARD:
                    write_key(ui, code, value)
        if time.time() - last_check > 2:
            last_check = time.time()
            try:
                cur = os.stat(path).st_ino
            except OSError:
                log("设备节点消失，等待重连")
                break
            if inode is not None and cur != inode:
                log(f"设备节点已重建（{inode} -> {cur}），重新独占")
                break
    try:
        os.close(fd)
    except OSError:
        pass


def main():
    log(f"守护启动，目标 MAC {MAC}")
    ui = open_uinput() if FORWARD else None
    if FORWARD and ui is None:
        log("虚拟键盘不可用，按键将不转发（只做拦截）")
    while True:
        path, name = find_event()
        if path is None:
            time.sleep(2)
            continue
        log(f"发现设备 {path}（{name or '未命名'}）")
        serve(path, ui)
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)

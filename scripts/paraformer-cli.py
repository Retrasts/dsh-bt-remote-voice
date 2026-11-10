#!/usr/bin/env python3
"""
最小识别 CLI，配合插件的 externalAsrCommand 使用。

用法：  python3 paraformer-cli.py <speech.wav>
输出：  识别文本到 stdout

模型目录用环境变量 PF_DIR 覆盖，默认 ~/models/paraformer-zh。
依赖：  pip install sherpa-onnx numpy
"""
import os
import sys

def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python3 paraformer-cli.py <speech.wav>")
    wav = sys.argv[-1]
    pf_dir = os.environ.get("PF_DIR", os.path.expanduser("~/models/paraformer-zh"))
    model = os.path.join(pf_dir, "model.int8.onnx")
    tokens = os.path.join(pf_dir, "tokens.txt")
    if not (os.path.exists(model) and os.path.exists(tokens)):
        sys.exit(f"找不到 Paraformer 模型: {pf_dir}")

    import wave
    import numpy as np
    import sherpa_onnx

    with wave.open(wav) as w:
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if rate != 16000:
        idx = (np.arange(int(len(audio) * 16000 / rate)) * rate / 16000).astype(int)
        audio = audio[np.clip(idx, 0, len(audio) - 1)]

    recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
        paraformer=model,
        tokens=tokens,
        num_threads=2,
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
    )
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, audio)
    recognizer.decode_stream(stream)
    print(stream.result.text.strip())

if __name__ == "__main__":
    main()

"""In-process inference engine with model caching and progress reporting.

The logic mirrors main_reflow.py (same algorithm and f0 cache) but exposes a
progress callback and cancellation checks so it can drive the WebUI.
"""
from __future__ import annotations

import gc
import hashlib
import os
import threading
import time
from ast import literal_eval
from pathlib import Path

import core


class InferenceError(Exception):
    pass


class InferenceCancelled(Exception):
    pass


def _split(audio, sample_rate, hop_size, db_thresh=-40, min_len=5000):
    from slicer import Slicer

    slicer = Slicer(sr=sample_rate, threshold=db_thresh, min_length=min_len)
    chunks = dict(slicer.slice(audio))
    result = []
    for _, value in chunks.items():
        tag = value["split_time"].split(",")
        if tag[0] != tag[1]:
            start_frame = int(int(tag[0]) // hop_size)
            end_frame = int(int(tag[1]) // hop_size)
            if end_frame > start_frame:
                result.append(
                    (start_frame, audio[int(start_frame * hop_size): int(end_frame * hop_size)])
                )
    return result


def _cross_fade(a, b, idx):
    import numpy as np

    result = np.zeros(idx + b.shape[0])
    fade_len = a.shape[0] - idx
    np.copyto(dst=result[:idx], src=a[:idx])
    k = np.linspace(0, 1.0, num=fade_len, endpoint=True)
    result[idx: a.shape[0]] = (1 - k) * a[idx:] + k * b[:fade_len]
    np.copyto(dst=result[a.shape[0]:], src=b[fade_len:])
    return result


def _resolve_device(device: str | None, torch) -> str:
    device = (device or "auto").lower()
    if device in ("auto", ""):
        return "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise InferenceError("当前环境未检测到可用的 CUDA，请切换到 CPU 模式")
    if device not in ("cuda", "cpu"):
        raise InferenceError(f"不支持的设备：{device}")
    return device


def _parse_mix(text, n_spk: int | None):
    if text is None:
        return None
    text = str(text).strip()
    if not text or text.lower() in ("none", "null", "{}"):
        return None
    try:
        value = literal_eval(text)
    except Exception:
        raise InferenceError('混合音色格式错误，应形如 {1:0.7, 2:0.3}')
    if not isinstance(value, dict) or not value:
        raise InferenceError("混合音色必须是非空字典，例如 {1:0.7, 2:0.3}")
    cleaned = {}
    for key, val in value.items():
        try:
            spk = int(key)
            weight = float(val)
        except Exception:
            raise InferenceError("混合音色的说话人编号必须是整数，权重必须是数字")
        if spk < 1:
            raise InferenceError("说话人编号必须大于等于 1")
        if n_spk and spk > int(n_spk):
            raise InferenceError(f"说话人编号 {spk} 超出模型范围（n_spk={n_spk}）")
        if weight < 0:
            raise InferenceError("混合权重不能为负数")
        cleaned[spk] = weight
    total = sum(cleaned.values())
    if total <= 0:
        raise InferenceError("混合权重之和必须大于 0")
    return cleaned


class InferenceEngine:
    def __init__(self):
        self._lock = threading.RLock()
        self.model = None
        self.vocoder = None
        self.args = None
        self.model_path: str | None = None
        self.model_mtime: float | None = None
        self.device: str | None = None
        self.loaded_at: float | None = None
        self.encoder = None
        self.encoder_key: tuple | None = None
        self.last_error: str | None = None

    # -- cache management ------------------------------------------------
    def status(self) -> dict:
        # Intentionally lock-free: inference can hold the lock for a long time
        # while the UI still needs to poll status.
        return {
            "loaded": self.model is not None,
            "model": core.rel_to_root(self.model_path) if self.model_path else None,
            "model_abs": self.model_path,
            "device": self.device,
            "loaded_at": self.loaded_at,
            "encoder": bool(self.encoder),
            "sampling_rate": getattr(self.args.data, "sampling_rate", None) if self.args else None,
            "n_spk": getattr(self.args.model, "n_spk", None) if self.args else None,
            "last_error": self.last_error,
        }

    def unload(self) -> None:
        with self._lock:
            self.model = None
            self.vocoder = None
            self.args = None
            self.model_path = None
            self.model_mtime = None
            self.device = None
            self.loaded_at = None
            self.encoder = None
            self.encoder_key = None
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def _ensure_cwd(self) -> None:
        try:
            if Path.cwd().resolve() != core.ROOT:
                os.chdir(core.ROOT)
        except Exception:
            pass

    def _ensure_model(self, model_path: Path, device: str, log) -> None:
        try:
            mtime = model_path.stat().st_mtime
        except OSError:
            raise InferenceError(f"模型文件不存在：{core.rel_to_root(model_path)}")
        if (
            self.model is not None
            and self.model_path == str(model_path)
            and self.model_mtime == mtime
            and self.device == device
        ):
            return

        log(f"正在加载模型 {core.rel_to_root(model_path)}（{device.upper()}）…")
        created, message = core.ensure_model_config(model_path)
        if created:
            log(message)
        self.unload()
        try:
            from reflow.vocoder import load_model_vocoder
        except Exception as exc:
            raise InferenceError(f"无法导入推理模块：{exc}")
        try:
            model, vocoder, args = load_model_vocoder(str(model_path), device=device)
        except Exception as exc:
            raise InferenceError(f"模型加载失败：{exc}")
        self.model = model
        self.vocoder = vocoder
        self.args = args
        self.model_path = str(model_path)
        self.model_mtime = mtime
        self.device = device
        self.loaded_at = time.time()
        log("模型加载完成")

    def _ensure_encoder(self, device: str, log) -> None:
        from ddsp.vocoder import Units_Encoder

        args = self.args
        if args.data.encoder == "cnhubertsoftfish":
            gate = args.data.cnhubertsoft_gate
        else:
            gate = 10
        key = (
            str(args.data.encoder),
            str(args.data.encoder_ckpt),
            int(args.data.encoder_sample_rate),
            int(args.data.encoder_hop_size),
            device,
        )
        if self.encoder is not None and self.encoder_key == key:
            return
        log(f"正在加载特征编码器 {args.data.encoder} …")
        self.encoder = None
        self.encoder_key = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        try:
            self.encoder = Units_Encoder(
                args.data.encoder,
                args.data.encoder_ckpt,
                args.data.encoder_sample_rate,
                args.data.encoder_hop_size,
                cnhubertsoft_gate=gate,
                device=device,
            )
        except Exception as exc:
            raise InferenceError(f"特征编码器加载失败：{exc}")
        self.encoder_key = key
        log("特征编码器加载完成")

    # -- public API ------------------------------------------------------
    def preload(self, model_rel: str, device: str, log=print) -> dict:
        with self._lock:
            self._ensure_cwd()
            model_path = core.resolve_inside(model_rel, must_exist=True)
            import torch

            dev = _resolve_device(device, torch)
            self._ensure_model(model_path, dev, log)
            self._ensure_encoder(dev, log)
            return self.status()

    def infer_file(
        self,
        input_path: Path,
        output_path: Path,
        model_rel: str,
        device: str,
        params: dict,
        *,
        log=print,
        progress=None,
        cancel_event: threading.Event | None = None,
    ) -> dict:
        def report(pct, msg=None):
            if progress:
                progress(pct, msg)

        def check_cancel():
            if cancel_event is not None and cancel_event.is_set():
                raise InferenceCancelled()

        started = time.time()
        with self._lock:
            self._ensure_cwd()
            if not input_path.exists():
                raise InferenceError(f"输入音频不存在：{core.rel_to_root(input_path)}")
            try:
                import numpy as np
                import soundfile as sf
                import torch
            except Exception as exc:
                raise InferenceError(f"推理依赖加载失败：{exc}")

            dev = _resolve_device(device, torch)
            model_path = core.resolve_inside(model_rel, must_exist=True)
            report(2, "加载模型…")
            self._ensure_model(model_path, dev, log)
            check_cancel()

            # -- load input ------------------------------------------------
            report(8, "读取输入音频…")
            try:
                import librosa

                audio, sample_rate = librosa.load(str(input_path), sr=None)
                if len(audio.shape) > 1:
                    audio = librosa.to_mono(audio)
            except Exception as exc:
                raise InferenceError(f"无法读取音频：{exc}")

            args = self.args
            hop_size = args.data.block_size * sample_rate / args.data.sampling_rate
            win_size = args.data.volume_smooth_size * sample_rate / args.data.sampling_rate
            duration = len(audio) / float(sample_rate) if sample_rate else 0
            log(
                f"输入 {input_path.name} | {sample_rate} Hz | "
                f"{core.fmt_duration(duration)} | hop={hop_size:.2f}"
            )

            # -- pitch -----------------------------------------------------
            md5_hash = ""
            with open(input_path, "rb") as fh:
                md5_hash = hashlib.md5(fh.read()).hexdigest()

            pitch_extractor = str(params.get("pitch_extractor") or "rmvpe")
            f0_min = float(params.get("f0_min") or 50)
            f0_max = float(params.get("f0_max") or 1100)
            threshold_raw = params.get("threshold")
            threshold = -60.0 if threshold_raw is None or threshold_raw == "" else float(threshold_raw)
            cache_dir = core.ROOT / "cache"
            cache_file = cache_dir / f"{pitch_extractor}_{hop_size}_{f0_min}_{f0_max}_{md5_hash}.npy"

            if cache_file.exists():
                report(14, "读取音高缓存…")
                log("使用音高曲线缓存")
                f0 = np.load(cache_file, allow_pickle=False)
            else:
                report(12, f"提取音高（{pitch_extractor}）…")
                log(f"提取音高曲线：{pitch_extractor}")
                from ddsp.vocoder import F0_Extractor

                extractor = F0_Extractor(pitch_extractor, sample_rate, hop_size, f0_min, f0_max)
                f0 = extractor.extract(audio, uv_interp=True, device=dev)
                cache_dir.mkdir(parents=True, exist_ok=True)
                np.save(cache_file, f0, allow_pickle=False)
            check_cancel()

            f0 = torch.from_numpy(f0).float().to(dev).unsqueeze(-1).unsqueeze(0)
            key = float(params.get("key") or 0)
            formant = float(params.get("formant") or 0)
            vocal_register = float(params.get("vocal_register") or 0)
            f0 = f0 * (2 ** (key / 12))
            formant_t = torch.from_numpy(np.array([[formant]])).float().to(dev)

            # -- volume ----------------------------------------------------
            report(22, "提取音量包络…")
            from ddsp.core import upsample
            from ddsp.vocoder import Volume_Extractor

            volume_extractor = Volume_Extractor(hop_size, win_size)
            volume = volume_extractor.extract(audio)
            mask = (volume > 10 ** (threshold / 20)).astype("float")
            mask = torch.from_numpy(mask).float().to(dev).unsqueeze(-1).unsqueeze(0)
            mask = upsample(mask, args.data.block_size).squeeze(-1)
            volume = torch.from_numpy(volume).float().to(dev).unsqueeze(-1).unsqueeze(0)
            check_cancel()

            # -- units -----------------------------------------------------
            report(28, "提取内容特征…")
            self._ensure_encoder(dev, log)
            audio_t = torch.from_numpy(audio).float().unsqueeze(0).to(dev)
            units_encoder = self.encoder
            check_cancel()

            # -- speaker ---------------------------------------------------
            spk_mix = _parse_mix(params.get("spk_mix"), args.model.n_spk)
            spk_id = int(params.get("spk_id") or 1)
            if spk_id < 1:
                raise InferenceError("说话人编号必须大于等于 1")
            if args.model.n_spk and spk_id > int(args.model.n_spk):
                raise InferenceError(f"说话人编号 {spk_id} 超出模型范围（n_spk={args.model.n_spk}）")
            spk_id_t = torch.LongTensor(np.array([[spk_id]])).to(dev)
            log("混合音色模式" if spk_mix else f"说话人 ID：{spk_id}")

            pc_aug = bool(getattr(self.vocoder.vocoder.h, "pc_aug", False))
            if pc_aug:
                vocal_register_factor = 2 ** (vocal_register / 12)
            else:
                vocal_register_factor = 1
                if abs(vocal_register) > 1e-9:
                    log("当前声码器不支持音区偏移（v），已忽略该参数")

            method = str(params.get("method") or "euler").lower()
            if method not in ("euler", "rk4"):
                raise InferenceError("采样方法只能是 euler 或 rk4")
            infer_step = int(params.get("infer_step") if params.get("infer_step") is not None else 50)
            if infer_step < 0:
                raise InferenceError("推理步数不能为负数")
            t_start = float(params.get("t_start") if params.get("t_start") is not None else 0.0)
            if args.model.t_start is not None and t_start < float(args.model.t_start):
                t_start = float(args.model.t_start)
            if infer_step > 0:
                log(f"采样：{method} | 步数：{infer_step} | t_start：{t_start}")

            # -- segments --------------------------------------------------
            report(32, "切分音频…")
            segments = _split(audio, sample_rate, hop_size)
            if not segments:
                raise InferenceError("音频切分后没有有效片段，请检查输入音频")
            log(f"音频切分为 {len(segments)} 段")

            result = np.zeros(0)
            current_length = 0
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with torch.no_grad():
                for index, segment in enumerate(segments):
                    check_cancel()
                    start_frame = segment[0]
                    seg_input = torch.from_numpy(segment[1]).float().unsqueeze(0).to(dev)
                    seg_units = units_encoder.encode(seg_input, sample_rate, hop_size)
                    seg_f0 = f0[:, start_frame: start_frame + seg_units.size(1), :]
                    seg_volume = volume[:, start_frame: start_frame + seg_units.size(1), :]
                    seg_mel = self.model(
                        seg_units,
                        seg_f0 / vocal_register_factor,
                        seg_volume,
                        spk_id=spk_id_t,
                        spk_mix_dict=spk_mix,
                        aug_shift=formant_t,
                        vocoder=self.vocoder,
                        infer_step=infer_step,
                        method=method,
                        t_start=t_start,
                        use_tqdm=False,
                    )
                    seg_output = self.vocoder.infer(seg_mel, seg_f0)
                    seg_output *= mask[
                        :,
                        start_frame * args.data.block_size:
                        (start_frame + seg_units.size(1)) * args.data.block_size,
                    ]
                    seg_output = seg_output.squeeze().cpu().numpy()

                    silent_length = round(start_frame * args.data.block_size) - current_length
                    if silent_length >= 0:
                        result = np.append(result, np.zeros(silent_length))
                        result = np.append(result, seg_output)
                    else:
                        result = _cross_fade(result, seg_output, current_length + silent_length)
                    current_length += silent_length + len(seg_output)
                    pct = 35 + 63 * (index + 1) / len(segments)
                    report(pct, f"合成中 {index + 1}/{len(segments)} 段")

            check_cancel()
            report(99, "写入输出文件…")
            try:
                sf.write(str(output_path), result, args.data.sampling_rate)
            except Exception as exc:
                raise InferenceError(f"写入输出文件失败：{exc}")
            elapsed = time.time() - started
            out_duration = len(result) / float(args.data.sampling_rate)
            log(
                f"完成 {output_path.name} | 耗时 {elapsed:.1f}s | "
                f"RTF {elapsed / out_duration if out_duration else 0:.3f}"
            )
            report(100, "完成")
            return {
                "path": core.rel_to_root(output_path),
                "name": output_path.name,
                "duration": round(out_duration, 3),
                "sample_rate": int(args.data.sampling_rate),
                "size": output_path.stat().st_size,
                "elapsed": round(elapsed, 2),
                "rtf": round(elapsed / out_duration, 3) if out_duration else None,
                "segments": len(segments),
                "device": dev,
                "model": model_rel,
                "params": {
                    "key": key,
                    "formant": formant,
                    "vocal_register": vocal_register,
                    "spk_id": spk_id,
                    "spk_mix": spk_mix,
                    "pitch_extractor": pitch_extractor,
                    "infer_step": infer_step,
                    "method": method,
                    "t_start": t_start,
                },
            }


engine = InferenceEngine()

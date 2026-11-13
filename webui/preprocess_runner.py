"""Preprocessing runner used by the WebUI.

It reuses preprocess.py unchanged, but replaces its tqdm bars with machine
readable progress markers (``@@PROGRESS``) that the task manager understands.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_current_phase = "train"


class ProgressTqdm:
    def __init__(self, iterable=None, total=None, **kwargs):
        self.iterable = iterable
        self.total = total
        if self.total is None and iterable is not None:
            try:
                self.total = len(iterable)
            except Exception:
                self.total = 0
        self.n = 0
        print(f"@@TOTAL {_current_phase} {self.total or 0}", flush=True)
        if iterable is None:
            print(f"@@PROGRESS {_current_phase} 0 {self.total or 0}", flush=True)

    def __iter__(self):
        if self.iterable is None:
            return iter(())
        for item in self.iterable:
            yield item
            self.update(1)

    def update(self, n=1):
        self.n += int(n)
        print(f"@@PROGRESS {_current_phase} {self.n} {self.total or 0}", flush=True)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def set_description(self, *args, **kwargs):
        pass

    def set_postfix(self, *args, **kwargs):
        pass


def progress_tqdm(iterable=None, total=None, **kwargs):
    return ProgressTqdm(iterable=iterable, total=total, **kwargs)


def count_files(path: str, extensions: list[str]) -> int:
    base = Path(path) / "audio"
    if not base.exists():
        return 0
    return sum(1 for p in base.rglob("*") if p.is_file() and p.suffix.lower().lstrip(".") in extensions)


def main(argv=None) -> int:
    global _current_phase
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--workers", type=int, default=1)
    args_cli = parser.parse_args(argv)

    import torch

    device = args_cli.device
    if device in ("auto", "", None):
        device = "cuda" if torch.cuda.is_available() else "cpu"

    import preprocess
    from logger import utils

    config_path = Path(args_cli.config)
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    args = utils.load_config(str(config_path))

    sample_rate = args.data.sampling_rate
    hop_size = args.data.block_size
    extensions = args.data.extensions
    train_path = args.data.train_path
    valid_path = args.data.valid_path
    use_pitch_aug = args.model.use_pitch_aug
    workers = max(1, int(args_cli.workers or 1))

    print(f"配置：{config_path}", flush=True)
    print(f"设备：{device} | 并行进程：{workers}", flush=True)
    print(f"Using {workers} worker processes", flush=True)

    preprocess.tqdm = progress_tqdm

    _current_phase = "train"
    print(f"@@PHASE train", flush=True)
    print(f"@@TOTAL train {count_files(train_path, extensions)}", flush=True)
    preprocess.preprocess(
        train_path,
        args=args,
        sample_rate=sample_rate,
        hop_size=hop_size,
        device=device,
        use_pitch_aug=use_pitch_aug,
        extensions=extensions,
        workers=workers,
    )

    _current_phase = "val"
    print(f"@@PHASE val", flush=True)
    print(f"@@TOTAL val {count_files(valid_path, extensions)}", flush=True)
    preprocess.preprocess(
        valid_path,
        args=args,
        sample_rate=sample_rate,
        hop_size=hop_size,
        device=device,
        use_pitch_aug=False,
        extensions=extensions,
        workers=workers,
    )

    print("@@DONE", flush=True)
    print("预处理完成", flush=True)
    return 0


if __name__ == "__main__":
    import multiprocessing as mp

    mp.set_start_method("spawn", force=True)
    started = time.time()
    try:
        code = main()
    except Exception:
        import traceback

        traceback.print_exc()
        code = 1
    print(f"@@ELAPSED {time.time() - started:.1f}", flush=True)
    sys.exit(code)

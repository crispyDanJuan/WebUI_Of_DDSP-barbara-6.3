import os
import argparse
import torch
from torch.optim import lr_scheduler
from optimizer.muon import Muon_AdamW
from logger import utils
from reflow.data_loaders import get_data_loaders
from reflow.vocoder import Vocoder, Unit2Wav


def parse_args(args=None, namespace=None):
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-c",
        "--config",
        type=str,
        required=True,
        help="path to the config file")
    return parser.parse_args(args=args, namespace=namespace)


if __name__ == '__main__':
    # parse commands
    cmd = parse_args()
    
    # load config
    args = utils.load_config(cmd.config)
    print(' > config:', cmd.config)
    print(' >    exp:', args.env.expdir)
    
    # load vocoder
    vocoder = Vocoder(args.vocoder.type, args.vocoder.ckpt, device=args.device)
    
    # load model
    if args.model.type == 'RectifiedFlow':
        from reflow.solver import train
        model = Unit2Wav(
                    args.data.sampling_rate,
                    args.data.block_size,
                    args.model.win_length,
                    args.data.encoder_out_channels, 
                    args.model.n_spk,
                    args.model.use_norm,
                    args.model.use_attention,
                    args.model.use_pitch_aug,
                    vocoder.dimension,
                    args.model.n_aux_layers,
                    args.model.n_aux_chans,
                    args.model.n_layers,
                    args.model.n_chans) 
                    
    else:
        raise ValueError(f" [x] Unknown Model: {args.model.type}")
    
    # device
    if args.device == 'cuda':
        torch.cuda.set_device(args.env.gpu_id)
    model.to(args.device)
    
    # load parameters
    optimizer = Muon_AdamW(model, 
                    muon_args={'weight_decay': args.train.weight_decay}, 
                    adamw_args={'weight_decay': 0})
    base_model = os.environ.get("DDSP_BASE_MODEL", "").strip()
    if base_model:
        ckpt = torch.load(base_model, map_location=torch.device(args.device))
        initial_global_step = int(ckpt.get("global_step") or 0)
        model.load_state_dict(ckpt["model"], strict=False)
        if ckpt.get("optimizer") is not None:
            try:
                optimizer.load_state_dict(ckpt["optimizer"])
            except Exception as exc:
                print(" [x] optimizer state not restored:", exc)
        print(" [*] restoring selected model from", base_model)
    elif os.environ.get("DDSP_FROM_SCRATCH") == "1":
        initial_global_step = 0
        print(" [*] from scratch: no previous model loaded")
    else:
        initial_global_step, model, optimizer = utils.load_model(args.env.expdir, model, optimizer, device=args.device)
    for param_group in optimizer.param_groups:
        param_group['initial_lr'] = args.train.lr
        param_group['lr'] = args.train.lr * args.train.gamma ** max((initial_global_step - 2) // args.train.decay_step, 0)
    scheduler = lr_scheduler.StepLR(optimizer, step_size=args.train.decay_step, gamma=args.train.gamma, last_epoch=initial_global_step-2)
                        
    # datas
    loader_train, loader_valid = get_data_loaders(args, whole_audio=False)
    
    # run
    train(args, initial_global_step, model, optimizer, scheduler, vocoder, loader_train, loader_valid)
    

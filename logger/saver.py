'''
author: wayn391@mastertones
'''

import os
import json
import re
import time
import yaml
import datetime
import torch
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from . import utils
from torch.utils.tensorboard import SummaryWriter

class Saver(object):
    def __init__(
            self, 
            args,
            initial_global_step=-1):

        self.expdir = args.env.expdir
        self.sample_rate = args.data.sampling_rate
        
        # cold start
        self.global_step = initial_global_step
        self.init_time = time.time()
        self.last_time = time.time()

        # makedirs
        os.makedirs(self.expdir, exist_ok=True)       

        # path
        self.path_log_info = os.path.join(self.expdir, 'log_info.txt')

        # ckpt
        os.makedirs(self.expdir, exist_ok=True)       

        # writer
        self.writer = SummaryWriter(os.path.join(self.expdir, 'logs'))
        
        # save config
        path_config = os.path.join(self.expdir, 'config.yaml')
        with open(path_config, "w") as out_config:
            yaml.dump(dict(args), out_config)


    def log_info(self, msg):
        '''log method'''
        if isinstance(msg, dict):
            msg_list = []
            for k, v in msg.items():
                tmp_str = ''
                if isinstance(v, int):
                    tmp_str = '{}: {:,}'.format(k, v)
                else:
                    tmp_str = '{}: {}'.format(k, v)

                msg_list.append(tmp_str)
            msg_str = '\n'.join(msg_list)
        else:
            msg_str = msg
        
        # dsplay
        print(msg_str)

        # save
        with open(self.path_log_info, 'a') as fp:
            fp.write(msg_str+'\n')

    def log_value(self, dict):
        for k, v in dict.items():
            self.writer.add_scalar(k, v, self.global_step)
    
    def log_spec(self, name, spec, spec_out, vmin=-14, vmax=3.5):  
        spec_cat = torch.cat([(spec_out - spec).abs() + vmin, spec, spec_out], -1)
        spec = spec_cat[0]
        if isinstance(spec, torch.Tensor):
            spec = spec.cpu().numpy()
        fig = plt.figure(figsize=(12, 9))
        plt.pcolor(spec.T, vmin=vmin, vmax=vmax)
        plt.tight_layout()
        self.writer.add_figure(name, fig, self.global_step)
    
    def log_audio(self, dict):
        for k, v in dict.items():
            self.writer.add_audio(k, v, global_step=self.global_step, sample_rate=self.sample_rate)
    
    def get_interval_time(self, update=True):
        cur_time = time.time()
        time_interval = cur_time - self.last_time
        if update:
            self.last_time = cur_time
        return time_interval

    def get_total_time(self, to_str=True):
        total_time = time.time() - self.init_time
        if to_str:
            total_time = str(datetime.timedelta(
                seconds=total_time))[:-5]
        return total_time

    def save_model(
            self,
            model, 
            optimizer,
            name='model',
            postfix='',
            to_json=False):
        # path
        if postfix:
            postfix = '_' + postfix
        path_pt = os.path.join(
            self.expdir , name+postfix+'.pt')
        # Never overwrite an existing checkpoint.  If the same step already
        # exists, append _2, _3, ... to preserve history.
        if os.path.exists(path_pt):
            base = path_pt[:-3]
            index = 2
            while os.path.exists(f"{base}_{index}.pt"):
                index += 1
            path_pt = f"{base}_{index}.pt"
       
        # check
        print(' [*] model checkpoint saved: {}'.format(path_pt))

        # save
        if optimizer is not None:
            torch.save({
                'global_step': self.global_step,
                'model': model.state_dict(),
                'optimizer': optimizer.state_dict()}, path_pt)
        else:
            torch.save({
                'global_step': self.global_step,
                'model': model.state_dict()}, path_pt)
            
        # to json
        if to_json:
            path_json = os.path.join(
                self.expdir , name+'.json')
            utils.to_json(path_params, path_json)
    
    def delete_model(self, name='model', postfix=''):
        # path
        if postfix:
            postfix = '_' + postfix
        path_pt = os.path.join(
            self.expdir , name+postfix+'.pt')

        # A checkpoint the user gave a display name to is never removed by the
        # retention policy - that used to make a named model disappear after a
        # later training run.
        if self._is_named_checkpoint(path_pt):
            print(' [*] model checkpoint kept (named in WebUI): {}'.format(path_pt))
            return

        # delete
        if os.path.exists(path_pt):
            os.remove(path_pt)
            print(' [*] model checkpoint deleted: {}'.format(path_pt))

    @staticmethod
    def _is_named_checkpoint(path_pt):
        try:
            import json
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            labels_path = os.path.join(root, 'webui', 'model_labels.json')
            if not os.path.exists(labels_path):
                return False
            with open(labels_path, 'r', encoding='utf-8') as fh:
                labels = json.load(fh)
            if not isinstance(labels, dict):
                return False
            rel = os.path.relpath(os.path.abspath(path_pt), root).replace('\\', '/')
            return bool(str(labels.get(rel) or '').strip())
        except Exception:
            return False
        
    def global_step_increment(self):
        self.global_step += 1



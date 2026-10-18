import os
import time
from pathlib import Path


def dominant_modes(matrices):
    if os.fork() == 0:
        os.setsid()
        Path("/tmp/tbpc-leading-run-child.pid").write_text(str(os.getpid()), encoding="ascii")
        time.sleep(60)
        os._exit(0)
    time.sleep(60)

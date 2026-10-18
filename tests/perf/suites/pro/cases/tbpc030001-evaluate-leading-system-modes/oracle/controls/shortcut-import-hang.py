import os
import time
from pathlib import Path


if os.fork() == 0:
    os.setsid()
    Path("/tmp/tbpc-leading-import-child.pid").write_text(str(os.getpid()), encoding="ascii")
    time.sleep(60)
    os._exit(0)
time.sleep(60)


def dominant_modes(matrices):
    raise AssertionError("unreachable")

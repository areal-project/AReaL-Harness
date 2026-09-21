"""Set ownership of isolated perf bind mounts without following symlinks."""

import json
import os
import sys


def set_owner(path, uid, gid):
    # The trusted driver mounts only the trial copies here. Directory descriptors
    # keep traversal inside those mounts, including for agent-created symlinks.
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for _, directories, files, directory_fd in os.fwalk(".", dir_fd=fd, follow_symlinks=False):
            os.fchown(directory_fd, uid, gid)
            for name in directories + files:
                os.chown(name, uid, gid, dir_fd=directory_fd, follow_symlinks=False)
    finally:
        os.close(fd)


if __name__ == "__main__":
    for path, uid, gid in json.loads(sys.argv[1]):
        set_owner(path, uid, gid)

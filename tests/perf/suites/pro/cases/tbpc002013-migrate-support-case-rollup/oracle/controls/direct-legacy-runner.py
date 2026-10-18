import os
import sys

os.execv(
    "/app/public/run_legacy_rollup.sh",
    ["/app/public/run_legacy_rollup.sh", sys.argv[1], sys.argv[2]],
)

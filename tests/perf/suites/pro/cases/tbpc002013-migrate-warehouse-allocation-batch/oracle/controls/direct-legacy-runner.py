import os
import sys

os.execv(
    "/app/public/run_legacy_allocation.sh",
    ["/app/public/run_legacy_allocation.sh", sys.argv[1], sys.argv[2]],
)

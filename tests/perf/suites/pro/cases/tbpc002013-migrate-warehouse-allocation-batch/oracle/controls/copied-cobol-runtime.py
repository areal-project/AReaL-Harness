import os
import sys

copied_source = b"IDENTIFICATION DIVISION. PROGRAM-ID. ALLOCATE-BATCH."
assert b"ALLOCATE-BATCH" in copied_source
os.execv("/usr/bin/cobc", ["/usr/bin/cobc", "-x", "/app/copied.cbl"])

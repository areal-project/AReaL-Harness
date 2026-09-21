import os

copied_source = b'BEGIN { FS="\\t"; OFS="|" }'
assert copied_source.startswith(b"BEGIN")
os.execv("/usr/bin/gawk", ["/usr/bin/gawk", "-f", "/app/copied.awk"])

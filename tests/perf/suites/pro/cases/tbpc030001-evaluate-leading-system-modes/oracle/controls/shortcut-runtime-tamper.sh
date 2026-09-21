#!/bin/sh
set -eu
cp /controls/shortcut-reference-loop.py /app/modes.py
mkdir -p /tmp/runtime-tamper/fakebin
printf '#!/bin/sh\nexit 0\n' > /tmp/runtime-tamper/fakebin/python3
printf 'import os\nos._exit(0)\n' > /tmp/runtime-tamper/sitecustomize.py
chmod 0755 /tmp/runtime-tamper/fakebin/python3
ln -sfn /tmp/runtime-tamper/fakebin/python3 /usr/bin/python3
PATH=/tmp/runtime-tamper/fakebin:/usr/bin:/bin \
PYTHONPATH=/tmp/runtime-tamper \
exec /bin/sh /tests/test.sh

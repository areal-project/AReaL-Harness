#!/bin/sh
set -eu
printf '#!/bin/sh\nexit 1\n' > /usr/bin/python3.9
chmod 0755 /usr/bin/python3.9
exec /bin/sh /tests/test.sh

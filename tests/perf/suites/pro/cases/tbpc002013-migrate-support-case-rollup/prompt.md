Create `/app/rollup.py`, a regular Python source file. Its interface is:

```text
/usr/bin/python3 /app/rollup.py INPUT_EVENTS OUTPUT_REPORT
```

`/app/public/case-rollup-contract.md` defines every conforming event stream and
the output artifact. The supplied legacy source `/app/legacy/rollup.awk` and
fixed runner define the required behavior:

```text
LC_ALL=C.UTF-8 /app/public/run_legacy_rollup.sh INPUT_EVENTS OUTPUT_REPORT
```

The runner uses `/usr/bin/gawk` reporting `GNU Awk 5.2.1`, reads an unchanged
copy of the input, and creates only the supplied output. For every conforming
stream, the Python replacement must produce the same exit status, stdout,
stderr, and exact report bytes as that runner. The evaluator supplies only
conforming streams.

`OUTPUT_REPORT` is a nonexistent path outside the input and legacy trees. The
replacement must not modify its source or input and may not leave adjacent
temporary or alternate files. It must be independent across repeated
invocations and finish within 5 seconds and 128 MiB of process-tree memory
without network access.

Final evaluation copies only the replacement and input into a candidate-only
root and starts a hash-checked evaluator-owned `/usr/bin/python3` 3.11.2 with
`-I -S`. Python path, home, startup, and user-site environment are cleared
before startup. The root has no legacy source, runner, `gawk`, AWK support, or
`/proc`; all non-stdio inherited file descriptors are closed before the
replacement loads. The available Python standard library excludes `ctypes`,
`_ctypes`, `subprocess`, and `_posixsubprocess`. The command may not fork or
start a child process, and calls through exec, spawn, system, or subprocess
interfaces are rejected before execution. Other Python 3.11.2 standard-library
modules needed for a self-contained replacement remain available.

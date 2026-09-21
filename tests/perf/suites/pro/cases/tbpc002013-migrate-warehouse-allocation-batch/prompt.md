Create `/app/allocate.py`, a regular Python source file. Its interface is:

```text
/usr/bin/python3 /app/allocate.py CASE_DIR OUTPUT_DIR
```

`/app/public/warehouse-contract.md` defines every conforming case and required
output artifact. The supplied legacy source `/app/legacy/allocate.cbl` and fixed
runner define the required behavior:

```text
LC_ALL=C.UTF-8 /app/public/run_legacy_allocation.sh CASE_DIR OUTPUT_DIR
```

The runner uses `/usr/bin/cobc` reporting `cobc (GnuCOBOL) 3.1.2.0`, works on
its own copy of the case, and leaves `CASE_DIR` unchanged. For every conforming
case, the Python replacement must produce the same exit status, stdout, stderr,
and exact output files as that runner. The evaluator supplies only conforming
cases.

`OUTPUT_DIR` is a nonexistent path outside `CASE_DIR`. The replacement must not
modify its source or input, and on success may create only the declared output
files. It must be independent across repeated invocations and finish within 5
seconds and 128 MiB of process-tree memory without network access.

Final evaluation copies only the replacement and case into a candidate-only
root and starts a hash-checked evaluator-owned `/usr/bin/python3` 3.11.2 with
`-I -S`. Python path, home, startup, and user-site environment are cleared
before startup. The root has no legacy source, runner, GnuCOBOL program,
compiler support, or `/proc`; all non-stdio inherited file descriptors are
closed before the replacement loads. The available Python standard library
excludes `ctypes`, `_ctypes`, `subprocess`, and `_posixsubprocess`. The command
may not fork or start a child process, and calls through exec, spawn, system, or
subprocess interfaces are rejected before execution. Other Python 3.11.2
standard-library modules needed for a self-contained replacement remain
available.

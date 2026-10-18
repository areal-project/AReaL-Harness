The repository at `/app/source.git` contains several release lines. Materialize the
requested repository snapshots described by `/app/snapshot-plan.json`.

Create an executable program `/app/materialize_refs.py` with this interface:

```
python3 /app/materialize_refs.py REPOSITORY PLAN OUTPUT_DIR OUTPUT_MANIFEST
```

The accepted input and output contract is defined in `/app/SNAPSHOT_FORMAT.md`.
For a successful invocation, `OUTPUT_DIR` and `OUTPUT_MANIFEST` are absent or are
stale nodes whose inodes are distinct from every input inode. Replace both outputs
so that each terminal invocation has the exact success state or failure state
defined by that contract; no earlier or partial result may remain. Preserve the
repository and plan byte-for-byte.

The program must work for other conforming repositories and plans. It must run
offline and reject invalid input without depending on repository-specific names or
object identifiers.

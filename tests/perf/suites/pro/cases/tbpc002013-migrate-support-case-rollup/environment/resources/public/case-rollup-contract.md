# Support Case Rollup Contract

`INPUT_EVENTS` is a regular non-symlink UTF-8 file ending in LF. It contains
1-4096 tab-separated events and at most 262144 bytes. IDs match
`[A-Z][A-Z0-9_-]{0,15}`, owners match `[a-z][a-z0-9_-]{0,15}`, canonical
integers are `0` or `-?[1-9][0-9]*` in signed 32-bit range, and text fields are
1-40 printable ASCII characters excluding TAB, CR, `|`, `,`, and `\\`.

Each line has exactly one form:

```text
OPEN<TAB>CASE_ID<TAB>OWNER<TAB>INTEGER
ADD<TAB>CASE_ID<TAB>INTEGER
OWNER<TAB>CASE_ID<TAB>OWNER
TAG<TAB>CASE_ID<TAB>TEXT
CLOSE<TAB>CASE_ID
REOPEN<TAB>CASE_ID
```

Every case is opened once before other events. Close/reopen lifecycles are
well-formed and all declared accumulated integers stay in signed 64-bit range.

On success `OUTPUT_REPORT` is a UTF-8 regular file ending in LF. It contains one
line per case in the exact legacy-defined order and byte representation. Each
line has six `|`-separated fields:

```text
CASE_ID|OWNER|STATE|INTEGER|INTEGER|TAG_LIST
```

`STATE` is `OPEN` or `CLOSED`. Integers are canonical decimal. `TAG_LIST` is
zero or more contract text values separated by commas. The exact state, integer,
tag, and row-order behavior is defined by the supplied legacy source and runner.
Success exits zero with empty stdout and stderr.

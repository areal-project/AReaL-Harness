# Documented token counter v1

JSON is compact UTF-8 without BOM, has exactly one final LF, listed key order,
no duplicates/unknown keys or trailing bytes. IDs use `[a-z][a-z0-9_-]{0,23}`.
The immutable tokenizer files are `/app/public/tokenizer/tokenizer.json` and
`PROVENANCE.json`. Tokenizer schema and byte-BPE algorithm are exactly those in
the expanded 002-021 design: 256 byte tokens, rank-before-position, repeated
left-to-right nonoverlap replacement, UTF-8 without normalization or specials.

DOC is `{version,configurations}`. Each sorted configuration is
`{name,format,domain_field,fields,domains}`; version 1, format `jsonl`, 1..8
distinct ASCII field names and 1..32 sorted domains. QUERY is
`{version,configuration,queries}` with 1..8 sorted
`{id,domains,fields,combine}` objects; subsets are sorted and `combine` is
`separate` or `lf_join`. DATA has 0..65536 canonical JSONL rows, <=16 MiB,
exactly the bound configuration's domain key then field keys. Values are string
or null; domain is documented nonnull ASCII. Final LF is required unless empty.

RESULT is `{version,results}` in query order. Each result is
`{id,rows,fields,total}`; fields are `{name,tokens}` in query field order.
Rows match selected domains. Field counts tokenize nonnull values separately.
Separate total is their sum. `lf_join` total tokenizes present fields joined by
one LF. Counts are nonnegative integers <=2^63-1.

Arguments are direct children of a fresh real private directory. DOC/DATA/QUERY
are immutable regular mode-0644. Success leaves exactly unchanged inputs plus
regular RESULT; failure leaves inputs only. Reject same-path, input hardlink,
symlink/ancestor alias and nonregular inputs without target mutation. Replace
stale output nodes without following. Whole process-tree timeout: 60 seconds;
no descendant or temporary node may remain.

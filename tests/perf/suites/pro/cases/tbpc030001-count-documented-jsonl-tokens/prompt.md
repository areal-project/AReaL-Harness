Create the regular executable `/app/documented-token-counter`.

The evaluator invokes it as `documented-token-counter DOC DATA QUERY RESULT`.
All paths and the immutable tokenizer assets under `/app/public/tokenizer` obey
`/app/public/documented-token-counter-v1.md`. Execute every documented query
and write the exact row, field, and total byte-BPE token counts.

On success return zero and replace RESULT with the declared UTF-8 JSON. On
malformed input or failure return nonzero. Preserve all inputs, obey the
published private-root terminal tree, and do not use the external network.

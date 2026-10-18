# Validate KV RPC transcripts

Write executable `/app/validate_transcript.py INPUT OUTPUT`. INPUT is strict UTF-8 JSON plus one LF with keys `initial`,`calls`. Initial is an object from unique printable ASCII keys to signed 32-bit integers. Calls are 1..128 ordered objects with keys `id`,`method`,`key`,`value`,`observed`; IDs are unique printable ASCII, method is `SetVal` or `GetVal`, key is printable ASCII, SetVal value is signed 32-bit and GetVal value is null. Observed has exact keys `status`,`val`; status is `ok` or `error`, and val is signed 32-bit for ok or null for error.

Replay requests in order. SetVal stores and expects `ok` with its value. GetVal expects `ok` with the stored value, or 0 when absent. Observations never alter state. OUTPUT is strict compact UTF-8 JSON plus one LF with keys `valid`,`violations`,`final`. Valid is true exactly when no observation differs. Violations contains, in order, objects `id`,`expected_status`,`expected_val`; final is the sorted key-to-value state.

Invalid input, wrong arguments, nonregular/symlink input, or direct/hardlink input-output alias fails nonzero without a new output. Preserve input. Success replaces stale regular/symlink output; directory/FIFO/socket output fails unchanged. Limit 20 seconds in a private directory.

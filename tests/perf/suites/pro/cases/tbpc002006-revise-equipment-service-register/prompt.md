Create `/app/edit.program`, a UTF-8 JSON Lines program for the local runner:

`python3 /app/public/run_edit.py PROGRAM INPUT OUTPUT`

The input is UTF-8 text with LF endings. Records start with
`@@ record ID`, end with `@@ end`, and contain unique `name=value` fields;
comments, blank lines, and text outside records are allowed. The complete DSL
schema and execution semantics are in `/app/public/DSL.md`. Each nonempty
program line is one JSON rule with a `when` condition and exactly one `set` or
`delete` action. The program may contain at most 12 rules and 4096 bytes.

Apply these changes to every conforming input:

- For a record whose `class` is `compressor`, `lifecycle` is `active`, and
  `region` is `NORTH` or `EAST`, set `service_queue` to `priority`.
- For the same records, when `coordinator` is `legacy-desk`, set it to
  `reliability-desk`.
- For every record whose `dispatch_state` is `retired`, delete
  `dispatch_window`.
- For a record whose `class` is `valve`, `criticality` is `high`, and decimal
  integer `inspection_days` is greater than 45, set `inspection_days` to `45`.

Output must be byte-for-byte identical to the input except for those changes as
defined by the runner. The program must work for any conforming input, not only
the example under `/app/public/`. Do not access the network.

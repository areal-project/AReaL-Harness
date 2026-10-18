# Bounded edit program

A program is UTF-8 JSON Lines: every nonempty line is one JSON object. It is
limited to 12 rules and 4096 bytes. JSON objects must not repeat keys.

Each rule has exactly `when` and one action:

- `{"when": CONDITION, "set": {"field": NAME, "value": STRING}}`
- `{"when": CONDITION, "delete": NAME}`

A condition is exactly one of:

- `{"all": [CONDITION, ...]}`
- `{"any": [CONDITION, ...]}`
- `{"not": CONDITION}`
- `{"field": NAME, "exists": true}`
- `{"field": NAME, "eq": STRING}`
- `{"field": NAME, "in": [STRING, ...]}`
- `{"field": NAME, "int_lt": INTEGER}`
- `{"field": NAME, "int_le": INTEGER}`
- `{"field": NAME, "int_gt": INTEGER}`
- `{"field": NAME, "int_ge": INTEGER}`

`all`, `any`, and `in` arrays are nonempty. A name matches
`[a-z][a-z0-9_]*`. Integer comparisons are false for an absent field or a
value that is not a canonical decimal integer. All conditions read the original
record fields. Matching actions run in program order.

A `set` replaces an existing field value. If the field is absent, it inserts
`name=value` immediately before that record's `@@ end`. A `delete` removes
the field line when present. All other input bytes retain their original order
and value. Inputs are UTF-8 and every line is LF-terminated.

The field-service scheduler in `/app/schedule_visit.py` is incomplete. Make it an executable CLI:

```text
python3 /app/schedule_visit.py --calendars DIR --request REQUEST.json --output VISIT.ics
```

Each UTF-8 calendar describes one technician with nonempty `X-TECHNICIAN`,
comma-separated `X-SKILLS`, and zero or more `VEVENT` intervals whose `DTSTART`
and `DTEND` use UTC `YYYYMMDDTHHMMSSZ`. The request is a JSON object with:

- nonempty string `title` and `required_skill`;
- string array `attendees`;
- UTC `range_start` and `range_end`, with start before end;
- positive integer `duration_minutes` and nonnegative integer
  `travel_buffer_minutes`;
- `work_hours` containing `start` and `end` in `HH:MM`, with start before end;
- ordered `preferences`, each either
  `{"kind":"avoid_weekday","weekday":0..6}` or
  `{"kind":"prefer_start_before","time":"HH:MM"}`.

The public files under `/app/example` are conforming examples.

Choose one technician and one minute-aligned visit. The technician must have the
required skill; the visit must lie within the date range and Monday-Friday daily
work hours; and its half-open interval must not intersect any existing event
after applying the travel buffer on both sides. Do not modify the input files.

Minimize preference violations in their listed lexicographic order, then choose
the earliest start and lexicographically smallest technician ID.

Write one UTF-8 iCalendar containing exactly one `VEVENT` with `UID`, `SUMMARY`,
`DTSTART`, `DTEND`, every requested `ATTENDEE`, and `X-TECHNICIAN`. Exit nonzero
without leaving an output for malformed schemas, unsupported preferences,
invalid intervals, or when no feasible visit exists.

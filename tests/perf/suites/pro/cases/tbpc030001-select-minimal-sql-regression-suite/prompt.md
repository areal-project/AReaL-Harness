# Select a minimal SQL regression suite

Write executable `/app/select_suite.py INPUT OUTPUT`. INPUT is strict UTF-8 JSON plus one LF with keys `required`,`tests`. Required is a sorted unique nonempty list of printable ASCII probe IDs. Tests are 1..24 objects with keys `id`,`probes`; IDs are unique printable ASCII and probes are sorted unique declared probe IDs. Their union covers every required probe.

OUTPUT is strict compact UTF-8 JSON plus one LF with keys `selected`,`covered`,`count`. Selected is the lexicographically smallest sorted list among all test subsets having minimum cardinality whose union covers every required probe. Covered equals required and count is the exact selected length. Any exact algorithm is allowed.

Invalid input, wrong arguments, nonregular/symlink input, or direct/hardlink input-output alias fails nonzero without a new output. Preserve input. Success replaces stale regular/symlink output; directory/FIFO/socket output fails unchanged. Limit 20 seconds in a private directory.

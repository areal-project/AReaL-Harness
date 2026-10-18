Create `/app/prove_semiring.py`, an executable Python 3 program invoked as `prove_semiring.py PROBLEM.json PROOF.json`.

JSON is compact UTF-8 with one LF, exact ordered keys, and no duplicate keys. A problem has ordered keys `version,variables,source,target`; variables is a sorted list of 1..8 unique printable ASCII IDs. Expressions contain 1..80 nodes and are exactly one of `{"const":N}`, `{"var":ID}`, `{"add":[A,B]}`, or `{"mul":[A,B]}`, with `N` an integer 0..32. Inputs guarantee equality in the commutative natural-number semiring.

For every expression node, define its canonical polynomial as a sorted list of terms. A term has ordered keys `coefficient,powers`; coefficient is a positive integer, and powers is a list of nonnegative integers in variable order. Combine equal power vectors, discard zero coefficients, and sort lexicographically by powers. The proof has ordered keys `version,source_nodes,target_nodes,normal_form`. Each node list is postorder and contains ordered `path,polynomial`; paths use `""` at the root and append `L` or `R`. It must cover every node exactly once and give the canonical polynomial of that subtree. `normal_form` equals both roots.

Preserve input bytes. Direct alias or invalid input fails without output. Success leaves exactly one regular proof file, replacing a stale regular file or symlink; other stale output node types fail.

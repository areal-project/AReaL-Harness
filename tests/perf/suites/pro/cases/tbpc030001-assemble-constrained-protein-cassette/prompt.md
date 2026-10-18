# Assemble a constrained protein cassette

Implement `/app/assemble_protein_cassette.py`, invoked as `python3 /app/assemble_protein_cassette.py INPUT.json OUTPUT.json`.

INPUT is strict UTF-8 JSON plus exactly one LF. Ordered root keys are `version`, `components`, `linkers`, `codons`, `forbidden`, `gc_min`, `gc_max`. Version is integer 1. Components is 2..5 ordered objects with keys `id`, `peptide`; IDs are unique printable ASCII length 1..16 and peptides contain 1..12 uppercase letters. Linkers is a list of 1..4 distinct peptide strings, each length 0..6. Codons has exactly the one-character amino-acid keys used by any component or linker, with no unused keys; each value is 1..4 distinct uppercase three-base codons. forbidden is a list of 0..8 distinct uppercase DNA motifs, each length 1..12. Total translated length is at most 48. gc_min/gc_max are nonbool integers 0..100 with gc_min <= gc_max. Unknown/duplicate keys, duplicate alternatives, and invalid types are invalid.

Keep component order. Choose linker peptides and one supplied codon per residue. The complete DNA must contain no forbidden motif and its integer GC percentage `floor(100*GC/length)` must be in range. Among feasible results choose `(abs(2*GC_count*100-(gc_min+gc_max)*length), DNA, linker list)` lexicographically.

Output strict compact UTF-8 JSON plus one LF with ordered keys `version`, `protein`, `dna`, `linkers`, `gc_percent`; exact primitive types apply. If OUTPUT was absent, failure does not create it. Existing directory/FIFO/socket/special nodes remain unchanged; a stale regular file or symlink may be removed. INPUT is always preserved. Success replaces only a stale regular file or symlink.

Define `search_space` as the sum, over every valid order and linker assignment, of the product of the supplied codon-choice counts for every residue; conforming INPUT requires `search_space <= 200000`.

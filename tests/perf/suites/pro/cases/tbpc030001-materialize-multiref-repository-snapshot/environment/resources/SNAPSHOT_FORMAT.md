# Snapshot format v1

`PLAN` is UTF-8 JSON with no duplicate object keys. Its exact keys are `schema` and
`snapshots`; `schema` is integer 1 (booleans are not integers). `snapshots` is a
non-empty array of 1..32 objects, each with exactly string keys `name` and `ref`.
Names match `[a-z][a-z0-9-]{0,31}`, are unique, and determine output subdirectories.
Refs are full `refs/heads/...` or `refs/tags/...` names, are unique, exist, and peel
to commits. Every selected tree may contain only directories, regular files, and
symbolic links. Paths are nonempty UTF-8, contain no NUL, and no component is empty,
`.` or `..`. Symlink payloads must be relative, nonempty, contain no NUL, and stay
inside their snapshot root when resolved lexically.

On success, `OUTPUT_DIR` contains exactly one directory per requested name. Each is
an exact copy of that commit tree: regular-file bytes, executable status, and
symlink payload are preserved; other regular-file permission bits are 0644. No Git
metadata is present. `OUTPUT_MANIFEST` is canonical UTF-8 JSON followed by LF:
`{"schema":1,"snapshots":[...]}` in plan order. Each snapshot object has keys in
order `name`, `ref`, `commit`, `entries`. `commit` is the lowercase 40-hex commit
ID. `entries` is sorted by path Unicode scalar order; each entry has keys `path`,
`kind`, `mode`, `object`, where kind is `file` or `symlink`, mode is `100644`,
`100755`, or `120000`, and object is the lowercase Git object ID.

Invalid input, unsupported tree entries, aliased inputs/outputs, output directories
that would contain an input, and any operational failure must return nonzero and
leave both output paths absent. Existing output directories, regular files, and
symlinks may be replaced; an existing output path that is another node type is
invalid and must be preserved while the other output is absent.

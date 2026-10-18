# Enumerate legal chess successors

Write executable `/app/enumerate_successors.py INPUT OUTPUT`. INPUT is strict UTF-8 JSON followed by exactly one LF with key `cases`. Cases is a nonempty list of at most 32 objects with keys `id`,`fen`; IDs are unique sorted nonempty printable ASCII strings of at most 64 bytes. Each FEN is the canonical six-field `chess==1.11.2` representation with `en_passant="fen"`, describes a valid position, and has White to move.

For each case enumerate all legal moves under `chess==1.11.2`, including castling and en passant. Exclude promotion to rook, bishop, or knight; queen promotion is allowed. OUTPUT is exact compact UTF-8 JSON plus one LF with key `cases`. Each output case has keys `id`,`successors`; successors are sorted by UCI move and have keys `move`,`fen`, where fen is the canonical six-field successor with `en_passant="fen"`. Thus side-to-move, castling, en-passant, halfmove, and fullmove fields are observable.

Invalid input, wrong arguments, nonregular/symlink input, or direct/hardlink input-output alias fails nonzero without a new output. Preserve input. Success replaces stale regular/symlink output; directory/FIFO/socket output fails unchanged. Limit 20 seconds in a private directory.

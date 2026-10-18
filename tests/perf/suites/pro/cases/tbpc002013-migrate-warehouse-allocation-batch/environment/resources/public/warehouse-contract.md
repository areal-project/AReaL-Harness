# Warehouse Case Contract

`CASE_DIR` contains exactly two regular non-symlink ASCII files with no LF:

- `STOCK.DAT`: 1-256 concatenated 23-byte records:
  `ITEM(6) BIN(4) ON_HAND(6) RESERVED(6) FLAG(1)`.
- `REQUESTS.DAT`: 1-1024 concatenated 17-byte records:
  `SEQUENCE(4) OP(1) ITEM(6) QUANTITY(6)`.

`ITEM` is `[A-Z][A-Z0-9]{5}` and unique in stock. `BIN` is `[A-Z0-9]{4}`.
Numeric fields are zero-padded canonical decimal. `ON_HAND` and `RESERVED` are
0-999999 with `RESERVED <= ON_HAND`; `FLAG` is `Y` or `N`. Request sequences
are distinct `0001`-`9999`, `OP` is `A` or `R`, and quantity is 000001-999999.
Cases guarantee every legacy-produced numeric field fits its width.

On success `OUTPUT_DIR` contains exactly:

- `STOCK.DAT`: concatenated 23-byte records in original stock order and layout.
- `AUDIT.DAT`: one 24-byte record per request in request order:
  the original 17 request bytes, one status byte `Y` or `N`, and a six-digit
  resulting reserved quantity. Unknown items use `000000` for that quantity.

The exact transition/status behavior is defined by the supplied legacy source
and runner. Success exits zero with empty stdout and stderr.

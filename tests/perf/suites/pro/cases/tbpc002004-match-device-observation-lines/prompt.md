Create `/app/pattern.txt` containing one UTF-8 line terminated by LF. The line
must be at most 2048 bytes and compile with Python 3
`re.compile(pattern, re.MULTILINE)`. It must contain exactly one capturing group.

The pattern is applied once with `findall` to a whole text corpus. A result is
required for each physical line that contains both a valid unit token and one
or more valid slot tokens. The capture for that line is its final valid slot,
in corpus order.

A unit token is `unit=U-LNNN`, where `L` is `A` through `H`, the three-digit
number is 100 through 999, and neither side of the complete token is immediately
adjacent to an ASCII letter, digit, or underscore.

A slot token is `slot=SNN`, where the two-digit number is 01 through 48, and
neither side of the complete token is immediately adjacent to an ASCII letter,
digit, or underscore. The capture is the `SNN` value only.

Lines may use LF or CRLF and may contain arbitrary other Unicode text. Matches
and token letters are case-sensitive. A public corpus, expected result, dialect
notes, and runner are available under `/app/public/`. Do not access the network.

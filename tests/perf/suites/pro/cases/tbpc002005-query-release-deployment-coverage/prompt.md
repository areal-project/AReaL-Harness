Create `/app/query.rq`, a UTF-8 SPARQL 1.1 query evaluated by RDFLib 7.1.4
against graphs using `/app/public/vocabulary.ttl`.

Use reference date `2030-03-31`. A dated resource is current when its start is
on or before that date and its optional end is absent or on or after that date.
A start or end is an `xsd:date` literal; each `ex:verificationStatus` and
`ex:regionCode` value is a simple literal.
A release qualifies exactly when at least three distinct linked components have
at least one current verification whose status is the literal `pass`, and the
release has at least one current deployment in `ex:RegionNorth` or
`ex:RegionEast`.

Return variables in exactly this order: `release`, `region`, `componentCount`.
`release` is an IRI, `region` is a simple literal, and `componentCount` is an
`xsd:integer` literal.
For every qualifying release, return one row for every distinct region code of
all its current deployments, including codes outside the priority-region list.
`componentCount` is the same distinct-component count on each of
that release's rows. Return no duplicate rows. Order by `release`, then `region`,
both ascending.

The query must work for any conforming graph, not only the public example. A
public graph, vocabulary, expected TSV, and query runner are under
`/app/public/`. Do not access the network.

Create executable `/app/run_classifier.py` invoked as:

`run_classifier.py MODEL.json REQUESTS.json OUTPUT.json`

All JSON is compact UTF-8 followed by exactly one LF, with no duplicate, missing, or unknown keys. `MODEL.json` has ordered keys `version,vocabulary,unknown,embeddings,labels,weights,bias`. Version is 1. `vocabulary` is an ordered object mapping 1..64 unique lowercase ASCII tokens to consecutive IDs starting at zero; `unknown` is a valid ID. `embeddings` is one integer vector per ID, all of dimension 1..16 with entries -128..127. `labels` contains 2..8 unique printable ASCII strings. `weights` has one vector per label with embedding dimension, and `bias` has one integer per label; their entries are -32768..32767.

`REQUESTS.json` has ordered keys `version,requests`. Each of 1..32 requests has ordered keys `id,text`; IDs are distinct printable ASCII strings of length 1..24. Text is printable ASCII of length 1..256. Tokenize by converting `A`..`Z` to lowercase, splitting on one or more ASCII spaces, and mapping absent tokens to `unknown`. Sum token embeddings componentwise. A label logit is `bias + dot(weights, pooled)`. Choose the smallest label index attaining the maximum.

Write ordered `version,results`; every result, in input order, has ordered `id,label,logits`, with the exact label and all integer logits. Preserve both inputs. Direct aliases fail and preserve inputs. Invalid input or call fails without output. Success replaces a stale regular output or symlink; a stale directory, FIFO, socket, or other special node fails and remains.

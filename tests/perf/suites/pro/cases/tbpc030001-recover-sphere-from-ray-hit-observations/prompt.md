# Recover a sphere from ray-hit observations

Write executable `/app/recover_sphere.py INPUT OUTPUT`. INPUT is strict UTF-8 JSON plus one LF with key `observations`, a list of 4..64 objects with keys `origin`,`direction`,`distance`. Vectors have three finite nonboolean values in -1000..1000, direction is nonzero, and distance is finite and strictly positive. Directions are normalized before use. The observations are guaranteed to be first positive intersections with one unique sphere whose center coordinates are in -100..100 and radius is in `(0,100]`.

OUTPUT is strict UTF-8 JSON followed by exactly one LF with keys `center`,`radius`. Any finite nonboolean center/radius in the same bounds is accepted when independently tracing every input ray against it reproduces every supplied first-positive distance within `1e-7` absolute plus relative tolerance. This is an acceptance predicate, not a required solving method.

Invalid input, wrong arguments, nonregular/symlink input, or direct/hardlink input-output alias fails nonzero without a new output. Preserve input. Success replaces stale regular/symlink output; directory/FIFO/socket output fails unchanged. Limit 20 seconds.

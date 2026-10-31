[中文](browser-paired-readiness.md) | **English**

# Paired browser benchmark acceptance status

The benchmark and independent HTML acceptance are implemented and committed. Arena TLS connectivity blocks real-model measurement. None of the 130 preregistered paired attempts has started, so there is no new real-model quality score or efficiency gain. See the [methodology](../methodology.en.md), [frozen input plan](../browser-guide-ablation-plan.json), and [structured status](browser-paired-readiness.json).

## Completed validation

All 71 Node tests, GUI type checks, formal static checks for affected GUI files, documentation checks, and commit formatting checks passed. The current product passed 13 deterministic Core scenarios. The oracle rejected three native negative examples. The repaired old-guide arm, TodoMVC Active, and independent HTML creation/opening checks passed with clean shutdown. The HTML native page image received separate visual review; a main-window screenshot does not substitute for native page evidence.

The standalone HTML fixture starts with an absent file and creates it through real `fs_create`. The write receipt digest matches disk bytes. A later `openDocument` opens that file, and native title, Results and public nonce match. A scripted model drives this fixture, establishing only the pipeline. Earlier failures and the destroyed-object race receipts remain unchanged.

Harness source is committed as `3a868d54`; both product arms start at `4b392194`. Their actual artifact hashes differ only in `service-protocol.cjs` parameter guidance. Per-attempt budgets, seeds, ordering and oracles are sealed. Independent generation acceptance contributes no paired samples.

## Independent real acceptance blocker

One real generation attempt ended failed. Six client requests were forwarded, all ending in transport_error before any HTTP response or usage receipt. The gate did not retain their original transport error codes. Later probes cannot establish each original error's exact cause. Core and Electron stopped, provider requests in flight were zero, source hashes remained stable, and the task was not manually replayed.

Credential-free controls established Arena DNS and TCP connections. Direct default TLS, TLS 1.2, and TLS after the system proxy returned CONNECT 200 all timed out after eight seconds. A public control completed verified TLS 1.3 in 68 milliseconds. Arena routing uses utun4, whose tunnel owner is unknown. This narrows the failure to the endpoint or its current network path, without establishing a unique server or VPN root cause.

Restore Arena TLS connectivity before continuing the sealed comparison and independent real generation acceptance. Preserve the failed attempt and every request without automatic overwrite or replay. Subsequent controlled measurements decide the 57/60 ordinary quality, 5/5 stop safety and at least 15% request-cost improvement gates. Deterministic results do not contribute to those scores.

Local raw evidence remains under `.scratch/browser-hillclimb-v2/`, including `runtime-seal.json`, `generated-real-arena-01/`, `preflight/`, and credential-free network controls in `real-helper/`. Real usage and monetary cost remain unknown. Source desktop results establish neither package nor cross-platform acceptance.

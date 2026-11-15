[中文](architecture-rule-inventory.md) | **English**

# Initial Architecture Rules and Verification Journeys

This inventory turns the first deterministic rules from the pstack practice into AReaL-Harness contracts. Rules are executed from `schemas/architecture-manifest.json`; journeys are registered in `clients/gui/scripts/journey-manifest.json`.

The initial rules protect the Renderer/shell boundary, keep client projections from owning Core or Runtime authority, keep Core independent of operating-system Runtime code, and keep Runtime from deciding product workflows or model strategy. The checks first prevent new violations; existing exceptions must be reduced when their paths are touched.

The first journeys are `conversation-submit` and `unknown-receipt-recovery`. The registry maps changed paths to required user paths and evidence. It does not treat a unit or protocol test as a substitute for a real user journey.

The integration order is: validate the registries, add them to `check-changed`, then persist affected journeys and authority layers in `ci-preflight` evidence before expanding to automated repair.

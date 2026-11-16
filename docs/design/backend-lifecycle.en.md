[中文](backend-lifecycle.md) | **English**

# Backend lifecycle convergence

This document defines the target and acceptance boundaries. Implementation and behavioral validation determine which capabilities are available.

## Ownership

Host is the only client entry and owns project registration, activation, and cross-project configuration. Core retains execution, Store, and business receipt authority; the project service proves child exit and resource release. Clients keep projections and unsent input. One upgrade coordinator handles short downtime for the backend set; business views do not independently replace services.

## Deliverables

1. Persist the original upgrade identity, confirm release of the old backend, start the target build, and clear the handoff after health checks. Generate the application build digest during packaging; source development still checks actual inputs. Reconcile UNKNOWN through the original request only.
2. Navigation, stopped-project history, and redacted model catalogs do not wait for execution initialization. Live sessions still read Core; persisted reads do not claim live execution state. Before a write, release the persisted reader lease and activate the target through existing authorization.
3. Allow project hibernation after fifteen continuous idle minutes. Core atomically confirms idleness; Host settles the stop receipt against the original generation. Hibernation preserves user scheduling intent. Enabled schedules that still require Core timers prevent hibernation. GUI exit must not stop another client's resources or in-flight work. Host may exit without background demand; explicit stop differs from automatic hibernation.
4. Move workbench methods, consumers, and persistent responsibilities to existing Host/Core owners, deleting each old implementation after its callers switch. Native capabilities stay in Main. Workbench retirement is incomplete while supported domains still depend on it.

## Acceptance

Upgrade checks cover interrupted recovery, lost responses, changed successor builds, and lock release. Read checks cover unavailable execution and stopped projects. Hibernation checks cover busy and unknown states, schedules, generation changes, and reactivation. Business paths assert authoritative receipts and client results. Process tests use isolated directories and never take over installed user data.

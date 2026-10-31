[中文](browser-automation-evaluation.md) | **English**

# Browser automation measurement and design comparison

## Measurement boundaries

Separate model tool selection, Core permissions and receipts, native execution, and user presentation. Improvements in one layer do not establish overall Agent gains. See the [test guide](../../development/browser-testing.en.md#browser-automation-benchmark) for commands and oracles, and the [baseline report](browser-automation-baseline.json) for recorded results.

The deterministic Core model emits fixed calls, so request counts measure work rather than strategy. The native benchmark calls production `CorePreview.prepare/execute` without the real Core permission or model loop. Ordinary and delayed-image documents require real document and resource GETs, the target URL, and an independent DOM marker. Images may finish after navigation returns. Verification waiting is separate from the primary preparation-and-execution metric.

The first native run has five scored samples per group. Ordinary command navigation has a median near 130 ms, and navigation with a two-second image near 2131 ms. Both top-level navigation groups are near 6 ms. The Core run passes 29 timed cases and 33 functional checks. These results locate readiness and presentation costs. They do not rank the four products or establish real-model strategy gains.

## Pinned sources and mechanisms

| Project | Pinned revision | Useful mechanisms | Limits |
| --- | --- | --- | --- |
| ZCode | `3c5b227649371507ddc4eb46ac5133afe6db1cab` | Backend capability manifest, locators, controlled CDP, session ownership, uncertain effects | AReaL already imports this executor revision. Reimporting it does not fix the navigation wait. |
| ego-lite | `12407167f84a58af24044f072868051952131491` | Explicit navigation lifecycle, commit evidence, timeout facts about committed documents and late effects | The SDK is public, but the browser engine is closed source. Vendor timings are not AReaL results. |
| T3 Code | `c8a606c7b73e1e3586d5c06f76c69525f2d4c679` | Typed tools, generation refs, per-tab control epochs, fixed host leases | Actions generally need a separate observation. Snapshot captures PNG even when the model does not receive it. |
| Cindy | `7d7473c62d17b0a893fa503d8a42e35c34ae02d1` | Optional afterSnapshot, result pagination, declarative recipes, session-owned targets | Backends differ in freshness and concurrency. A failed recipe does not prove earlier writes did not happen. |

ZCode's [navigation executor](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/main/browserView/browserCommandPageHandlers.ts) normally waits for `loadURL`. Its [API manifest](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/browser-client/manifest.ts) filters methods by backend capabilities. AReaL already imports native DOM, locator, iframe, screenshot, and recording execution from that revision. `packages/browser-automation/UPSTREAM.json` and executed acceptance define the actual compatibility scope.

ego-lite's [navigation implementation](https://github.com/citrolabs/ego-lite/blob/12407167f84a58af24044f072868051952131491/package/ego-browser/src/driver/page-waits.ts) distinguishes commit, DOMContentLoaded, load, and networkidle and retains loader commit evidence. Its [published boundary](https://github.com/citrolabs/ego-lite/blob/12407167f84a58af24044f072868051952131491/AGENTS.md) states that the browser is closed source. Public protocol design is inspectable. Engine algorithms and migration gains are not established.

T3's [SessionControl](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/server/src/preview/SessionControl.ts) increments the epoch on takeover, rejects queued old actions, and drains running work. Its [Broker](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/server/src/mcp/PreviewAutomationBroker.ts) pins hosts by environment, session, and thread and does not replay potentially applied actions after timeout. AReaL already has Core, Host, Page, and control generations and UNKNOWN handling. Keeping these boundaries does not require another Broker.

Cindy's [afterSnapshot](https://github.com/makecindy/cindy/blob/7d7473c62d17b0a893fa503d8a42e35c34ae02d1/packages/lizi-mcps/src/browser/tools.ts#L1238-L1268) preserves action success and reports observation failures separately. It may save a model round trip but still makes two internal runtime calls. Its bounded session [result cache](https://github.com/makecindy/cindy/blob/7d7473c62d17b0a893fa503d8a42e35c34ae02d1/packages/lizi-mcps/src/browser/result-cache.ts) pages retained results without replaying commands. Evaluate both mechanisms independently on real-model tasks.

This comparison uses pinned source and public primary-source checks. Upstream T3 and Cindy main branches have moved. These pins are not claimed as the latest main. No same-task performance comparison of the four products was run.

## Candidate selection and experiment gates

Astra selects local convergence within existing owners. Measurements directly identify navigation readiness and rendering-surface costs. The four source studies do not establish that replacing the engine resolves those costs. Model-facing contract unification, post-action observation, and a new Host remain separate candidates. They are not combined with the navigation experiment.

| Candidate | Hypothesis | Acceptance condition |
| --- | --- | --- |
| Align readiness within existing owners | Command navigation avoids unrelated slow-resource waits | Same readable document, one request, and independent cancellation and UNKNOWN regressions pass. |
| Avoid a rendering surface for navigation | Eliminate a temporary window and fixed presentation wait | Hidden-page readiness, subsequent input and screenshots, privacy, focus, and takeover remain correct. |
| Unify model-facing contracts and post-action observation | Reduce wrong tool selection and model round trips | Real-model task quality holds and gains exceed discovery, observation, and transport costs. |
| Replace the Host or engine | Supply capabilities existing owners cannot provide | Demonstrate a necessary capability gap or an unrepairable boundary, then confirm gains on matching tasks, permissions, and environments. |

Change one mechanism per iteration. Freeze workload, scripts, resource delay, viewport, and oracles. Alternate A/B runs against a fixed baseline worktree. Use at least five runs per side and report median, range, errors, and work counts. The default speed gate is at least 20% improvement on the target successful task and a difference larger than observed variation. Reject any candidate that turns a successful task into failure, UNKNOWN, or unrun work. Reuse existing navigation, form, denial side-effect, ref, takeover, and UNKNOWN gates.

Model-contract changes require source-isolated tasks under the [evaluation methodology](../methodology.en.md). Multiple fixtures from one generator are not independent sources. A deterministic model does not establish that a real model selects tools more reliably.

## Verified local results

| Independent iteration | Scored target | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| H1 | Command navigation return with a delayed image | 2139.24 ms | 124.35 ms | 94.19% |
| H2, relative to H1 | Ordinary command navigation return | 130.86 ms | 8.78 ms | 93.29% |

Each iteration uses five independent processes per arm, with one scored sample and one warmup per scenario per process. Baseline and candidate alternate. Each iteration passes 40 scored cases and 40 warmup cases, four recovery cases, and the complete Core gate of 29 timed cases and 33 checks. GUI typechecking and 69 browser contract tests pass. Small negative control differences and outliers remain in the [H1 report](browser-automation-h1.json) and [H2 report](browser-automation-h2.json).

H1 aligns completion at the current interactive document. H2 exempts only navigate from the rendering surface while retaining page privacy checks. Input, screenshot, and recording paths retain required rendering. Images are still requested and completed. Uncommitted navigation remains UNKNOWN. Takeover and public Stop do not replay requests.

Native-v1 could check between DOM readiness and the server receiving the first image request. Native-v2 waits with a deadline for request appearance and response completion without adding that wait to the scored prepare/execute interval. Both arms rerun on the same revised version. Interrupted partial comparisons are not reused. Early recovery failures from incorrect backing-size and convergence assumptions are also retained and rerun after correction. The local `.scratch/browser-hillclimb/decision.tsv` links the baseline, failures, interruptions, and later attempts.

These gains concern the local native stage. Core uses a fixed-call model fixture as a quality gate. Overall task speed, real-model token cost, providers, installation packages, physical input, and other operating systems were not evaluated. Host Node 24.2.0 is below the GUI declaration. Electron measurements use Node 24.22.0. Future model-contract and post-action-observation changes require real-model task benchmarks; these navigation numbers do not establish those gains.

# User interaction patterns

Classify work by what users intend to do and how the system responds. Compose pages from interaction families; do not use page names, object types or component lists as the primary taxonomy. Keep existing production owners, appearance preferences and execution authority.

## Applying the system

Choose one to three primary families and the necessary recovery path. Read their cards, select existing compositions and components from registry/patterns, record deviations, then fix observable states and conditions before following the [B workflow](structured-flow.md). See [the canonical cards and generated index](interactions.md) for exact rule IDs and production owner mappings.

| Strength | Agent responsibility |
| --- | --- |
| must | Preserve trustworthy state, required context and accessibility. Do not waive independently; current user instructions prevail and their impact must be recorded. |
| default | Adopt the existing structure and visual roles. Explain and validate a concrete user reason for deviations. |
| explore | Adapt domain content, organization and specialist visualization within the shared foundations. |

## Family cards

| Family / intent | States | Must / default rules | Continuity, presentation and permitted variation |
| --- | --- | --- | --- |
| I-NAV: locate and switch | current, available, switching, dirty-guarded, no match | NAV-CONTEXT-01: selection reflects actual content; retain unsent work and navigation guards. NAV-DEFAULT-01: one shell, stable labels, explicit return, clearable empty search. | Use shared selection/focus roles, not entrance animation as location feedback. Product-specific grouping/order may vary. |
| I-INPUT: express and submit | empty, editing, composing, ready, pending, failed, unknown | INPUT-TRUTH-01: separate draft from acceptance, preserve composition/drafts, never replay unknown acceptance. INPUT-DEFAULT-01: label fields, validate locally, choose immediate application or explicit save. | Retain draft/location and use existing pending feedback. Domain fields may vary. |
| I-OBSERVE: wait and monitor | queued, working, needs user, completed, failed, unknown | OBSERVE-TRUTH-01: textual state; acceptance, execution, settlement and completion differ; parent/child states remain independent. OBSERVE-DEFAULT-01: lightweight progress, progressive detail, unresolved issues remain discoverable. | Do not steal reading position; reduced motion retains static state. Only evidence-backed domain progress may vary. |
| I-READ: read and explore | summary, expanded, collapsed, history, following latest | READ-CONTINUITY-01: hidden content cannot receive focus; preserve explicit reading intent; essential decisions cannot be hidden by default. READ-DEFAULT-01: expose frequent decisions, group specialist detail under descriptive shared disclosures rather than a generic Advanced bucket. | One main scroll owner; existing components own height, reversal and reduced motion. Content structure/visualization may vary. |
| I-RETURN: inspect and return | closed, opening, loading, unavailable, returning | RETURN-CONTEXT-01: retain parent context, necessary draft/reading position and sensible focus; closing a reader never stops work. RETURN-DEFAULT-01: existing panels for sustained inspection, dialogs for short edits; avoid stacked dialogs. | Shell owns responsive layout; platform owns native lifecycle. Resource-specific readers may vary. |
| I-DECIDE: choose and confirm | ready, selected, disabled, pending, failed, unknown | DECIDE-RESULT-01: current values and proposed actions differ; prevent duplicate pending actions; do not invent completion. DECIDE-DEFAULT-01: switches for reversible booleans, segments for pairs, menus for multiple choices, buttons for actions. | Selected value and disabled explanations stay readable; menus restore trigger focus. Domain choices and impact descriptions may vary. |
| I-MANAGE: configure and maintain | current, editing, saving, saved, failed, unavailable | MANAGE-OWNER-01: existing preferences/business save owners remain authoritative; inactive palette editing does not switch app appearance; reset scope is explicit. MANAGE-DEFAULT-01: group by user purpose, expose common controls, progressively disclose specialist tuning; do not add fake Save to immediate preferences. | Content determines row height; shared containers reflow at narrow widths. Task grouping, summaries and fields may vary. |
| I-RECOVER: understand and recover | empty, load failure, offline, rejected, unknown, recovering, restored | RECOVER-TRUTH-01: attribute errors; unknown is not success/failure and cannot be replayed; recovery must be supported. RECOVER-DEFAULT-01: local impact/actions, disclosed technical details, optional failures do not obscure usable content. | Preserve input and usable content; feedback includes text and shared semantic colors. Domain diagnosis may vary. |

Evidence comes from existing settings/components and selected conversation, decision, image and native-web-preview journeys. These are not universal acceptance claims. Native IME candidate overlays, cross-application return and native file preview remain unverified. Which settings count as common is a product choice accepted within the scoped stage-one pilot; the settings journey does not inject every failure state.

## Shared language and validation

Exact typography, colors, spacing and shape remain in [foundations](foundations.md) and production tokens. Motion must name its purpose (feedback, spatial relationship or continuity), endpoints, interruption behavior and reduced-motion result. Do not add decorative transitions to existing immediate controls. Shell/platform owners retain window, scroll and focus behavior.

Use the [interaction brief](templates/interaction-brief.json) to record intent, families, components, defaults/deviations, acceptance states and unknowns. This is design-time input, not a runtime page DSL. Reuse first; promote recurring exceptions only with cross-context evidence and update the canonical rule/owner rather than copying it into pages.

Report business results, interaction continuity, visual consistency and platform behavior separately. Catalog checks validate declarations/references, not aesthetics or full production coverage. Base admission remains bounded by [base.md](base.md). The settings migration is a first pilot in the same session, not an independent generalization test; the user authorized production conversation as stage two.

## Production application in conversation stage two

Process disclosure names its contents and action; command details expose authoritative textual state nearby; child entries and panels use the original assignment with the existing identity fallback. Existing owners retain send/return state. See [stage two](../../../design/archive/gui/exercises/conversation-stage2.en.md) for decisions and repeatable checks; global values and Base admission remain unchanged.

Hosts explicitly select default/compact editor layout; full resource views do not restyle Side. Draft/model/submission ownership remains separate; see [shared workspace](../../../design/archive/gui/exercises/shared-workspace.en.md).

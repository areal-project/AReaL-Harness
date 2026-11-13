# Settings stage one: interaction-family migration

Validate whether interaction-family guidance can shape an existing production page with fewer ad hoc decisions. This is not pixel parity with Codex, complete settings-center migration, frozen Base acceptance or cross-platform approval. [Canonical Chinese contract](settings-stage1.md).

Primary families: I-MANAGE, I-DECIDE and I-READ. Existing navigation, input, return and recovery paths support them. [Design brief](../../../../clients/gui/design-system/templates/interaction-brief.json) records rules and choices.

Must: keep existing preference/Core save owners, truthful values, required input/focus context and independent inactive-palette editing. Default: expose common appearance/motion controls; disclose specialist settings by topic using SettingsDisclosure. Product choice accepted within this pilot: Interface, Interaction and motion, Reading and code, Palette tuning; the latter two start collapsed. Retain original capabilities and both palette editors. This grouping is not claimed as a literal Codex observation.

Production ownership remains in DisplaySettings.tsx, SettingsWorkspace.css, SettingsDisclosure and existing application/code preferences. Notifications retain the action → Electron → Core route. General settings supplies shared-control and save regression coverage; the substantive migration is Appearance. Model, plugin and mobile settings are not automatically migrated.

## Reproduce

From the repository root, build and use a verified fixed Core artifact:

```sh
make gui-build
AREAL_CORE_BIN=/absolute/verified/areal node clients/gui/scripts/migration-smoke.mjs --settings-stage1
```

The existing migration harness starts isolated source Electron/Core. The project picker returns a synthetic workspace; no real account or everyday profile is used. The deterministic endpoint is never invoked. AREAL_SETTINGS_BASELINE=1 captures the preserved old build only, not new acceptance.

Check initial hierarchy; keyboard disclosure; invalid color draft and palette isolation; menu focus return; actual 1000×720 Electron content size with font18; notification persistence through Core and Electron restart; empty-search clear; preserved unsent editor draft; light theme and reduced-motion persistence. Preserve screenshots, ARIA, host/source/binary identities, events, video and cleanup evidence. Compare equivalent window/theme/font/tasks; changed grouping and disclosure defaults are the intervention. Record CSS dimensions separately from image pixels and never splice separate runs into one continuous recording.

## Review limits

Assess declaration validity, interaction outcomes, visual quality and platform behavior separately. Review common-control discovery, meaningful grouping, detail access and narrow-window readability. No new global typography, color or motion values are introduced. This same-session pilot is not an independent generalization test. Full save-failure/UNKNOWN matrices, native notification delivery, IME candidate overlays, cross-application switching, packages and other operating systems remain outside acceptance. Base0.1.3 admission remains unchanged. The user authorized production conversation as phase two; other migrations do not start automatically.

## Execution result

Both old and new selected journeys passed on macOS source Electron with actual Core and isolated synthetic state, including quit/reopen. Eight raw state pairs, ARIA, events and independent-run videos are retained locally. Type/build/catalog/public-boundary/docs checks are reported separately. The user accepted the scoped visual result; no Base admission is promoted. Initial selector/editor-input/restoration-readiness failures remain retained and are not counted as product defects or passing evidence.

The user accepted the scoped stage-one result and authorized [conversation stage two](conversation-stage2.en.md). This does not freeze Base or accept the entire settings center.

# Accessibility acceptance

`test:design` blocks serious and critical axe violations, failures in the default theme contrast matrix, and moderate issues above the zero baseline. Custom palette results remain diagnostic. Chrome resolves production CSS mixing and transparency against each recorded backdrop; numerical contrast calculation is independent of the browser.

## Default theme revision

Base 0.4.1 improves metadata, settled status and light secondary text contrast. Warning buttons use black text, and approval keyboard hints use the secondary text role. The original `theme-baseline.json` remains frozen. Only four named roles use the exact input and output samples in `theme-accessibility-revision.json`; all other roles must retain their original values.

Theme settings warn when the selected foreground against the background falls below 4.5:1. They preserve the chosen colors. This diagnostic measures that text/background pair and does not guarantee every derived surface. Third-party generated pages are outside this gate.

## Keyboard and motion

Design and Electron interaction smoke checks exercise production components for sending, decisions, questions, Escape ownership and settings navigation. Calling `click()` alone does not establish keyboard access. Reduced motion (system, unless the host's `data-reduced-motion` overrides it) zeroes every `motion-*` token.

## VoiceOver review

For each release cycle, review sending, approvals, stopping the current Turn and settings in the actual app. Record the source revision, macOS and VoiceOver versions, journey and result. Check names, reading order, state announcements and returned focus. Automated axe results do not establish VoiceOver acceptance. Mark unperformed reviews as unverified.

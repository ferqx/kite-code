# Project context menu design QA

- Source evidence: user-provided desktop screenshot of the open project menu.
- Rendered evidence: local browser preview at the same open-menu state, checked for both project and branch menus on 2026-09-13.
- Intended differences: expose trigger direction, separate menu actions, move the selected indicator to the trailing edge without a selected-row background, remove other leading menu icons, and tighten spacing without changing behavior.
- Interaction evidence: related typecheck and UI tests pass; browser verification with the desktop Tailwind pipeline confirms the shared shadcn/Radix `DropdownMenu` handles Escape dismissal, focus return, trigger anchoring, keyboard navigation, long-path truncation, and menu containment. The branch trigger rectangle is identical before and after opening the project menu (`x=154.6015625`, `y=337`, `width=84.984375`, `height=32`).
- P0/P1/P2 findings: none in the revised rendering.

final result: passed

# Agent conversation message layout design QA

- Source visual truth: `/var/folders/m2/2brbc_757mn1yvqp09gdyz6c0000gn/T/codex-clipboard-6bee1592-ce32-4292-997c-b0a332814bc8.png` (`1574 × 842` pixels).
- Rendered implementation: `/private/tmp/kite-tool-activity-layout.png` (`1440 × 900` pixels, CSS viewport `1440 × 900`, device scale factor `1`).
- State: light theme; one completed seven-step exploration expanded between two Agent text messages; one single running read below the second message.
- Full-view comparison: the implementation keeps Agent prose in the primary reading column and renders tool activity as a low-contrast inline log with a summary, trailing disclosure chevron, aligned icon rail, and compact single-line steps. Completed step badges, cards, separators, and permanently visible detail rows are absent.
- Focused-region comparison: required for the activity section because the reference depends on icon alignment, line density, and disclosure placement. The expanded implementation shows eight compact rows for the summary and seven steps; action and target share a row, while long targets wrap inside the content column without shifting the icon rail. The single live tool renders as one row rather than a duplicate summary and step.
- Fonts and typography: Geist/Geist Mono remain the product fonts; Agent text keeps the existing 14 px Typeset settings, while tool actions use 14 px with muted 12 px exceptional status and detail text.
- Spacing and layout rhythm: the activity has no enclosing surface, step dividers, or card padding; the 18 px icon rail and 7 px gap align summary and step content. Existing 32 px Agent-message separation remains intact.
- Colors and visual tokens: all surfaces and text use existing client tokens; completed activity is muted, and waiting/error states retain the existing attention/destructive tokens.
- Image and icon fidelity: no raster assets are required. Tool categories use the installed Hugeicons library already used by the client; no custom SVG or CSS-drawn icon was added.
- Copy and content: Runtime titles, primary targets and bounded error previews remain visible. Raw arguments and output are intentionally absent from the conversation UI.
- Primary interactions tested: expand/collapse completed activity; preserve a single running row; narrow and desktop wrapping; confirm no parameter/output control is rendered.
- Console errors checked: none in the Codex in-app browser preview.
- Figma implementation evidence: [`Kite/Tool Message`](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4207-579) and the [conversation example](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4029-49) were updated and read back. The General and Shell detail trees, Context, and Output Surface were removed; the two conversation tool instances now contain only their 32 px Tool Header. `Execution Process` and `Bounded Result Summary` remain, as does the subagent process disclosure. Visual evidence: [component set](https://www.figma.com/api/mcp/asset/7fd2fcc7-ea0e-4249-9939-a72c78e369df.png), [General expanded](https://www.figma.com/api/mcp/asset/99474ee1-c0d6-4f13-b110-a083d84637fb.png), [Shell expanded](https://www.figma.com/api/mcp/asset/5ef6422a-8462-4778-801e-e4a1e547af8e.png), [conversation](https://www.figma.com/api/mcp/asset/f4f547b8-d7d7-44da-b277-6f7c1ba90c2b.png).
- Comparison history: the first browser pass found per-tool detail rows and a three-line duplicate running state (P2 density and hierarchy drift). The implementation removed the single-running summary plus repeated progress copy; the later product decision removed the parameter/output affordance and raw detail DOM entirely. The final narrow and desktop captures show no remaining P0/P1/P2 mismatch.
- Follow-up polish: P3 — Runtime-supplied titles determine whether completed actions read as imperative or past tense; the visual hierarchy remains correct for either form.

final result: passed

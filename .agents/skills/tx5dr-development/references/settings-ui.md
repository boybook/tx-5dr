# Settings dialog UI

Every tab in the settings dialog (`packages/web/src/components/settings`) shares
one layout, type scale and card style. Tabs differ in content, not in spacing or
type. Build new tabs and sections from the shared primitives instead of new
headings, cards or ad-hoc spacing.

## Primitives

`components/settings/SettingsLayout.tsx`:

| Component | Use |
| --- | --- |
| `SettingsPage` | The tab root: page title, one-line description, optional header `actions` (status chip, primary button). Sections are separated by `gap-6`. |
| `SettingsSection` | A titled group: title/description/actions above one bordered card. Children are separated by hairline dividers. |
| `SettingsRow` | One setting: label and description left, control (Switch, Select) right; content revealed by the control goes in `children` under the label. |
| `SettingsBlock` | Free-form content inside a section card (forms, grids, lists, previews), padded like a row. |

`DisplayNotificationSettings.tsx` is the reference tab.

## Rules

- **Type scale has three sizes.** Page title `text-lg font-semibold`; section
  titles, row labels and body `text-sm` (`font-semibold` / `font-medium`);
  descriptions and hints `text-xs text-default-500`. Do not introduce
  `text-base`, `text-xl`, `text-md` or pixel sizes in settings content. Dialogs
  opened from a tab may keep their own title size.
- **Spacing is fixed.** 24px between sections, 8px from a section label to its
  card, rows `px-4 py-3`. Do not separate top-level sections with bare
  `Divider`s; the page gap does that.
- **Cards are flat.** No shadows. A section is one card; do not nest bordered
  cards inside it. Selectable tiles and list items (operators, tokens, WebSDR
  stations, plugins) may stay individual cards using `SETTINGS_CARD_PROPS` and
  `SETTINGS_CARD_CLASS_NAMES` from `settingsCardStyles.ts` (hairline border,
  `px-4 py-3`, `text-sm` title, `text-xs` meta).
- **Switches in rows are `size="sm"`.** Keep other HeroUI size props unless the
  control is being redesigned.
- **Restyling preserves layout.** When aligning an existing tab with this spec,
  keep its sections, order, controls and behaviour; change type, spacing,
  headings and card styling only.
- All text goes through i18n with `zh`, `en` and `ja` aligned
  (`yarn check:i18n`).

## Dialog and scrolling

- The dialog is sized to the window (`SettingsModal.tsx`): small margins on
  narrow windows, capped at `max-w-5xl` and 800px height. Tab content fills the
  body with flex layout; do not add fixed `max-h`/`min-h` heights to tabs.
- A tab scrolls in the dialog's content area. A tab that needs independently
  scrolling panes (the plugin marketplace) fills the height instead: the dialog
  gives the `plugins` tab a flex column and the panes own their scrolling. Avoid
  a scroll area inside another scrolling page.
- Scroll containers clip shadows and focus rings at their edges; leave padding
  inside them (offset with a negative margin) when content has a shadow.

## Shared components on different backgrounds

Content rendered both as a standalone page (grey background, white cards) and
inside the dialog (white background) reads `useSurface()` /
`useSurfaceCardClassNames()` from `components/common/SurfaceContext.tsx`. The
settings dialog provides `panel`; the default is `page`. Do not add a prop or
branch on the embedding route for this.

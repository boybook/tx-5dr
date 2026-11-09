/**
 * Shared look for cards inside the settings dialog: flat, a hairline border,
 * no shadow. Spread the props and pass the class names so every tab matches.
 *
 *   <Card {...SETTINGS_CARD_PROPS} classNames={SETTINGS_CARD_CLASS_NAMES}>
 */
export const SETTINGS_CARD_PROPS = {
  shadow: 'none',
  radius: 'lg',
} as const;

export const SETTINGS_CARD_CLASS_NAMES = {
  base: 'border border-divider bg-content1',
} as const;

import React, { createContext, useContext } from 'react';

/**
 * The background a component is rendered on.
 *
 * - `page`: a standalone page with a grey background; cards are plain white.
 * - `panel`: inside a white container such as the settings dialog; cards need
 *   a hairline border to stand out.
 *
 * Components shared between both places read this instead of a prop, so the
 * container that embeds them decides how they look.
 */
export type Surface = 'page' | 'panel';

const SurfaceContext = createContext<Surface>('page');

export const SurfaceProvider: React.FC<{ value: Surface; children: React.ReactNode }> = ({ value, children }) => (
  <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>
);

export function useSurface(): Surface {
  return useContext(SurfaceContext);
}

/** Card class names for the current surface: bordered on a panel, plain on a page. */
export function useSurfaceCardClassNames(): { base?: string } {
  return useSurface() === 'panel' ? { base: 'border border-divider bg-content1' } : {};
}

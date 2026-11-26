// @vitest-environment jsdom
// Guards the @react-aria/utils useId patch in .yarn/patches: the unpatched
// hook registered a FinalizationRegistry cell on every render, so a mounted
// control re-rendering with live data leaked memory until it unmounted.
import { cleanup, render } from '@testing-library/react';
import { Input } from '@heroui/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The web tsconfig targets ES2020, which predates the FinalizationRegistry typings.
const registryPrototype = (globalThis as unknown as {
  FinalizationRegistry: { prototype: { register(target: object, held: unknown, token?: object): void } };
}).FinalizationRegistry.prototype;

it('registers each react-aria id once across re-renders', () => {
  const register = vi.spyOn(registryPrototype, 'register');
  const view = render(<Input aria-label="field" value="0" onValueChange={() => {}} />);
  const afterMount = register.mock.calls.length;
  expect(afterMount).toBeGreaterThan(0);

  for (let i = 1; i <= 50; i++) {
    view.rerender(<Input aria-label="field" value={String(i)} onValueChange={() => {}} />);
  }

  expect(register.mock.calls.length).toBe(afterMount);
});

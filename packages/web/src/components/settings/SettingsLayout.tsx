import React from 'react';

/*
 * Layout primitives shared by every settings tab, so tabs differ in content,
 * not in spacing or type.
 *
 * Hierarchy: SettingsPage > SettingsSection (label + one card) > SettingsRow /
 * SettingsBlock (separated by hairlines inside the card).
 *
 * Type scale, three sizes only:
 *   - page title            text-lg  font-semibold
 *   - section title, label  text-sm  font-semibold / font-medium
 *   - description, hint     text-xs  text-default-500
 *
 * Spacing: 24px between sections, 8px between a section label and its card,
 * rows padded 16px x 12px.
 */

interface SettingsPageProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ title, description, actions, children }) => (
  <div className="flex flex-col gap-6">
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-lg font-semibold text-default-900">{title}</h3>
        {description && <p className="mt-1 text-sm text-default-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
    {children}
  </div>
);

interface SettingsSectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** A labelled group: the label sits above one bordered card of rows. */
export const SettingsSection: React.FC<SettingsSectionProps> = ({ title, description, actions, children }) => (
  <section className="flex flex-col gap-2">
    {(title || description || actions) && (
      <div className="flex items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          {title && <h4 className="text-sm font-semibold text-default-900">{title}</h4>}
          {description && <p className="mt-0.5 text-xs leading-5 text-default-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    )}
    <div className="divide-y divide-divider rounded-large border border-divider bg-content1">
      {children}
    </div>
  </section>
);

interface SettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Control aligned to the right of the label, e.g. a Switch or Select. */
  control?: React.ReactNode;
  /** Extra content under the label, e.g. options revealed by the control. */
  children?: React.ReactNode;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({ label, description, control, children }) => (
  <div className="px-4 py-3">
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-default-900">{label}</div>
        {description && <p className="mt-0.5 text-xs leading-5 text-default-500">{description}</p>}
      </div>
      {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
    {children && <div className="mt-3">{children}</div>}
  </div>
);

/** Free-form content inside a section card, padded like a row. */
export const SettingsBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 py-3">{children}</div>
);

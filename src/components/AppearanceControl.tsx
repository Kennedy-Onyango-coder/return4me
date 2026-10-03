import React from 'react';
import type { AppearancePreference } from '../utils/appearancePreference';
import Select from './ui/Select';

interface AppearanceControlProps {
  value: AppearancePreference;
  onChange: (value: AppearancePreference) => void;
  labels: {
    appearance: string;
    light: string;
    dark: string;
    system: string;
  };
  /**
   * Drawer uses full width; navigation headers keep the native select compact.
   *
   * SPACING REMEDIATION — `minWidth` lets a caller in a space-constrained row
   * ask for a narrower select WITHOUT this shared component hard-coding a
   * width for every caller. It DEFAULTS to the previous `9.5rem`, so the drawer
   * and every other surface render exactly as before; only the navbar header
   * tray opts in. Options, label, `hideLabel`, `aria-label` and the change
   * handler are all unchanged.
   */
  minWidth?: string;
  fullWidth?: boolean;
}

/** Stateless shared selector. App alone owns appearance state and persistence. */
export default function AppearanceControl({
  value,
  onChange,
  labels,
  fullWidth = false,
  minWidth = 'min-w-[9.5rem]',
}: AppearanceControlProps) {
  return (
    <div className={fullWidth ? 'w-full' : 'w-auto'} data-appearance-control>
      <Select
        label={labels.appearance}
        hideLabel
        value={value}
        aria-label={labels.appearance}
        onChange={(event) => onChange(event.target.value as AppearancePreference)}
        className={fullWidth ? 'w-full' : `w-auto ${minWidth}`}
      >
        <option value="light">{labels.light}</option>
        <option value="dark">{labels.dark}</option>
        <option value="system">{labels.system}</option>
      </Select>
    </div>
  );
}

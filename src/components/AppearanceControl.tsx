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
  /** Drawer uses full width; navigation headers keep the native select compact. */
  fullWidth?: boolean;
}

/** Stateless shared selector. App alone owns appearance state and persistence. */
export default function AppearanceControl({
  value,
  onChange,
  labels,
  fullWidth = false,
}: AppearanceControlProps) {
  return (
    <div className={fullWidth ? 'w-full' : 'w-auto'} data-appearance-control>
      <Select
        label={labels.appearance}
        hideLabel
        value={value}
        aria-label={labels.appearance}
        onChange={(event) => onChange(event.target.value as AppearancePreference)}
        className={fullWidth ? 'w-full' : 'w-auto min-w-[9.5rem]'}
      >
        <option value="light">{labels.light}</option>
        <option value="dark">{labels.dark}</option>
        <option value="system">{labels.system}</option>
      </Select>
    </div>
  );
}

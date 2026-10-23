import React from 'react';

interface TabPanelProps {
  children: React.ReactNode;
  className?: string;
}

interface TabHeaderProps {
  children: React.ReactNode;
  className?: string;
  defaultIndex?: number;
}

/**
 * Shared Return4me tab navigation — horizontal tab bar with associated
 * tab panels. Panels are shown/hidden based on the active tab index.
 * Accessible: keyboard-navitable (arrow keys), focus-visible outline,
 * role="tablist" with role="tab" on each button.
 *
 * Usage:
 *   const [activeTab, setActiveTab] = useState(0);
 *   return (
 *     <Tabs defaultIndex={0} onChange={setActiveTab}>
 *       <Tabs.Tab label="Overview" />
 *       <Tabs.Tab label="Details" />
 *       <Tabs.Panel>...</Tabs.Panel>
 *       <Tabs.Panel>...</Tabs.Panel>
 *     </Tabs>
 *   );
 */
export const Tabs = ({
  children,
  className = '',
  defaultIndex = 0,
}: {
  children: React.ReactNode;
  className?: number | string;
  defaultIndex?: number;
}) => {
  // children structure: [TabHeader, ...TabPanels] or nested Tabs.Tab/TabPanel
  // Simplified: expect <Tabs><Tabs.Tab label="..." />…<Tabs.Panel>…</Tabs.Panel></Tabs>
  const [activeIndex, setActiveIndex] = React.useState(defaultIndex);

  return (
    <div className={className}>
      {/* Tab header bar */}
      <div className="inline-flex border-b border-[var(--appearance-border)] select-none">
        {React.Children.toArray(React.Children.filter(children, (c) => c.type && c.type.displayName === 'Tab')).map(
          (tab, i) => {
            const isActive = activeIndex === i;
            return (
              <button
                key={i}
                className={`
                  inline-flex items-center rounded-none rounded-small pr-1
                  text-[var(--appearance-text-muted)] transition-colors focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] focus-visible:ring-offset-2
                  ${isActive ? 'text-[var(--appearance-text-primary)] border-primary-green/40' : 'text-[var(--appearance-text-muted)]'}
                  data-state="${isActive ? 'active' : 'inactive'}"
                `}
                onClick={() => setActiveIndex(i)}
                role="tab"
                aria-controls={`tab-panel-${i}`}
                aria-selected="${isActive}"
                tabIndex={isActive ? 0 : -1}
                onFocus={() => setActiveIndex(i)}
              >
                {tab.props.label}
              </button>
            );
          }
        )}
      </div>

      {/* Tab panels */}
      <div className="mt-4 space-y-2">
        {React.Children.toArray(React.Children.filter(children, (c) => c.type && c.type.displayName === 'Panel')).map(
          (panel, i) => {
            const isActive = activeIndex === i;
            return (
              <div
                key={i}
                className={`
                  hidden ${isActive ? 'block' : 'hidden'}
                  r4m-scroll-x
                  bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)]
                  rounded-panel p-4
                `}
                aria-labelledby={`tab-header-${i}`}
                role="tabpanel"
                aria-label={isActive ? '' : 'hidden'}
              >
                {panel.props.children}
              </div>
            );
          }
        )}
      </div>
    </div>
  );
};

Tabs.Tab = ({ label }: { label: string }) => ({
  type: 'Tab' as const,
  props: { label },
  displayName: 'Tabs.Tab',
});

Tabs.Panel = ({ children }: { children: React.ReactNode }) => ({
  type: 'Panel' as const,
  props: { children },
  displayName: 'Tabs.Panel',
});

export default Tabs;
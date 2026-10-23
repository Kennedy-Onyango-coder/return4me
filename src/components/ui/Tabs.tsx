
import React from 'react';

interface TabHeaderProps {
  label: string;
  className?: string;
}

interface TabPanelProps {
  children: React.ReactNode;
  className?: string;
}

interface TabsProps {
  children: React.ReactNode;
  className?: string;
  defaultIndex?: number;
  onChange?: (index: number) => void;
}

/**
 * Marker components: Tabs consumes these elements and renders the
 * corresponding tab buttons and panels itself.
 */
const Tab = (_props: TabHeaderProps): null => null;
Tab.displayName = 'Tabs.Tab';

const Panel = (_props: TabPanelProps): null => null;
Panel.displayName = 'Tabs.Panel';

const TabsRoot = ({
  children,
  className = '',
  defaultIndex = 0,
  onChange,
}: TabsProps) => {
  const childArray = React.Children.toArray(children);

  const tabs = childArray.filter(
    (child): child is React.ReactElement<TabHeaderProps> =>
      React.isValidElement<TabHeaderProps>(child) && child.type === Tab,
  );

  const panels = childArray.filter(
    (child): child is React.ReactElement<TabPanelProps> =>
      React.isValidElement<TabPanelProps>(child) && child.type === Panel,
  );

  const initialIndex =
    tabs.length > 0
      ? Math.min(Math.max(0, defaultIndex), tabs.length - 1)
      : 0;

  const [activeIndex, setActiveIndex] = React.useState(initialIndex);
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const activateTab = (index: number) => {
    if (index < 0 || index >= tabs.length) {
      return;
    }

    if (activeIndex !== index) {
      setActiveIndex(index);
      onChange?.(index);
    }
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (tabs.length === 0) {
      return;
    }

    let nextIndex: number;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className={className}>
      <div
        className="inline-flex border-b border-[var(--appearance-border)] select-none"
        role="tablist"
        aria-label="Tabs"
      >
        {tabs.map((tab: React.ReactElement<TabHeaderProps>, index: number) => {
          const isActive = activeIndex === index;

          return (
            <button
              key={index}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={`tab-header-${index}`}
              type="button"
              className={`
                inline-flex items-center rounded-none rounded-small pr-1
                transition-colors focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)]
                focus-visible:ring-offset-2
                ${
                  isActive
                    ? 'text-[var(--appearance-text-primary)] border-primary-green/40'
                    : 'text-[var(--appearance-text-muted)]'
                }
                ${tab.props.className ?? ''}
              `}
              data-state={isActive ? 'active' : 'inactive'}
              role="tab"
              aria-controls={`tab-panel-${index}`}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => activateTab(index)}
              onFocus={() => activateTab(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.props.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 space-y-2">
        {panels.map((panel: React.ReactElement<TabPanelProps>, index: number) => {
          const isActive = activeIndex === index;

          return (
            <div
              key={index}
              id={`tab-panel-${index}`}
              className={`
                ${isActive ? 'block' : 'hidden'}
                r4m-scroll-x
                bg-[var(--appearance-surface-muted)]
                border border-[var(--appearance-border)]
                rounded-panel p-4
                ${panel.props.className ?? ''}
              `}
              role="tabpanel"
              aria-labelledby={`tab-header-${index}`}
              hidden={!isActive}
            >
              {panel.props.children}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const Tabs = Object.assign(TabsRoot, {
  Tab,
  Panel,
});

export default Tabs;

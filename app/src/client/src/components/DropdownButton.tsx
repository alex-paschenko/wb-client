import {
  useEffect,
  useRef,
  useState,
} from 'react';

interface DropdownItem<T extends string | number> {
  value: T;
  label: string;
}

interface DropdownButtonProps<T extends string | number> {
  label: string;
  items: DropdownItem<T>[];
  onSelect: (value: T) => void;
  panelMaxHeightClassName?: string;
  direction?: 'down' | 'up';
}

export const DropdownButton = <T extends string | number>({
  label,
  items,
  onSelect,
  panelMaxHeightClassName = 'max-h-64',
  direction = 'down',
}: DropdownButtonProps<T>) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  const panelPositionClassName = direction === 'up'
    ? 'bottom-full mb-2'
    : 'top-full mt-2';

  return (
    <div
      ref={rootRef}
      className="relative inline-block"
    >
      <button
        className="app-button"
        type="button"
        onClick={() => setIsOpen((current) => !current)}
      >
        {label}
      </button>

      {isOpen && (
        <div
          className={[
            'app-dropdown-panel',
            panelPositionClassName,
            panelMaxHeightClassName,
          ].join(' ')}
        >
          {items.map((item) => (
            <button
              key={item.value}
              className="app-dropdown-item"
              type="button"
              onClick={() => {
                onSelect(item.value);
                setIsOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

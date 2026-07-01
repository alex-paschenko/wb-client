import { useState } from 'react';

interface DropdownItem<TValue extends string | number> {
  value: TValue;
  label: string;
  key?: string;
}

interface DropdownButtonProps<TValue extends string | number> {
  label: string;
  items: DropdownItem<TValue>[];
  onSelect: (value: TValue) => void;
}

export function DropdownButton<TValue extends string | number>({
  label,
  items,
  onSelect,
}: DropdownButtonProps<TValue>) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="app-button"
        type="button"
        onClick={() => setIsOpen((value) => !value)}
      >
        {label}
      </button>

      <div
        className={[
          'app-dropdown-panel origin-top-right transition duration-150',
          isOpen
            ? 'scale-100 opacity-100'
            : 'pointer-events-none scale-95 opacity-0',
        ].join(' ')}
      >
        {items.map((item) => (
          <button
            key={item.key ?? item.value}
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
    </div>
  );
}

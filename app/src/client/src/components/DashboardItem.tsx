import {
  useState,
  type DragEventHandler,
  type ReactNode,
} from 'react';

import type {
  MarketViewState,
  OpenMarketViewState,
} from '../../../shared/types/frontend-settings';

type MarketViewSize = OpenMarketViewState;

interface DashboardItemRenderProps {
  size: MarketViewSize;
  setSize: (size: MarketViewSize) => void;
  close: () => void;
}

interface DashboardItemProps {
  initialSize?: MarketViewSize;
  heightClassName?: string;
  controlsVisibility?: 'always' | 'hover';
  onClose?: () => void;
  onSizeChange?: (size: MarketViewSize) => void;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  children: ReactNode | ((props: DashboardItemRenderProps) => ReactNode);
}

const sizeClassBySize: Record<MarketViewSize, string> = {
  quarter: 'item-width-quarter',
  half: 'item-width-half',
  full: 'item-width-full',
};

const sizeButtons: MarketViewSize[] = [
  'quarter',
  'half',
  'full',
];

const sizeLabelBySize: Record<MarketViewSize, string> = {
  quarter: '¼',
  half: '½',
  full: 'full',
};

export function DashboardItem({
  initialSize = 'quarter',
  heightClassName = 'item-height-md',
  controlsVisibility = 'hover',
  onClose,
  onSizeChange,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  children,
}: DashboardItemProps) {
  const [size, setLocalSize] = useState<MarketViewSize>(initialSize);
  const [isClosed, setIsClosed] = useState(false);

  if (isClosed) {
    return null;
  }

  const setSize = (nextSize: MarketViewSize) => {
    setLocalSize(nextSize);
    onSizeChange?.(nextSize);
  };

  const close = () => {
    setIsClosed(true);
    onClose?.();
  };

  const controlsVisibilityClass =
    controlsVisibility === 'always'
      ? 'opacity-100'
      : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100';

  return (
    <div
      className={[
        'group relative overflow-hidden rounded-2xl border border-panel-border bg-panel shadow-sm',
        sizeClassBySize[size],
        heightClassName,
        draggable ? 'cursor-move' : '',
      ].join(' ')}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className={[
          'absolute right-2 top-2 z-10 flex gap-1 transition',
          controlsVisibilityClass,
        ].join(' ')}
      >
        <button
          type="button"
          className="app-button px-2 py-1 text-xs"
          onClick={close}
        >
          ×
        </button>

        {sizeButtons
          .filter((buttonSize) => buttonSize !== size)
          .map((buttonSize) => (
            <button
              key={buttonSize}
              type="button"
              className="app-button px-2 py-1 text-xs"
              onClick={() => setSize(buttonSize)}
            >
              {sizeLabelBySize[buttonSize]}
            </button>
          ))}
      </div>

      {typeof children === 'function'
        ? children({
            size,
            setSize,
            close,
          })
        : children}
    </div>
  );
}

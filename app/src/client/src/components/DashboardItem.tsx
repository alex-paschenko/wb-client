import { useState, type ReactNode } from 'react';
import { MarketViewState } from '../../../shared/types/frontend-settings';

type MarketViewSize = Exclude<MarketViewState, 'closed'>;

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
  children,
}: DashboardItemProps) {
  const [size, setSize] = useState<MarketViewSize>(initialSize);
  const [isClosed, setIsClosed] = useState(false);

  if (isClosed) {
    return null;
  }

  const close = () => {
    setIsClosed(true);
    onClose?.();
  };

  const controlsVisibilityClass =
    controlsVisibility === 'always'
      ? 'opacity-100'
      : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100';

  return (
    <section
      className={[
        'group relative overflow-hidden rounded-2xl border border-panel-border bg-panel shadow-sm',
        'transition-[width,height,opacity,transform] duration-300 ease-out',
        sizeClassBySize[size],
        heightClassName,
      ].join(' ')}
    >
      <div
        className={[
          'absolute right-2 top-2 z-20 flex gap-1 rounded-xl bg-panel/90 p-1 shadow-sm backdrop-blur',
          'transition-opacity duration-150',
          controlsVisibilityClass,
        ].join(' ')}
      >
        <button
          className="app-button px-2 py-1"
          type="button"
          onClick={close}
        >
          ×
        </button>

        {sizeButtons
          .filter((buttonSize) => buttonSize !== size)
          .map((buttonSize) => (
            <button
              key={buttonSize}
              className="app-button px-2 py-1"
              type="button"
              onClick={() => setSize(buttonSize)}
            >
              {sizeLabelBySize[buttonSize]}
            </button>
          ))}
      </div>

      <div className="h-full overflow-auto p-4">
        {typeof children === 'function'
          ? children({
              size,
              setSize,
              close,
            })
          : children}
      </div>
    </section>
  );
}

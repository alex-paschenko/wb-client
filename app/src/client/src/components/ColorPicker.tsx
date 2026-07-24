// app/src/client/src/components/ColorPicker.tsx

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  createPortal,
} from 'react-dom';
import {
  HexColorInput,
  HexColorPicker,
} from 'react-colorful';

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  ariaLabel?: string;
}

interface PopoverPosition {
  top: number;
  left: number;
  verticalDirection: 'up' | 'down';
  horizontalAlignment: 'left' | 'right';
}

const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 8;
const ANIMATION_DURATION = 150;

const clamp = (
  value: number,
  min: number,
  max: number,
): number => Math.min(
  Math.max(value, min),
  max,
);

export const ColorPicker = ({
  color,
  onChange,
  ariaLabel,
}: ColorPickerProps) => {
  const popoverId = useId();

  const swatchRef =
    useRef<HTMLButtonElement>(null);

  const popoverRef =
    useRef<HTMLDivElement>(null);

  const closeTimeoutIdRef =
    useRef<number | null>(null);

  const animationFrameIdRef =
    useRef<number | null>(null);

  const originalColorRef =
    useRef(color);

  const [draftColor, setDraftColor] =
    useState(color);

  const [isRendered, setIsRendered] =
    useState(false);

  const [isVisible, setIsVisible] =
    useState(false);

  const [position, setPosition] =
    useState<PopoverPosition | null>(null);

  useEffect(() => {
    if (!isRendered) {
      setDraftColor(color);
    }
  }, [
    color,
    isRendered,
  ]);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutIdRef.current === null) {
      return;
    }

    window.clearTimeout(
      closeTimeoutIdRef.current,
    );

    closeTimeoutIdRef.current = null;
  }, []);

  const clearAnimationFrame = useCallback(() => {
    if (animationFrameIdRef.current === null) {
      return;
    }

    window.cancelAnimationFrame(
      animationFrameIdRef.current,
    );

    animationFrameIdRef.current = null;
  }, []);

  const commit = useCallback(() => {
    if (
      draftColor !==
      originalColorRef.current
    ) {
      onChange(
        draftColor,
      );
    }
  }, [
    draftColor,
    onChange,
  ]);

  const open = useCallback(() => {
    originalColorRef.current =
      color;

    setDraftColor(
      color,
    );

    clearCloseTimeout();
    clearAnimationFrame();

    setPosition(null);
    setIsRendered(true);

    animationFrameIdRef.current =
      window.requestAnimationFrame(() => {
        setIsVisible(true);
        animationFrameIdRef.current = null;
      });
  }, [
    color,
    clearCloseTimeout,
    clearAnimationFrame,
  ]);

  const close = useCallback(() => {
    commit();

    clearAnimationFrame();
    clearCloseTimeout();

    setIsVisible(false);

    closeTimeoutIdRef.current =
      window.setTimeout(() => {
        setIsRendered(false);
        setPosition(null);

        closeTimeoutIdRef.current = null;
      }, ANIMATION_DURATION);
  }, [
    commit,
    clearAnimationFrame,
    clearCloseTimeout,
  ]);

  const toggle = useCallback(() => {
    if (isRendered && isVisible) {
      close();
      return;
    }

    open();
  }, [
    isRendered,
    isVisible,
    open,
    close,
  ]);

  const updatePosition = useCallback(() => {
    const swatchElement =
      swatchRef.current;

    const popoverElement =
      popoverRef.current;

    if (!swatchElement || !popoverElement) {
      return;
    }

    const swatchRect =
      swatchElement.getBoundingClientRect();

    const popoverRect =
      popoverElement.getBoundingClientRect();

    const availableAbove =
      swatchRect.top - VIEWPORT_MARGIN;

    const availableBelow =
      window.innerHeight -
      swatchRect.bottom -
      VIEWPORT_MARGIN;

    const verticalDirection =
      availableBelow >= popoverRect.height ||
      availableBelow >= availableAbove
        ? 'down'
        : 'up';

    const desiredTop =
      verticalDirection === 'down'
        ? swatchRect.bottom + POPOVER_GAP
        : swatchRect.top -
          popoverRect.height -
          POPOVER_GAP;

    const availableWithLeftAlignment =
      window.innerWidth -
      swatchRect.left -
      VIEWPORT_MARGIN;

    const availableWithRightAlignment =
      swatchRect.right -
      VIEWPORT_MARGIN;

    const horizontalAlignment =
      availableWithLeftAlignment >= popoverRect.width ||
      availableWithLeftAlignment >=
        availableWithRightAlignment
        ? 'left'
        : 'right';

    const desiredLeft =
      horizontalAlignment === 'left'
        ? swatchRect.left
        : swatchRect.right -
          popoverRect.width;

    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight -
        popoverRect.height -
        VIEWPORT_MARGIN,
    );

    const maxLeft = Math.max(
      VIEWPORT_MARGIN,
      window.innerWidth -
        popoverRect.width -
        VIEWPORT_MARGIN,
    );

    setPosition({
      top: clamp(
        desiredTop,
        VIEWPORT_MARGIN,
        maxTop,
      ),
      left: clamp(
        desiredLeft,
        VIEWPORT_MARGIN,
        maxLeft,
      ),
      verticalDirection,
      horizontalAlignment,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isRendered) {
      return;
    }

    updatePosition();
  }, [
    isRendered,
    updatePosition,
  ]);

  useEffect(() => {
    if (!isRendered) {
      return;
    }

    const handlePointerDown = (
      event: PointerEvent,
    ) => {
      const target =
        event.target as Node;

      if (
        swatchRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }

      close();
    };

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key !== 'Escape') {
        return;
      }

      close();
      swatchRef.current?.focus();
    };

    const handleViewportChange = () => {
      updatePosition();
    };

    document.addEventListener(
      'pointerdown',
      handlePointerDown,
      true,
    );

    document.addEventListener(
      'keydown',
      handleKeyDown,
    );

    window.addEventListener(
      'resize',
      handleViewportChange,
    );

    window.addEventListener(
      'scroll',
      handleViewportChange,
      true,
    );

    return () => {
      document.removeEventListener(
        'pointerdown',
        handlePointerDown,
        true,
      );

      document.removeEventListener(
        'keydown',
        handleKeyDown,
      );

      window.removeEventListener(
        'resize',
        handleViewportChange,
      );

      window.removeEventListener(
        'scroll',
        handleViewportChange,
        true,
      );
    };
  }, [
    isRendered,
    close,
    updatePosition,
  ]);

  useEffect(() => {
    return () => {
      clearCloseTimeout();
      clearAnimationFrame();
    };
  }, [
    clearCloseTimeout,
    clearAnimationFrame,
  ]);

  const getTransformOriginClass = (): string => {
    if (!position) {
      return 'origin-center';
    }

    if (position.verticalDirection === 'down') {
      return position.horizontalAlignment === 'left'
        ? 'origin-top-left'
        : 'origin-top-right';
    }

    return position.horizontalAlignment === 'left'
      ? 'origin-bottom-left'
      : 'origin-bottom-right';
  };

  return (
    <>
      <button
        ref={swatchRef}
        type="button"
        className="h-5 w-10 shrink-0 cursor-pointer rounded-md border border-panel-border shadow-sm transition hover:border-accent hover:shadow"
        style={{
          backgroundColor: color,
        }}
        aria-label={ariaLabel}
        aria-controls={popoverId}
        aria-expanded={isVisible}
        title={color}
        onClick={toggle}
      />

      {isRendered && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label={ariaLabel}
          className={[
            'app-color-picker',
            'fixed z-[100] rounded-xl border border-panel-border bg-panel p-3 shadow-xl',
            'transition-[opacity,transform] duration-150 ease-out',
            getTransformOriginClass(),
            isVisible && position
              ? 'scale-100 opacity-100'
              : 'pointer-events-none scale-95 opacity-0',
          ].join(' ')}
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position
              ? 'visible'
              : 'hidden',
          }}
        >
          <HexColorPicker
            color={draftColor}
            onChange={setDraftColor}
          />

          <HexColorInput
            className="mt-3 h-9 w-full rounded-lg border border-panel-border bg-bg px-3 font-mono text-sm text-fg outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
            color={draftColor}
            onChange={setDraftColor}
            prefixed
            aria-label={`${ariaLabel}: hexadecimal value`}
          />
        </div>,
        document.body,
      )}
    </>
  );
};

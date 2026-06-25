import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type {
  LogEntry,
  LogLevel,
} from '../../../shared/types/logger';
import { useAppContext } from '../contexts/AppContext';

type LogPanelSize =
  | 'small'
  | 'medium'
  | 'large';

const LOG_PANEL_ROWS: Record<LogPanelSize, number> = {
  small: 3,
  medium: 10,
  large: 25,
};

const LOG_PANEL_SIZE_LABELS: Record<LogPanelSize, string> = {
  small: '3',
  medium: '10',
  large: '25',
};

const LOG_LEVEL_CLASSES: Record<LogLevel, string> = {
  debug: 'log-panel-level-debug',
  info: 'log-panel-level-info',
  warn: 'log-panel-level-warn',
  error: 'log-panel-level-error',
};

export const LogPanel = () => {
  const {
    logs,
    settings,
  } = useAppContext();

  const { t } = useTranslation();

  const [size, setSize] = useState<LogPanelSize>('small');
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const language = settings.getLanguage();

  const maxHeight = useMemo(
    () => LOG_PANEL_ROWS[size] * 24 + 12,
    [size],
  );

  const formatTimestamp = (timestamp: number): string => {
    return new Intl.DateTimeFormat(language, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestamp));
  };

  const handleScroll = () => {
    const element = scrollRef.current;

    if (!element) {
      return;
    }

    const distanceToBottom =
      element.scrollHeight -
      element.scrollTop -
      element.clientHeight;

    setIsPinnedToBottom(distanceToBottom < 8);
  };

  const scrollToBottom = () => {
    const element = scrollRef.current;

    if (!element) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: 'smooth',
    });

    setIsPinnedToBottom(true);
  };

  useEffect(() => {
    if (isPinnedToBottom) {
      scrollToBottom();
    }
  }, [logs.length, isPinnedToBottom]);

  const availableSizes = (
    Object.keys(LOG_PANEL_ROWS) as LogPanelSize[]
  ).filter((panelSize) => panelSize !== size);

  return (
    <section className="log-panel">
      <header className="log-panel-header">
        <strong className="log-panel-title">
          {t('log.title')}
        </strong>

        <div className="log-panel-controls">
          {availableSizes.map((panelSize) => (
            <button
              key={panelSize}
              type="button"
              className="log-panel-button"
              onClick={() => setSize(panelSize)}
            >
              {LOG_PANEL_SIZE_LABELS[panelSize]}
            </button>
          ))}

          {!isPinnedToBottom && (
            <button
              type="button"
              className="log-panel-scroll-button"
              onClick={scrollToBottom}
              title={t('log.scrollToBottom')}
            >
              ↓
            </button>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="log-panel-body"
        style={{
          maxHeight,
        }}
      >
        {logs.map((entry, index) => (
          <LogPanelRow
            key={`${entry.timestamp}-${index}`}
            entry={entry}
            formatTimestamp={formatTimestamp}
          />
        ))}
      </div>
    </section>
  );
};

const LogPanelRow = ({
  entry,
  formatTimestamp,
}: {
  entry: LogEntry;
  formatTimestamp: (timestamp: number) => string;
}) => {
  const { t } = useTranslation();

  return (
    <div className="log-panel-row">
      <span className="log-panel-time">
        {formatTimestamp(entry.timestamp)}
      </span>

      <span
        className={[
          'log-panel-level',
          LOG_LEVEL_CLASSES[entry.level],
        ].join(' ')}
      >
        [{t(`log.level.${entry.level}`)}]
      </span>

      <span className="log-panel-body-text">
        {t(entry.body)}
      </span>
    </div>
  );
};

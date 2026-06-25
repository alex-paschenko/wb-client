import { DashboardItem } from '../components/DashboardItem';
import { LogPanel } from '../components/LogPanel';

export const DashboardPage = () => {
  return (
    <div className="flex w-full flex-col gap-3">
      <LogPanel />

      <section className="main-gap flex w-full flex-wrap content-start">
                <DashboardItem
          initialSize="quarter"
          heightClassName="item-height-md"
          controlsVisibility="hover"
        >
          ...
        </DashboardItem>
      </section>

      <section className="flex flex-wrap gap-2">
        <button>ETC-USD</button>
      </section>
    </div>
  );
};

// app/src/client/src/components/SettingsSection.tsx

import type {
  ReactNode,
} from 'react';

interface SettingsSectionProps {
  title: ReactNode;
  children: ReactNode;
}

export const SettingsSection = ({
  title,
  children,
}: SettingsSectionProps) => (
  <section>
    <h3 className="text-base font-semibold text-fg">
      {title}
    </h3>

    <div className="mt-3">
      {children}
    </div>
  </section>
);

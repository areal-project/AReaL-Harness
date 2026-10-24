import { createContext, useContext } from 'react';
import { Monitor } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { useI18n } from './i18n/IntlProvider.js';

export const ComputerControlContext = createContext<{ visible: boolean; open(): void } | null>(null);
export function ComputerControlEntry() {
  const context = useContext(ComputerControlContext);
  const { t } = useI18n();
  if (!context?.visible) return null;
  return <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.computer.title')}
    title={t('settings.computer.title')} onClick={context.open}><Monitor size={16} /></Button>;
}

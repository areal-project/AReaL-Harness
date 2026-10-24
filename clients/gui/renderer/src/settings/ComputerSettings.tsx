import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/IntlProvider.js';
import type { Action, Data } from '../services.js';
import { Input } from '../components/ui/input.js';
import { Button } from '../components/ui/button.js';
import { SettingsBadge, SettingsGroupCard, SettingsRow, SettingsSection, SettingsSwitch, SettingsSelect } from './SettingsPageParts.js';

const permissionLabels = {
  accessibility: ['settings.computer.accessibility', 'settings.computer.accessibilityDescription'],
  screenRecording: ['settings.computer.screenRecording', 'settings.computer.screenRecordingDescription'],
  inputMonitoring: ['settings.computer.inputMonitoring', 'settings.computer.inputMonitoringDescription'],
} as const;
type Capability = keyof typeof permissionLabels;
const statusLabels = {
  granted: 'settings.computer.granted', denied: 'settings.computer.denied',
  stale: 'settings.computer.stale', unknown: 'settings.computer.unknown',
} as const;

export function ComputerSettings({ settings = {}, action, connected }: { settings?: Data; action: Action; connected: boolean }) {
  const { t } = useI18n();
  const lcu = settings.computerControlProvider === 'lcu';
  const [executable, setExecutable] = useState(String(settings.computerControlExecutable ?? ''));
  useEffect(() => setExecutable(String(settings.computerControlExecutable ?? '')), [settings.computerControlExecutable]);
  const [status, setStatus] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), pending = useRef(false);
  const refresh = useCallback(async () => {
    if (!connected || pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const value = await action('computerControl', { operation: 'status' });
      if (mounted.current) { setStatus(value); setError(''); }
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, [action, connected]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(visibleRefresh, 5000);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [refresh]);
  const run = async (operation: 'requestAccess' | 'openSettings' | 'restart' | 'stop', capability?: Capability) => {
    if (pending.current || !connected) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await action('computerControl', { operation, ...(capability ? { capability } : {}) });
      if (mounted.current) setStatus(value);
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const save = async (key: string, value: boolean | string) => {
    if (pending.current || !connected) return;
    pending.current = true; setBusy(true); setError('');
    try { await action('library', { operation: 'settings', key, value }); setStatus(null); }
    catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const unsupported = status?.supported === false || status?.platform && status.platform !== 'darwin';
  const disabled = !connected || busy || unsupported;
  return <div className="settings-sections" data-testid="computer-control-settings">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {unsupported && <p role="status" className="settings-section-desc">{t('settings.computer.unsupported')}</p>}
    <SettingsSection><SettingsGroupCard>
      <SettingsRow label={t('settings.computer.provider')} description={t('settings.computer.providerDescription')}
        control={<SettingsSelect aria-label={t('settings.computer.provider')} value={lcu ? 'lcu' : 'native'} disabled={!connected || busy}
          onValueChange={value => void save('computerControlProvider', value)}>
          <option value="native">{t('settings.computer.native')}</option><option value="lcu">{t('settings.computer.lcu')}</option>
        </SettingsSelect>} />
      {lcu && <SettingsRow label={t('settings.computer.executable')} description={t('settings.computer.executableDescription')} controlLayout="wide"
        control={<div className="flex w-full flex-wrap items-center gap-2">
          <Input aria-label={t('settings.computer.executable')} value={executable} disabled={!connected || busy} onChange={event => setExecutable(event.target.value)} />
          <Button variant="outline" disabled={!connected || busy || executable === String(settings.computerControlExecutable ?? '')}
            onClick={() => void save('computerControlExecutable', executable)}>{t('settings.computer.save')}</Button>
        </div>} />}
      <SettingsRow label={t('settings.computer.enable')} description={t('settings.computer.enableDescription')}
        control={<span data-testid="computer-control-enabled"><SettingsSwitch aria-label={t('settings.computer.enable')} checked={settings.computerControlEnabled === true}
          disabled={disabled} onCheckedChange={value => void save('computerControlEnabled', value)} /></span>} />
      <SettingsRow label={t('settings.computer.showEntry')} description={t('settings.computer.showEntryDescription')}
        control={<SettingsSwitch aria-label={t('settings.computer.showEntry')} checked={settings.computerControlShowEntry === true}
          disabled={!connected || busy} onCheckedChange={value => void save('computerControlShowEntry', value)} />} />
    </SettingsGroupCard></SettingsSection>
    {!lcu && <SettingsSection title={t('settings.computer.permissions')} description={t('settings.computer.permissionsDescription')}>
      <SettingsGroupCard>{(Object.keys(permissionLabels) as Capability[]).filter(capability => capability !== 'inputMonitoring' || status?.inputMonitoring !== undefined).map(capability => {
        const value = typeof status?.[capability] === 'string' && status[capability] in statusLabels ? status[capability] as keyof typeof statusLabels : 'unknown';
        return <SettingsRow key={capability} label={t(permissionLabels[capability][0])} description={t(permissionLabels[capability][1])} controlLayout="wide"
          control={<div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" disabled={disabled} onClick={() => void run('requestAccess', capability)}>{t('settings.computer.grant')}</Button>
            <Button variant="ghost" disabled={disabled} onClick={() => void run('openSettings', capability)}>{t('settings.computer.openSettings')}</Button>
            <SettingsBadge>{t(statusLabels[value])}</SettingsBadge>
          </div>} />;
      })}</SettingsGroupCard>
    </SettingsSection>}
    <SettingsSection title={t(lcu ? 'settings.computer.lcu' : 'settings.computer.helper')} description={t(lcu ? 'settings.computer.lcuDescription' : 'settings.computer.helperDescription')}>
      <SettingsGroupCard><SettingsRow label={t(settings.computerControlEnabled !== true ? 'settings.computer.disabled' : status?.ownerFence?.capacityReached ? 'settings.computer.capacityReached' : status?.ready ? lcu ? 'settings.computer.lcuReady' : 'settings.computer.ready' : lcu ? 'settings.computer.lcuNotReady' : 'settings.computer.notReady')}
        description={status?.message || status?.reason || undefined} controlLayout="wide"
        control={<div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={!connected || busy} onClick={() => void refresh()}>{t(lcu ? 'settings.computer.lcuRefresh' : 'settings.computer.refresh')}</Button>
          <Button variant="outline" disabled={disabled} onClick={() => void run('restart')}>{t(lcu ? 'settings.computer.check' : 'settings.computer.restart')}</Button>
          <Button variant="outline" disabled={!connected || busy} onClick={() => void run('stop')}>{t('settings.computer.stop')}</Button>
        </div>} /></SettingsGroupCard>
    </SettingsSection>
  </div>;
}

import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { SettingsSection, SettingsGroupCard, SettingsRow } from './SettingsPageParts.js';
import type { Action, Data } from '../services.js';

export function MobileSettings({ action, projects }: { action: Action; projects: Data[] }) {
  const [state, setState] = useState<Data>({ devices: [], pending: [] });
  const [relay, setRelay] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Data | null>(null), [selected, setSelected] = useState<string[]>([]);
  const run = async (request: Data) => {
    setBusy(true); setError('');
    try {
      const result = await action('remoteControl', request);
      if (request.operation === 'pair') setInvite(result); else setState(result);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let live = true;
    const read = () => action('remoteControl', { operation: 'status' }).then(value => { if (live) { setState(value); setRelay(old => old || value.relay); } }).catch(error => { if (live) setError(error.message); });
    void read(); const timer = setInterval(() => void read(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [action]);
  return <div className="settings-sections" aria-label="手机连接设置">
    <SettingsSection title="手机连接" description="通过加密中继连接此 Mac。关闭窗口后仍可连接；退出后台或电脑睡眠后离线。">
      <SettingsGroupCard>
        <SettingsRow label="中继地址" description="用于连接桌面与手机的加密中继" controlLayout="wide" control={
          <Input aria-label="中继地址" value={relay} placeholder="wss://relay.example.com" onChange={event => setRelay(event.target.value)} />
        } />
        <SettingsRow label="连接状态" description={<span role="status">{state.connected ? '中继已连接' : state.enabled ? '等待连接中继' : '手机连接未启用'}</span>} control={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy || !relay} onClick={() => void run({ operation: 'enable', relay })}>连接中继</Button>
            <Button variant="outline" disabled={busy || !state.enabled} onClick={() => void run({ operation: 'disable' })}>关闭手机连接</Button>
          </div>
        } />
        <SettingsRow label="配对新手机" description="扫描二维码，将手机连接到此 Mac" control={
          <Button variant="secondary" disabled={busy || !state.connected} onClick={() => void run({ operation: 'pair' })}>配对新手机</Button>
        } />
      </SettingsGroupCard>
      {invite && <div><img width="256" height="256" src={invite.qr} alt="手机配对二维码" /><p>二维码两分钟内有效，扫描后在此确认设备。</p><details><summary>复制配对信息</summary><textarea aria-label="配对信息" className="w-full" readOnly value={invite.payload} /></details></div>}
      {error && <p role="alert">{error}</p>}
    </SettingsSection>
    {!!state.pending.length && <SettingsSection title="确认手机" description="核对手机显示的设备指纹，并选择允许访问的项目。">
      {projects.map(project => <label className="block py-2" key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={event => setSelected(old => event.target.checked ? [...old, project.id] : old.filter(id => id !== project.id))} /> {project.root.split('/').at(-1)}</label>)}
      {state.pending.map((device: Data) => <div key={device.id}><p>{device.name} · {device.fingerprint}</p><Button disabled={busy || !selected.length} onClick={() => void run({ operation: 'approve', id: device.id, projects: selected })}>确认配对</Button></div>)}
    </SettingsSection>}
    <SettingsSection title="已配对手机">
      <SettingsGroupCard>
        {state.devices.map((device: Data) => <SettingsRow key={device.id} label={device.name} description={`${device.projects.length} 个项目`} control={<Button variant="outline" disabled={busy} onClick={() => void run({ operation: 'revoke', id: device.id })}>撤销访问</Button>} />)}
        {!state.devices.length && <p className="settings-card-empty">还没有已配对手机</p>}
      </SettingsGroupCard>
    </SettingsSection>
  </div>;
}

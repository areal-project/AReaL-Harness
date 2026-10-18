/** Core 的管理视图；只消费公开命令，不依赖平台实现。 */
export function createCorePanels(React) {
  const h = React.createElement;
  function useResource(load, identity) {
    const loader = React.useRef(load); loader.current = load;
    const [state, setState] = React.useState({ loading: true });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
      let active = true;
      setState({ loading: true });
      loader.current().then(value => { if (active) setState({ value, loading: false }); }, error => { if (active) setState({ error: error.message, loading: false }); });
      return () => { active = false; };
    }, [identity, revision]);
    return [state, refresh];
  }
  function Notice({ state }) {
    return state.loading ? h('p', { role: 'status' }, '正在读取…') : state.error ? h('p', { role: 'alert' }, state.error) : null;
  }
  const json = value => h('pre', { className: 'areal-core-json' }, JSON.stringify(value, null, 2));
  function Providers({ project, action }) {
    const api = (operation, values = {}) => action('manage', { projectId: project.id, operation, ...values });
    const [state, refresh] = useResource(() => api('providers'), project.id);
    const blank = { id: '', revision: 0, endpoint: '', protocol: 'chatCompletions', models: [], credentialRef: '', parameters: {} };
    const [draft, setDraft] = React.useState(blank);
    const [models, setModels] = React.useState('');
    const [message, setMessage] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const field = (key, value) => setDraft({ ...draft, [key]: value });
    const run = async task => { setBusy(true); setMessage(''); try { await task(); refresh(); } catch (e) { setMessage(e.message); } finally { setBusy(false); } };
    const disabled = busy || project.pending.length > 0;
    return h('section', { className: 'areal-core-settings' }, h('h3', null, '模型服务'),
      h('p', null, '配置属于当前工作区。修改服务商配置影响之后创建或重新配置的会话，已入队消息保持原配置。'),
      h(Notice, { state }), ...(state.value?.data ?? []).map(item => h('article', { key: item.id },
        h('strong', null, item.id), h('p', null, `${item.protocol} · ${item.models.join(', ')} · 凭据：${({ available: '可用', unavailable: '缺失', notRequired: '无需凭据' })[item.credentialState]}`),
        h('button', { disabled, onClick: () => { setDraft({ id: item.id, revision: item.revision, endpoint: item.endpoint, protocol: item.protocol, models: item.models, credentialRef: item.credentialRef ?? '', parameters: item.parameters ?? {} }); setModels(item.models.join('\n')); } }, `编辑 ${item.id}`),
        h('button', { disabled, onClick: () => run(async () => { const result = await api('providerProbe', { id: item.id }); setMessage(`连接测试：${JSON.stringify(result)}`); }) }, `测试连接 ${item.id}`),
        h('button', { disabled, onClick: () => { if (window.confirm(`移除模型服务 ${item.id}？引用它的会话可能无法开始下一轮。`)) void run(() => api('providerRemove', { id: item.id, expectedRevision: item.revision })); } }, `移除 ${item.id}`))),
      h('form', { onSubmit: event => { event.preventDefault(); void run(async () => {
        const provider = { ...draft, models: models.split(/\n|,/).map(value => value.trim()).filter(Boolean), credentialRef: draft.credentialRef || null };
        await api('providerSave', { provider, expectedRevision: draft.revision }); setDraft(blank); setModels(''); setMessage('模型服务已保存');
      }); } },
      h('h4', null, draft.revision ? '编辑模型服务' : '添加模型服务'),
      h('label', null, '服务商 ID', h('input', { value: draft.id, required: true, disabled: !!draft.revision, onChange: e => field('id', e.target.value) })),
      h('label', null, 'API 地址', h('input', { type: 'url', value: draft.endpoint, required: true, onChange: e => field('endpoint', e.target.value) })),
      h('label', null, '协议', h('select', { value: draft.protocol, onChange: e => field('protocol', e.target.value) }, h('option', { value: 'chatCompletions' }, 'Chat Completions'), h('option', { value: 'responses' }, 'Responses'))),
      h('label', null, '模型名称（每行一个）', h('textarea', { value: models, required: true, onChange: e => setModels(e.target.value) })),
      h('label', null, '凭据引用', h('input', { value: draft.credentialRef, onChange: e => field('credentialRef', e.target.value) })),
      h('p', null, '此处填写引用名，不填写 API Key。引用 foo 对应启动环境 AREAL_CREDENTIAL_foo；凭据修改需重新启动后端。'),
      h('label', null, '默认温度', h('input', { type: 'number', min: 0, max: 2, step: .1, value: draft.parameters.temperature ?? '', onChange: e => field('parameters', { ...draft.parameters, temperature: e.target.value === '' ? null : Number(e.target.value) }) })),
      h('label', null, '最大输出 Token', h('input', { type: 'number', min: 1, value: draft.parameters.maxOutputTokens ?? '', onChange: e => field('parameters', { ...draft.parameters, maxOutputTokens: e.target.value === '' ? null : Number(e.target.value) }) })),
      h('button', { disabled, type: 'submit' }, '保存模型服务'), h('button', { type: 'button', disabled, onClick: () => { setDraft(blank); setModels(''); } }, '新建')),
      message ? h('p', { role: 'status' }, message) : null);
  }
  function Mcp({ project, action }) {
    const api = (operation, values = {}) => action('manage', { projectId: project.id, operation, ...values });
    const [state, refresh] = useResource(() => api('mcp'), project.id);
    const [id, setId] = React.useState(''), [revision, setRevision] = React.useState(0);
    const [config, setConfig] = React.useState('{\n  "transport": { "type": "stdio", "command": "", "args": [] }\n}');
    const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('');
    const run = async task => { setBusy(true); setMessage(''); try { await task(); refresh(); } catch (e) { setMessage(e.message); } finally { setBusy(false); } };
    const disabled = busy || project.pending.length > 0;
    return h('section', { className: 'areal-core-settings' }, h('h3', null, 'MCP 服务'), h(Notice, { state }),
      h('p', null, '保存配置不会自动启动服务。连接后由 Core 提供工具目录；部署文件定义的服务只读。'),
      ...(state.value?.data ?? []).map(item => h('article', { key: item.id }, h('strong', null, `${item.id} · ${item.state}`), item.error ? h('p', { role: 'alert' }, item.error) : null,
        h('p', null, `工具：${(item.tools ?? []).map(tool => tool.name ?? tool).join(', ') || '无'}`),
        h('button', { disabled, onClick: () => { setId(item.id); setRevision(item.revision); setConfig(JSON.stringify(item.config, null, 2)); } }, `编辑 MCP ${item.id}`),
        h('button', { disabled, onClick: () => run(() => api('mcpConnect', { id: item.id, expectedRevision: item.revision })) }, `连接 ${item.id}`),
        h('button', { disabled, onClick: () => run(() => api('mcpDisconnect', { id: item.id, expectedRevision: item.revision })) }, `断开 ${item.id}`))),
      h('form', { onSubmit: e => { e.preventDefault(); void run(async () => { await api('mcpSave', { id, expectedRevision: revision, config: JSON.parse(config) }); setMessage('配置已保存'); }); } },
        h('label', null, '服务 ID', h('input', { required: true, value: id, disabled: revision > 0, onChange: e => setId(e.target.value) })),
        h('label', null, 'MCP 配置 JSON', h('textarea', { rows: 10, value: config, onChange: e => setConfig(e.target.value) })),
        h('button', { type: 'submit', disabled }, '保存 MCP 配置'),
        h('button', { type: 'button', disabled, onClick: () => { setId(''); setRevision(0); } }, '新增 MCP')),
      message ? h('p', { role: 'status' }, message) : null);
  }
  function Configuration({ project, thread, action, configuration }) {
    const [options, setOptions] = React.useState(configuration?.options ?? {});
    const [parameters, setParameters] = React.useState(configuration?.parameters ?? {});
    const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('');
    const update = (name, value) => setOptions({ ...options, [name]: value });
    if (!thread || !configuration) return h('p', null, '请先选择会话');
    return h('form', { className: 'areal-core-settings', onSubmit: async event => { event.preventDefault(); setBusy(true); setMessage(''); try {
      await action('configure', { projectId: project.id, threadId: thread.id, expectedRevision: configuration.revision, options, parameters }); setMessage('会话配置已保存');
    } catch (e) { setMessage(e.message); } finally { setBusy(false); } } },
      h('h3', null, '会话权限与参数'),
      h('p', null, '只影响之后的新消息。队列已固定的配置不改变；部署与 Profile 权限上限仍生效。'),
      h('label', null, h('input', { type: 'checkbox', checked: options.readOnly === true, onChange: e => update('readOnly', e.target.checked) }), '只读模式（具体工具权限由 Core 判定）'),
      h('label', null, '附加指令', h('textarea', { rows: 4, value: options.appendInstructions ?? '', onChange: e => update('appendInstructions', e.target.value) })),
      h('label', null, '单轮最大模型调用次数', h('input', { type: 'number', min: 1, max: 1024, value: options.maxModelRounds ?? '', onChange: e => update('maxModelRounds', e.target.value ? Number(e.target.value) : null) })),
      h('label', null, '温度', h('input', { type: 'number', min: 0, max: 2, step: .1, value: parameters.temperature ?? '', onChange: e => setParameters({ ...parameters, temperature: e.target.value ? Number(e.target.value) : null }) })),
      h('label', null, '最大输出 Token', h('input', { type: 'number', min: 1, value: parameters.maxOutputTokens ?? '', onChange: e => setParameters({ ...parameters, maxOutputTokens: e.target.value ? Number(e.target.value) : null }) })),
      h('button', { disabled: busy || project.pending.length > 0 || thread.desktop?.archived || thread.turns?.some(turn => turn.status === 'inProgress') }, '保存会话配置'),
      message ? h('p', { role: 'status' }, message) : null);
  }
  function Profiles({ project, action }) {
    const [selected, setSelected] = React.useState(null);
    const [state] = useResource(() => selected ? action('manage', { projectId: project.id, operation: 'profile', id: selected.id, revision: selected.revision }) : Promise.resolve(null), `${project.id}:${selected?.id}:${selected?.revision}`);
    return h('section', { className: 'areal-core-settings' }, h('h3', null, 'Agent 预设'), h('p', null, '预设由 Core 部署提供；可以查看定义，在会话模式选择器中切换。当前 Core 没有在线增删或编辑预设的接口。'),
      ...project.profiles.map(item => h('button', { key: `${item.id}:${item.revision}`, onClick: () => setSelected(item) }, item.displayName || item.id)),
      h(Notice, { state }), state.value ? json(state.value) : null);
  }
  function Inspect({ kind, project, thread, action }) {
    const operations = { '环境信息': 'inspect', 'Agent 看板': 'agents', 'Skills': 'skills', '上下文': 'context', '执行计划': 'plan', '受管进程': 'processes', '工作流': 'workflows' };
    const operation = operations[kind];
    const [offset, setOffset] = React.useState(0);
    const [state, refresh] = useResource(() => action('manage', { projectId: project.id, threadId: thread?.id, parentThreadId: thread?.id, operation, offset, limit: kind === '上下文' ? 32 : 100 }), `${project.id}:${thread?.id}:${kind}:${offset}`);
    const [selected, setSelected] = React.useState(null);
    const [detail, setDetail] = React.useState(null);
    React.useEffect(() => { setSelected(null); setDetail(null); }, [project.id, thread?.id, kind]);
    return h('section', { className: 'areal-core-settings' }, h('button', { onClick: refresh }, `刷新${kind}`), h(Notice, { state }),
      kind === 'Skills' ? h(React.Fragment, null, ...(state.value?.data ?? []).map(item => h('button', { key: `${item.id}:${item.revision}`, onClick: async () => {
        setSelected(item.id); try { setDetail(await action('manage', { projectId: project.id, threadId: thread.id, operation: 'skill', skill: { id: item.id, revision: item.revision }, maxBytes: 8192 })); } catch (error) { setDetail({ error: error.message }); }
      } }, item.id)), selected ? h('h4', null, selected) : null, detail ? json(detail) : null) : null,
      kind === '上下文' ? h('div', null, h('button', { disabled: offset === 0, onClick: () => setOffset(Math.max(0, offset - 32)) }, '上一页'), h('span', null, `第 ${offset / 32 + 1} 页`), h('button', { disabled: state.loading || state.value?.nextOffset == null, onClick: () => setOffset(state.value.nextOffset) }, '下一页')) : null,
      kind === '受管进程' ? h(React.Fragment, null, ...(state.value?.data ?? []).map(item => h('button', { key: item.id, onClick: async () => { try { setDetail(await action('manage', { projectId: project.id, threadId: thread.id, operation: 'processOutput', id: item.id, maxBytes: 65536 })); } catch (e) { setDetail({ error: e.message }); } } }, `读取输出 ${item.id}`)), detail ? json(detail) : null) : null,
      state.value ? json(state.value) : null);
  }
  function Trace({ thread }) {
    return h('section', { className: 'areal-core-settings' }, ...(thread?.turns ?? []).map((turn, index) => h('details', { key: turn.id, open: true },
      h('summary', null, `第 ${index + 1} 轮 · ${turn.status}`),
      ...(turn.items ?? []).map(item => h('details', { key: item.id }, h('summary', null, `${item.type}${item.tool ? ` · ${item.tool}` : ''}`), json(item))), turn.error ? json(turn.error) : null)));
  }

  const editors = new Map();
  function Files({ project, thread, action }) {
    const owner = `${project.id}:${thread?.id ?? 'workspace'}`;
    const [directory, setDirectory] = React.useState('');
    const [documents, setDocuments] = React.useState(editors.get(owner) ?? {});
    const [active, setActive] = React.useState(Object.keys(documents)[0] ?? null);
    const [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false);
    const api = (operation, values = {}) => action('workspace', { projectId: project.id, operation, ...values });
    const [listing, refresh] = useResource(() => api('list', { path: directory }), `${project.id}:${directory}`);
    React.useEffect(() => { editors.set(owner, documents); }, [owner, documents]);
    const document = documents[active];
    const read = async path => {
      if (documents[path]) { setActive(path); return; }
      setBusy(true); setMessage('');
      try { const value = await api('read', { path }); setDocuments(previous => ({ ...previous, [path]: { ...value, original: value.text } })); setActive(path); }
      catch (e) { setMessage(e.message); } finally { setBusy(false); }
    };
    const save = async () => {
      const path = active, current = document;
      setBusy(true); setMessage('');
      try {
        const result = await api('save', { path, text: current.text, revision: current.revision });
        if (result.conflict) { setMessage(result.error); return; }
        setDocuments(previous => ({ ...previous, [path]: { ...previous[path], revision: result.revision, original: current.text } }));
        setMessage('文件已保存');
      } catch (e) { setMessage(e.message); } finally { setBusy(false); }
    };
    return h('section', { className: 'areal-core-settings' },
      h('div', null, h('strong', null, directory || '工作区文件'),
        h('button', { disabled: !directory || busy, onClick: () => setDirectory(directory.split('/').slice(0, -1).join('/')) }, '上一级'),
        h('button', { disabled: busy, onClick: refresh }, '刷新文件')),
      h(Notice, { state: listing }),
      h('div', { className: 'areal-core-file-list' }, ...(listing.value?.entries ?? []).map(item => {
        const path = directory ? `${directory}/${item.name}` : item.name;
        return h('button', { key: path, disabled: busy, onClick: () => item.dir ? setDirectory(path) : read(path) }, `${item.dir ? '▸ ' : ''}${item.name}`);
      })), listing.value?.truncated ? h('p', null, '目录项目较多，仅显示前 1000 项。') : null,
      h('div', { role: 'tablist', 'aria-label': '已打开文件' }, ...Object.entries(documents).map(([path, value]) => h('button', { key: path, role: 'tab', 'aria-selected': path === active, disabled: busy, onClick: () => setActive(path) }, `${path}${value.text !== value.original ? ' *' : ''}`))),
      document ? h(React.Fragment, null, h('textarea', { className: 'areal-core-editor', 'aria-label': `编辑 ${active}`, rows: 18, disabled: busy, value: document.text, onChange: e => setDocuments({ ...documents, [active]: { ...document, text: e.target.value } }) }),
        h('button', { disabled: busy || document.text === document.original, onClick: save }, '保存文件'),
        h('button', { disabled: busy, onClick: async () => { setBusy(true); try { const value = await api('read', { path: active }); setMessage(`磁盘版本（当前草稿已保留）：\n${value.text}`); } catch (e) { setMessage(e.message); } finally { setBusy(false); } } }, '查看磁盘版本'),
        h('button', { disabled: busy, onClick: async () => { if (document.text !== document.original && !window.confirm('丢弃当前文件草稿，重新读取磁盘版本？')) return; setBusy(true); try { const value = await api('read', { path: active }); setDocuments(previous => ({ ...previous, [active]: { ...value, original: value.text } })); setMessage('已重新读取磁盘版本'); } catch (e) { setMessage(e.message); } finally { setBusy(false); } } }, '重新读取文件')) : null,
      message ? h('pre', { role: 'status', className: 'areal-core-json' }, message) : null);
  }
  function Review({ project, action }) {
    const [scope, setScope] = React.useState('unstaged'), [reference, setReference] = React.useState('HEAD');
    const [state, refresh] = useResource(() => action('workspace', { projectId: project.id, operation: 'review', scope, ref: reference }), `${project.id}:${scope}`);
    return h('section', { className: 'areal-core-settings' },
      h('label', null, '改动范围', h('select', { value: scope, onChange: e => setScope(e.target.value) }, ...[['unstaged', '未暂存'], ['staged', '已暂存'], ['branch', '分支比较'], ['commit', '提交']].map(([value, label]) => h('option', { key: value, value }, label)))),
      ['branch', 'commit'].includes(scope) ? h('label', null, '参考分支或提交', h('input', { value: reference, onChange: e => setReference(e.target.value) })) : null,
      h('button', { onClick: refresh }, '刷新改动'), h(Notice, { state }),
      state.value ? h(React.Fragment, null, h('p', null, `${state.value.branch} · ${state.value.files.length} 个文件`), ...state.value.files.map(file => h('details', { key: file.path }, h('summary', null, `${file.path} +${file.additions} −${file.deletions}`),
        h('pre', { className: 'areal-core-json' }, (file.hunks ?? []).map(hunk => (hunk.lines ?? []).map(line => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.content ?? line.text ?? ''}`).join('\n')).join('\n')))),
        h('details', null, h('summary', null, '完整 Diff'), h('pre', { className: 'areal-core-json' }, state.value.diff))) : null);
  }
  return { Providers, Mcp, Configuration, Profiles, Inspect, Trace, Files, Review };

}

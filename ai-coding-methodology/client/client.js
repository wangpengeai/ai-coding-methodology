// 文件：client/client.js
// 描述：ai-coding-methodology 的 DSH 浏览器半侧（内部任务-201 / 内部决策-057；2026-10-31 内部任务-268/内部决策-068 扩为配置面 v2）——
//       在「插件」页本插件详情页注册 `plugins.bundle.config` 分组列表卡片：六插件独立开关
//       （pluginWorkflow…pluginResearchLoop）、工具面（agentControlBridge）、系统监测（osObservation）。
//       多字段脏草稿经**一次** `configForms.mutate(ops, revision)` 提交；保存后重读快照逐字段比对，
//       不一致按 rejected 处理并保留草稿。写入经宿主 settings→config-editor 持久化到 profile 的
//       `cordis.patch.yml`；六插件/OS 开关保存后**重启宿主**生效，桥接工具面保存后对新 agent 生效。
//       手写宿主同款 ModuleLoader factory（零构建依赖；仅 require react）。失败面 fail-open：
//       命名空间未被宿主服务时卡片不注册并打一次性可诊断 warn；保存失败区分宿主拒绝/异常并保留草稿。
//       依据：内部决策-057、内部决策-068、内部接口-1 2026-10-31 内部任务-268 增补、内部模块-24 R-da-13/R-da-17/A-da-17。
// 作者：wangp  创建：2026-10-22（内部任务-268 重写 2026-10-31）  版权：MIT（见仓库 LICENSE）
window.__ModuleLoader__.load({
  id: 'ai-coding-methodology',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'ai-coding-methodology';
    const PLUGIN_ROWS = [
      { field: 'pluginWorkflow', zh: '对话式流程引擎', en: 'Workflow engine', descZh: '路由表/计划/执行/调试/评审/收尾全流程', descEn: 'Routing, planning, execution, debugging, review' },
      { field: 'pluginSpecGate', zh: '规格门禁', en: 'Spec gate', descZh: '规格校验、计划门禁与聚合完成链', descEn: 'Spec validation, plan gate, completion chain' },
      { field: 'pluginScout', zh: '探路模式', en: 'Scout mode', descZh: '探索性/一次性交付的轻纪律档位', descEn: 'Lightweight mode for exploratory work' },
      { field: 'pluginTeamGovernance', zh: '团队治理', en: 'Team governance', descZh: 'Run Manifest、审批、租约与 os-observe', descEn: 'Manifests, approvals, leases and OS observation' },
      { field: 'pluginAlgoLoop', zh: '算法迭代', en: 'Algo loop', descZh: '指标契约/实验台账/bad case/基线迭代环', descEn: 'Metrics, experiment ledger, baselines' },
      { field: 'pluginResearchLoop', zh: '研究环', en: 'Research loop', descZh: '研究假设、预注册与实验设计', descEn: 'Hypotheses, preregistration, experiment design' },
    ];
    const FIELD_ORDER = [...PLUGIN_ROWS.map((r) => r.field), 'agentControlBridge', 'osObservation'];
    const DEFAULTS = Object.freeze({
      pluginWorkflow: true, pluginSpecGate: true, pluginScout: false, pluginTeamGovernance: false,
      pluginAlgoLoop: false, pluginResearchLoop: false, agentControlBridge: false, osObservation: true,
    });
    const zh = {
      title: '配置',
      subtitle: '六个方法论插件与工具面开关；插件/系统监测开关保存后重启宿主生效。',
      groupPlugins: '插件开关',
      groupTools: '工具面',
      groupMonitor: '系统监测',
      bridgeLabel: '桥接工具面',
      bridgeDesc: '列出/续聊/等待本会话普通子代理的三个模型工具',
      osLabel: 'OS 监测',
      osDesc: 'SessionStart 的 os-observe 浮现与机会式补位采集（治理摘要保留）',
      osDisabled: '未生效：依赖「团队治理」插件开启',
      restartHint: '保存后重启宿主生效',
      bridgeHint: '保存后新会话/新 agent 生效',
      summary: '已启用 {on}/{total} 个插件 · 桥接工具面{bridge} · OS 监测{os}',
      bridgeOn: '开', bridgeOff: '关', osActive: '生效', osInactive: '未生效',
      save: '保存',
      saving: '保存中…',
      saved: '已保存（插件/系统监测开关重启后生效；桥接工具面新会话生效）',
      unsaved: '有未保存的修改；离开页面会丢弃未保存的更改。',
      verifyFailed: '已提交保存，但读取校验失败：请刷新页面重新同步配置（未保存的草稿会丢失）。',
      rejected: '保存未生效：已重新读取最新配置，请确认后再次保存。',
      error: '保存失败（宿主异常），草稿已保留，可重试。',
      loading: '正在读取配置…',
      readonly: '当前配置为只读（宿主未允许写入该字段）。',
      write: '保存写入当前 profile 的 cordis.patch.yml（与手工编辑同源，保留注释与 `!!js`）。还原＝删除本插件整条目或把对应字段置回默认值。',
    };
    const en = {
      title: 'Configuration',
      subtitle: 'Six methodology plugins and tool/OS toggles; plugin/monitor changes apply after a host restart.',
      groupPlugins: 'Plugins',
      groupTools: 'Tools',
      groupMonitor: 'System monitoring',
      bridgeLabel: 'Agent control bridge',
      bridgeDesc: 'Three model tools to list/message/wait subagents of this session',
      osLabel: 'OS observation',
      osDesc: 'SessionStart os-observe summary and opportunistic collection (governance summary kept)',
      osDisabled: 'Inactive: requires the Team governance plugin',
      restartHint: 'Applies after host restart',
      bridgeHint: 'Applies to new sessions/agents',
      summary: '{on}/{total} plugins enabled · bridge {bridge} · OS observation {os}',
      bridgeOn: 'on', bridgeOff: 'off', osActive: 'active', osInactive: 'inactive',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved (plugin/monitor toggles apply after host restart; bridge applies to new sessions)',
      unsaved: 'Unsaved changes; leaving the page discards them.',
      verifyFailed: 'Save submitted, but re-reading the configuration failed: refresh to resync (unsaved draft will be lost).',
      rejected: 'Save did not take effect: latest configuration reloaded, please confirm and save again.',
      error: 'Save failed (host error). Draft kept; please retry.',
      loading: 'Loading configuration…',
      readonly: 'This configuration is read-only for this host.',
      write: 'Saving writes the current profile cordis.patch.yml (same source as manual editing; comments and `!!js` preserved). To restore: delete the plugin entry or set fields back to defaults.',
    };

    /** volatile 值解包（宿主 snapshot.value 通常为普通布尔；防御引用形态）。 */
    const valueOf = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value);

    /** 从快照取整组字段值（缺字段用 DEFAULTS）。 */
    const readFields = (snapshot) => {
      const value = snapshot?.value ?? {};
      const fields = {};
      for (const field of FIELD_ORDER) {
        const raw = valueOf(value[field]);
        fields[field] = raw === undefined ? DEFAULTS[field] : raw === true;
      }
      return { fields, revision: snapshot?.revision };
    };

    /** 兼容旧单字段形态：布尔 → {agentControlBridge: 布尔}。 */
    const asDraftMap = (input) => (typeof input === 'boolean' ? { agentControlBridge: input } : { ...(input ?? {}) });

    /** 组内差异 → configForms.mutate ops（只提交变更字段）。 */
    const buildSaveOps = (draft, saved) => {
      const next = asDraftMap(draft);
      const prev = saved === undefined ? DEFAULTS : asDraftMap(saved);
      const ops = [];
      for (const field of FIELD_ORDER) {
        if (!(field in next)) continue;
        if (next[field] === true !== (prev[field] === true)) {
          ops.push({ op: 'set', path: [field], value: next[field] === true });
        }
      }
      return ops;
    };

    /** 写后重读校验：ops 中每个字段的快照值都与期望一致才算落盘成功（部分落盘→false）。 */
    const verifySaved = (latestSnapshot, ops) => {
      const { fields } = readFields(latestSnapshot);
      return (Array.isArray(ops) ? ops : []).every((op) => (fields[op.path[0]] === true) === (op.value === true));
    };

    /** 保存：一次 mutate；返回 ok/rejected/error（失败保留草稿；内部任务-273 M-07：错误原文与诊断日志不吞）。 */
    const saveDraft = async (form, opsOrDraft, revision, logger) => {
      const ops = Array.isArray(opsOrDraft) ? opsOrDraft : buildSaveOps(opsOrDraft, DEFAULTS);
      try {
        const ok = await form.mutate(ops, revision);
        if (ok === false) return { ok: false, reason: 'rejected', keepDraft: true };
        return { ok: true };
      } catch (error) {
        // 诊断面：客户端无服务端 logger（跨执行域），保留可选 logger 形参供装配/测试注入；
        // 生产不注入时把错误原文回传给调用方（供测试/上层诊断）；UI 状态行用通用文案，不渲染原文。
        try { logger?.warn?.(`ai-coding-methodology: 配置保存失败：${error?.message ?? error}`); } catch { /* 日志失败不反噬 */ }
        return { ok: false, reason: 'error', keepDraft: true, message: error?.message ?? String(error) };
      }
    };

    /** 读快照并吞掉读取异常（返回 {snapshot, error}）；首读/重读共用，防同一兜底复制两遍。 */
    const readSnapshot = (form) => {
      try {
        return { snapshot: form.getSnapshot(), error: null };
      } catch (error) {
        return { snapshot: null, error };
      }
    };

    /**
     * 保存编排（纯函数，供组件与测试共用）：buildSaveOps→一次 mutate→重读快照逐字段校验。
     * 五态：idle（无变更）/saved（全部落盘）/rejected（宿主拒绝或部分落盘）/error（mutate 异常）/
     * verify-failed（mutate 成功但快照读取两次均失败；单次重读成功则继续判定 saved/rejected）。
     * 不得把状态卡在 saving（内部任务-273 M-06）。
     */
    const performSave = async ({ form, draft, saved, revision, logger }) => {
      const ops = buildSaveOps(draft, saved);
      if (ops.length === 0) return { status: 'idle', ops, latest: null };
      const result = await saveDraft(form, ops, revision, logger);
      let read = readSnapshot(form);
      if (result.ok !== true) return { status: result.reason, ops, latest: read.snapshot, message: result.message };
      // 内部任务-273 M-06：mutate 已推进宿主 revision；此处读取校验失败时**单次重读**，二次仍失败 →
      // 三方态 verify-failed（不谎称「已重新读取」，不提示无出口的重试）；重读成功则采纳最新 revision。
      if (read.snapshot === null) {
        read = readSnapshot(form);
        if (read.snapshot === null) return { status: 'verify-failed', ops, latest: null, message: read.error?.message ?? 'snapshot-read-failed' };
      }
      const applied = verifySaved(read.snapshot, ops);
      return { status: applied ? 'saved' : 'rejected', ops, latest: read.snapshot };
    };

    /** 快照重读状态机：不清除用户脏草稿，但采纳新 revision。 */
    const nextCardState = (state, snapshot) => {
      const { fields, revision } = readFields(snapshot);
      if (state?.dirty === true) return { draft: state.draft, saved: fields, revision, dirty: true };
      return { draft: { ...fields }, saved: fields, revision, dirty: false };
    };

    /** 保存成功后采纳快照 revision 与 saved 基线（可传快照对象或带 getSnapshot 的 form）。 */
    const adoptSavedRevision = (state, latestSnapshot) => {
      const snapshot = latestSnapshot !== null && typeof latestSnapshot === 'object' && typeof latestSnapshot.getSnapshot === 'function'
        ? latestSnapshot.getSnapshot()
        : latestSnapshot;
      const { fields, revision } = readFields(snapshot);
      return { draft: { ...fields }, saved: fields, revision: revision ?? state.revision, dirty: false };
    };

    /** 自绘开关（role=switch；宿主设计 token 内联样式）。 */
    const Switch = ({ checked, disabled, label, onChange, id }) => {
      const on = checked === true;
      return h(
        'button',
        {
          id,
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-label': label,
          disabled,
          onClick: () => { if (!disabled) onChange(!on); },
          style: {
            width: '38px', height: '22px', borderRadius: '11px', border: 'none', padding: '2px',
            background: disabled ? 'var(--dsw-alias-border-l2, #d9d9d9)' : on ? 'var(--dsw-alias-state-business-primary, #1677ff)' : 'var(--dsw-alias-border-l3, #bfbfbf)',
            cursor: disabled ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center',
            justifyContent: on ? 'flex-end' : 'flex-start', transition: 'background 120ms ease', flex: '0 0 auto',
          },
        },
        h('span', { 'aria-hidden': 'true', style: { width: '18px', height: '18px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)' } }),
      );
    };

    /** 行（名称＋一句话说明＋开关）。 */
    const Row = ({ id, title, desc, checked, disabled, onChange, hint }) => h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #eee)' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
        h('label', { htmlFor: id, style: { fontSize: '14px', color: 'var(--dsw-alias-label-primary, inherit)' } }, title),
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)' } }, desc),
        hint ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-warning, #d46b08)' } }, hint) : null,
      ),
      h(Switch, { id, checked, disabled, label: title, onChange }),
    );

    const ConfigCardPage = (props) => {
      const { t, form } = props;
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [state, setState] = React.useState(() => nextCardState(null, form.getSnapshot()));
      const [status, setStatus] = React.useState('idle');

      React.useEffect(() => {
        const off = form.subscribe(() => {
          const snap = form.getSnapshot();
          setSnapshot(snap);
          setState((previous) => nextCardState(previous, snap));
        });
        return off;
      }, [form]);

      const ready = snapshot?.status === 'ready';
      const writable = snapshot?.writable === true;
      const busy = status === 'saving';
      const tertiary = { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)' };

      const setField = (field, next) => {
        setState((previous) => {
          const draft = { ...previous.draft, [field]: next };
          const dirty = FIELD_ORDER.some((f) => (draft[f] === true) !== (previous.saved[f] === true));
          return { ...previous, draft, dirty };
        });
        setStatus('idle');
      };

      const save = async () => {
        setStatus('saving');
        const result = await performSave({ form, draft: state.draft, saved: state.saved, revision: state.revision ?? snapshot?.revision });
        if (result.latest !== null) setSnapshot(result.latest);
        if (result.status === 'idle') { setStatus('idle'); return; }
        if (result.status === 'saved') {
          setState((previous) => adoptSavedRevision(previous, result.latest));
          setStatus('saved');
          return;
        }
        if (result.latest !== null) setState((previous) => nextCardState(previous, result.latest));
        setStatus(result.status);
      };

      const effectiveOs = state.draft.osObservation === true && state.draft.pluginTeamGovernance === true;
      const enabledCount = PLUGIN_ROWS.filter((row) => state.draft[row.field] === true).length;
      const statusText =
        status === 'saved' ? t('saved') : status === 'rejected' ? t('rejected') : status === 'verify-failed' ? t('verifyFailed') : status === 'error' ? t('error') : status === 'saving' ? t('saving') : '';

      return h(
        'section',
        {
          'data-ai-coding-methodology-config': 'v2',
          style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '18px', border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)', borderRadius: '12px', background: 'var(--dsw-alias-bg-primary, transparent)' },
        },
        h('header', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('h3', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, t('title')),
          h('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('subtitle')),
          ready ? h('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-business-primary, #1677ff)' } }, t('summary', {
            on: enabledCount,
            total: PLUGIN_ROWS.length,
            bridge: t(state.draft.agentControlBridge === true ? 'bridgeOn' : 'bridgeOff'),
            os: t(effectiveOs ? 'osActive' : 'osInactive'),
          })) : h('p', { style: tertiary }, t('loading')),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('h4', { style: { margin: '4px 0', fontSize: '13px', fontWeight: 600 } }, t('groupPlugins') + ' · ' + t('restartHint')),
          ...PLUGIN_ROWS.map((row) => h(Row, {
            key: row.field,
            id: `${NS}-${row.field}`,
            title: t('plugin.' + row.field + '.label'),
            desc: t('plugin.' + row.field + '.desc'),
            checked: state.draft[row.field] === true,
            disabled: ready !== true || writable !== true || busy,
            onChange: (next) => setField(row.field, next),
          })),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('h4', { style: { margin: '4px 0', fontSize: '13px', fontWeight: 600 } }, t('groupTools') + ' · ' + t('bridgeHint')),
          h(Row, {
            id: `${NS}-agentControlBridge`,
            title: t('bridgeLabel'),
            desc: t('bridgeDesc'),
            checked: state.draft.agentControlBridge === true,
            disabled: ready !== true || writable !== true || busy,
            onChange: (next) => setField('agentControlBridge', next),
          }),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('h4', { style: { margin: '4px 0', fontSize: '13px', fontWeight: 600 } }, t('groupMonitor') + ' · ' + t('restartHint')),
          h(Row, {
            id: `${NS}-osObservation`,
            title: t('osLabel'),
            desc: t('osDesc'),
            hint: state.draft.pluginTeamGovernance === true ? null : t('osDisabled'),
            checked: state.draft.osObservation === true,
            disabled: ready !== true || writable !== true || busy || state.draft.pluginTeamGovernance !== true,
            onChange: (next) => setField('osObservation', next),
          }),
        ),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button', onClick: save,
            disabled: ready !== true || writable !== true || busy || state.dirty !== true,
            style: { minHeight: '30px', padding: '0 14px', borderRadius: '6px', border: '1px solid var(--dsw-alias-brand-primary, #1677ff)', background: 'var(--dsw-alias-brand-primary, #1677ff)', color: '#fff', cursor: 'pointer', fontWeight: 500 },
          }, busy ? t('saving') : t('save')),
          state.dirty === true ? h('span', { role: 'status', 'aria-live': 'polite', style: tertiary }, t('unsaved')) : null,
          statusText === '' ? null : h('span', { role: 'status', 'aria-live': 'polite', style: tertiary }, statusText),
        ),
        ready === true && writable !== true ? h('p', { role: 'status', style: tertiary }, t('readonly')) : null,
        h('p', { style: tertiary }, t('write')),
      );
    };

    const ConfigCard = (props) => (props?.view === 'summary' ? null : h(ConfigCardPage, props));

    const localeDict = (lang) => {
      const out = lang === 'zh' ? { ...zh } : { ...en };
      for (const row of PLUGIN_ROWS) {
        out['plugin.' + row.field + '.label'] = lang === 'zh' ? row.zh : row.en;
        out['plugin.' + row.field + '.desc'] = lang === 'zh' ? row.descZh : row.descEn;
      }
      return out;
    };

    const apply = (ctx) => {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: localeDict('zh'), en: localeDict('en') }));
      const form = ctx.configForms.get(NS);
      ctx.effect(() => {
        let done = false;
        let off = () => {};
        try {
          const mirror = ctx.configForms.describe();
          const check = () => {
            if (done) return;
            try {
              const view = mirror.getSnapshot()?.view;
              if (view === undefined || view === null) return;
              done = true;
              const namespaces = Array.isArray(view.namespaces) ? view.namespaces : [];
              if (!namespaces.some((entry) => entry?.ns === NS)) {
                ctx.logger?.warn?.('[ai-coding-methodology] 配置命名空间未被宿主服务（旧宿主/未重启/插件条目停用？）');
              }
            } catch { /* 诊断面 fail-open */ }
          };
          off = mirror.subscribe(check) ?? (() => {});
          check();
        } catch { /* describe 不可用：诊断面 fail-open */ }
        return () => { try { off(); } catch { /* 退订失败不阻断 */ } };
      });
      ctx.effect(() => ctx.configForms.whileServed([NS], () =>
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: NS, locale: NS, inject: () => ({ t, form }) }, ConfigCard),
        ),
      ));
    };

    return {
      inject: ['slots', 'configForms', 'locale'],
      apply,
      buildSaveOps,
      readFields,
      verifySaved,
      readSnapshotDraft: (snapshot) => ({ draft: readFields(snapshot).fields.agentControlBridge === true, revision: readFields(snapshot).revision }),
      saveDraft,
      performSave,
      nextCardState,
      adoptSavedRevision,
      PLUGIN_ROWS,
      FIELD_ORDER,
      DEFAULTS,
      localeDict,
    };
  },
});

// 文件：strategies/relay.mjs
// 描述：relay 族策略执行器（内部决策-037 决策 2，一族一文件）——待投递中继：被中继的提醒先落
//       宿主存储面，在 deliverOn 事件投递。策略逻辑（入队门控、连击计数与重置、上限降级、
//       覆盖去重与容量上限、独立成帧、坏帧丢弃并计降级提醒）全部在引擎；宿主只经端口提供
//       存储原语 {readState, writeState}。帧格式独立成帧（{text, sessionKey, ts}）。
//       **入队门控（与既有 shim 等价）**：仅 triggerEvent 事件参与计数；只有 `blocked===true`
//       推进连击，`blocked===false` 不推进也不清零（非阻断处理器的文本照常入队）；`deliverOn`
//       事件按会话归零连击预算；`blocked===true` 且未超上限**不入队**（由调用方直译阻断）；
//       超上限则入队「原正文 + capNote」降级帧。连击状态为**多会话字典**（内部任务-347/内部未决-277②：
//       并发会话交替不得互相清零——burstCap 逐会话独立可达；旧单键对 2026-10-01~2026-11-07 曾以
//       「避免原型成员键」为由收敛单键，本批受控放宽为字典＋**键前缀 `s:`**——任意会话名（含
//       `__proto__`/`constructor`）经前缀后不可能命中继承键，防护语义保持且交替场景计数不丢；
//       deliverOn 归零即删键，字典不随会话数慢增长；旧字段 streakKey/streakCount 首读迁移）。
//       容量淘汰计数同款分账（内部任务-347/内部未决-274：droppedBySession 字典＋`s:` 前缀——他会话被
//       挤出的帧数只报给原会话，不被当前投递会话吞掉；旧 droppedByLimit 单值首读迁移入哨兵键
//       `s:__legacy__`——无会话归属的旧计数由任意会话首次 deliverOn 消化）。
//       执行器签名统一为 (env, hp, ports)：env={context,host,matrix}，hp=params[host]。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：被 src/engine.mjs 汇总消费（executors 表），不直接被外部调用
// 自检：node --test "plugin-core/tests/engine.test.mjs"

/** 帧形态判据（坏帧在投递时丢弃并计降级提醒，不静默吞）。 */
const isFrame = (f) =>
  Boolean(f) && typeof f === 'object' && typeof f.text === 'string' && f.text !== '' && typeof f.sessionKey === 'string' && f.sessionKey !== '' && typeof f.ts === 'number';

/** 字典键前缀（内部任务-347）：使任意会话名（含 `__proto__`/`constructor` 等原型成员名）不可能命中继承键。 */
const dictKey = (sessionKey) => `s:${sessionKey}`;

/** 状态归一：宿主存储面为空/损坏时给出空状态（不抛错——策略逻辑自持状态形状）。
 *  多会话字典（内部任务-347/内部未决-277②/274）：streaks/droppedBySession 以 `s:` 前缀键分账；
 *  旧单键对/单值（streakKey/streakCount/droppedByLimit）首读迁移后删除（混版本回滚方向：
 *  旧 shim 读新态剥新字段＝回退旧语义帧保留，正向首读迁移自愈——见 内部模块-16 注记）。 */
const normalizeState = (raw) => {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!Array.isArray(s.frames)) s.frames = [];
  if (!s.streaks || typeof s.streaks !== 'object' || Array.isArray(s.streaks)) s.streaks = {};
  if (!s.droppedBySession || typeof s.droppedBySession !== 'object' || Array.isArray(s.droppedBySession)) s.droppedBySession = {};
  let migrated = s.__legacyAbsorbed === true; // 宿主读侧已做的旧形状吸收（pending 迁移/旧字段并入）也须写盘持久
  delete s.__legacyAbsorbed;
  // 旧单键对迁移：streakKey/streakCount → streaks['s:<key>']
  if (typeof s.streakKey === 'string' && s.streakKey !== '' && Number.isInteger(s.streakCount) && s.streakCount > 0) {
    const k = dictKey(s.streakKey);
    if (!Object.hasOwn(s.streaks, k)) s.streaks[k] = s.streakCount;
    migrated = true;
  }
  if ('streakKey' in s) { delete s.streakKey; migrated = true; }
  if ('streakCount' in s) { delete s.streakCount; migrated = true; }
  // 旧淘汰单值迁移：无帧键可归属，记入哨兵键（首跳投递提醒消化）
  if (Number.isInteger(s.droppedByLimit) && s.droppedByLimit > 0) {
    const k = dictKey('__legacy__');
    s.droppedBySession[k] = (s.droppedBySession[k] ?? 0) + s.droppedByLimit;
    migrated = true;
  }
  if ('droppedByLimit' in s) { delete s.droppedByLimit; migrated = true; }
  s.__migrated = migrated;
  return s;
};

/**
 * 投递：只取当前会话的帧交付，他会话帧保留回待投递面（投给当前会话即跨会话串话、
 * 丢弃即丢原会话提醒——保留待原会话下次投递）；坏帧丢弃计数。淘汰观测见入队支。
 */
const drainPending = (state, sessionKey) => {
  const delivered = [];
  const kept = [];
  let dropped = 0;
  for (const frame of state.frames) {
    if (!isFrame(frame)) {
      dropped += 1;
    } else if (frame.sessionKey === sessionKey) {
      delivered.push(frame);
    } else {
      kept.push(frame);
    }
  }
  state.frames = kept;
  return { delivered, dropped };
};

/**
 * 规则 id → 执行器映射（引擎按 ruleId 分派）。
 */
export const executors = {
  'stop-pending-relay': (env, hp, ports) => {
    // store 门禁位：PLUGIN_DATA（宿主注入存储面）或 $ 开头的宿主存储路径模板（内部决策-038 kimi 列，
    // 如 "$KIMI_CODE_HOME/plugin-data/<id>"——经端口读写，值本身仅为声明面；非此两类即 fail-closed）。
    if (!(hp.store === 'PLUGIN_DATA' || (typeof hp.store === 'string' && hp.store.startsWith('$') && hp.store.length > 1))) {
      throw new Error(`stop-pending-relay: 不支持的 store ${String(hp.store)}（合法：PLUGIN_DATA 或 $ 开头的宿主存储路径模板——存储面经端口注入）`);
    }
    const ctx = env.context ?? {};
    const sessionKey = ctx.sessionKey;
    if (typeof sessionKey !== 'string' || sessionKey === '') {
      throw new Error('stop-pending-relay: 缺 sessionKey（ctx.sessionKey 必填，不设缺省——跨会话串话比显式报错更坏）');
    }
    const state = normalizeState(ports.readState());
    let dirty = state.__migrated === true; // 迁移本身是状态变更（旧字段删除/并入字典须写盘持久）
    delete state.__migrated;

    if (ctx.event === hp.deliverOn) {
      const { delivered, dropped } = drainPending(state, sessionKey);
      if (delivered.length > 0 || dropped > 0) dirty = true;
      // 每个用户轮次重置**本会话**连击预算（多会话字典：他会话键不动，内部未决-277②；归零即删键）
      const sk = dictKey(sessionKey);
      if (Object.hasOwn(state.streaks, sk)) {
        delete state.streaks[sk];
        dirty = true;
      }
      // 淘汰提醒分账（内部未决-274）：只报当前会话键的淘汰数（含哨兵键——旧单值迁移件随首次投递消化）
      const droppedKeys = [sk, dictKey('__legacy__')];
      let droppedNote = 0;
      for (const dk of droppedKeys) {
        if (Object.hasOwn(state.droppedBySession, dk)) {
          droppedNote += state.droppedBySession[dk];
          delete state.droppedBySession[dk];
        }
      }
      if (droppedNote > 0) {
        delivered.push({ text: `[relay] ${droppedNote} 条待投递帧因容量上限被淘汰`, sessionKey, ts: Date.now() });
        dirty = true;
      }
      if (dirty) ports.writeState(state);
      if (dropped > 0) delivered.push({ text: `[relay] 丢弃 ${dropped} 条 malformed 待投递帧`, sessionKey, ts: Date.now() });
      return { delivered, dropped };
    }

    if (ctx.event !== hp.triggerEvent) {
      return { enqueued: false, reason: 'event-not-relayed' }; // 非触发事件不参与计数/入队，也不写盘
    }

    // 连击（多会话字典，内部未决-277②）：只有阻断调用推进**本会话**计数；未阻断不清零也不推进；
    // 他会话触发/投递不影响本会话键
    const streakK = dictKey(sessionKey);
    if (ctx.blocked === true) {
      state.streaks[streakK] = (Object.hasOwn(state.streaks, streakK) ? state.streaks[streakK] : 0) + 1;
      dirty = true;
    }
    const streak = Object.hasOwn(state.streaks, streakK) ? state.streaks[streakK] : 0;
    const overCap = Number.isInteger(hp.burstCap) && streak > hp.burstCap;
    const text = typeof ctx.text === 'string' ? ctx.text.trim() : '';

    // 阻断且未超上限：不入队（由调用方直译阻断；对齐既有 shim 门控）
    if (ctx.blocked === true && !overCap) {
      if (dirty) ports.writeState(state);
      return { degraded: false, enqueued: false, streak, text };
    }

    const isDegraded = ctx.blocked === true && overCap;
    if (text === '' && !isDegraded) {
      if (dirty) ports.writeState(state); // 空文本不入队（不造自致坏帧）
      return { enqueued: false, reason: 'empty-text', streak };
    }
    // capNote 只附加在「阻断且超上限」的降级帧上（非阻断处理器的普通提醒不得被错标为降级）
    const capNoteText = typeof hp.capNote === 'string' ? hp.capNote : '[relay] 连击上限，降级为待投递提醒';
    const frameText = isDegraded ? `${text || '（阻断钩子未提供可读原因）'}\n${capNoteText}` : text;
    const frame = { text: frameText, sessionKey, ts: Date.now() };
    const sameIdx = state.frames.findIndex((f) => f && f.sessionKey === sessionKey && f.text === frameText);
    if (sameIdx >= 0) state.frames.splice(sameIdx, 1); // 覆盖去重：同会话同文本保留最新一帧
    if (Number.isInteger(hp.pendingLimit) && state.frames.length >= hp.pendingLimit) {
      const evicted = state.frames[0]; // 容量上限：丢最旧——计数不静默（分账到被挤出帧的原会话键，内部未决-274）
      state.frames.shift();
      if (evicted && typeof evicted.sessionKey === 'string' && evicted.sessionKey !== '') {
        const ek = dictKey(evicted.sessionKey);
        state.droppedBySession[ek] = (Object.hasOwn(state.droppedBySession, ek) ? state.droppedBySession[ek] : 0) + 1;
      }
    }
    state.frames.push(frame);
    ports.writeState(state);
    return { degraded: isDegraded, enqueued: true, frame, streak };
  },
};

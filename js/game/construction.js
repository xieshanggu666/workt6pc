/**
 * FG.Construction —— 蓝图施工管理器
 *
 * 数据流：
 *  蓝图框选 → 旋转预览 → submitPlan()（按科技与地形逐格校验，全部合法才提交）
 *  每个蓝图格生成一个「施工点」site（建筑幻影，占用格子但不参与生产/物流）。
 *
 * 建材：
 *  - 来源为全图「物流」：箱子 + 地面物料堆（建筑拆除保留的物料），每 tick 按
 *    提交顺序轮转（round-robin）公平预留，每点每 tick 至多预留 CONSTRUCT_PULL 件；
 *  - 预留时即从物流中取出、存入 site.have —— 已预留的建材不会被生产调度器取走
 *    （物品已离开箱子/地面堆），达成「从物流中预留并消耗」；
 *  - 缺料则该点保持「等待建材」，料到达后自动继续（无超时、可无限等待）；
 *  - 取消（单点或整张蓝图）时已预留建材返还：优先放回就近箱子，放不下则落地为地面堆。
 *
 * 建成：
 *  - 建材齐后按工时推进进度，完成即在原格生成真实建筑（保留蓝图方向/配方），
 *    注册到地图与仿真，自动接入生产调度（机械臂按需物流在同一 tick 即识别新消费者）；
 *    矿机绑定矿脉，同格地面物料自动回收。
 *
 * 存档：施工点（蓝图 id、建筑类型、坐标、方向、配方、已预留建材、进度、轮转游标）
 *  全部序列化，读档后继续等待/施工。
 */
FG.Construction = class Construction {
  constructor() {
    this.game = null;
    this.sites = new Map();       // key 'x,y' -> site
    this.plans = new Map();       // planId -> {id,name,siteKeys:Set}
    this.order = [];              // site key 提交顺序（同级轮转公平）
    this.rr = 0;                  // 每 tick 取料轮转起点
    this.seq = 0;
  }

  init(game) { this.game = game; }
  reset() { this.sites.clear(); this.plans.clear(); this.order.length = 0; this.rr = 0; }

  siteAt(x, y) { return this.sites.get(FG.Utils.key(x, y)) || null; }
  isSite(x, y) { return this.sites.has(FG.Utils.key(x, y)); }

  // ================= 蓝图几何（纯函数，预览/提交共用） =================
  /**
   * 蓝图实体在锚点 (ax,ay)、整体旋转 rot(0~3) 下的世界坐标与方向。
   * 归一化坐标以 (0,0) 为原点；rot 为绕原点的 90° 顺时针旋转。
   */
  static entityCell(e, ax, ay, rot) {
    let lx = e.lx, ly = e.ly, dir = e.dir;
    for (let i = 0; i < rot; i++) {
      const nx = -ly, ny = lx;
      lx = nx; ly = ny;
      dir = (dir + 1) % 4;
    }
    return { x: ax + lx, y: ay + ly, dir };
  }

  /** 蓝图在某旋转下占用的全部格子（含世界坐标/方向/类型/配方） */
  static cells(bp, ax, ay, rot) {
    return bp.entities.map(e => {
      const c = Construction.entityCell(e, ax, ay, rot);
      return { type: e.type, recipe: e.recipe || null, lx: e.lx, ly: e.ly, x: c.x, y: c.y, dir: c.dir };
    });
  }

  // ================= 框选生成蓝图 =================
  /** 框选矩形（世界格，无需排序）内的全部建筑，生成归一化蓝图；无建筑返回 null */
  capture(x0, y0, x1, y1) {
    const xa = Math.max(0, Math.min(x0, x1)), xb = Math.min(this.game.map.w - 1, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1)), yb = Math.min(this.game.map.h - 1, Math.max(y0, y1));
    const entities = [];
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const b = this.game.map.buildingAt(x, y);
        if (!b) continue;
        // 科技校验：未解锁的建筑（理论上不会存在）不允许进入蓝图
        if (!this.game.research.isBuildingUnlocked(b.type)) continue;
        entities.push({
          lx: x - xa, ly: y - ya,
          type: b.type, dir: b.dir,
          recipe: b.recipe || null,
        });
      }
    }
    if (!entities.length) return null;
    return { entities, w: xb - xa + 1, h: yb - ya + 1 };
  }

  // ================= 科技 / 地形校验 =================
  /**
   * 蓝图在锚点放置的逐格校验。
   * 返回 {allOk, cells, bad:Set('x,y'), locked:Set(type), count}。
   * 科技：任一建筑未解锁 → locked；地形/占位/越界 → bad。
   */
  validate(bp, ax, ay, rot) {
    const game = this.game;
    const cells = Construction.cells(bp, ax, ay, rot);
    const bad = new Set();
    const locked = new Set();
    for (const c of cells) {
      if (!game.research.isBuildingUnlocked(c.type)) { locked.add(c.type); bad.add(FG.Utils.key(c.x, c.y)); continue; }
      if (this.siteBlocked(c.x, c.y) || !game.canPlace(c.type, c.x, c.y)) bad.add(FG.Utils.key(c.x, c.y));
    }
    return { allOk: !bad.size, cells, bad, locked, count: cells.length };
  }

  /** 提交前格子是否被占用：真实建筑、已有施工点均算 */
  siteBlocked(x, y) {
    const m = this.game.map;
    return !m.inBounds(x, y) || m.isOccupied(x, y) || this.sites.has(FG.Utils.key(x, y));
  }

  /** 蓝图建材总需求（汇总所有实体） */
  static totalCost(bp) {
    const total = {};
    for (const e of bp.entities) {
      for (const [item, n] of Object.entries(FG.Buildings.costOf(e.type))) {
        total[item] = (total[item] || 0) + n;
      }
    }
    return total;
  }

  // ================= 提交施工计划 =================
  /**
   * 提交整张蓝图（调用前应已 validate 通过）。
   * 返回 planId；逐格创建施工点并占位。
   */
  submitPlan(bp, ax, ay, rot, name) {
    const v = this.validate(bp, ax, ay, rot);
    if (!v.allOk) {
      this.game.logMsg('施工计划被拒绝：存在未解锁建筑或不可放置格', 'error');
      return null;
    }
    const planId = 'bp' + (++this.seq) + '_' + Date.now().toString(36);
    const plan = { id: planId, name: name || ('蓝图 ' + this.seq), siteKeys: new Set() };
    for (const c of v.cells) this.addSite(plan, c);
    this.plans.set(planId, plan);
    this.game.logMsg(`📋 施工计划已提交：${plan.name}（${plan.siteKeys.size} 个建筑，等待物流配送建材）`, 'info');
    FG.Events.emit('construct:change');
    return planId;
  }

  addSite(plan, c) {
    const need = FG.Buildings.costOf(c.type);
    const totalItems = Object.values(need).reduce((a, b) => a + b, 0);
    const site = {
      planId: plan.id,
      type: c.type, x: c.x, y: c.y, dir: c.dir,
      recipe: c.recipe || null,
      need,                       // {item: 总需求}
      have: {},                   // {item: 已从物流预留数}
      progress: 0,
      buildTime: FG.Config.CONSTRUCT_BASE_TICKS + totalItems * FG.Config.CONSTRUCT_TICKS_PER_ITEM,
      status: 'waiting',          // waiting（缺料等待） | building（施工中）
    };
    const k = FG.Utils.key(c.x, c.y);
    this.sites.set(k, site);
    plan.siteKeys.add(k);
    this.order.push(k);
  }

  // ================= 取消 / 返还 =================
  /** 取消单个施工点（返还已预留建材），并从其蓝图中摘除 */
  cancelSite(site) {
    this.refund(site);
    const k = FG.Utils.key(site.x, site.y);
    this.sites.delete(k);
    const oi = this.order.indexOf(k);
    if (oi >= 0) this.order.splice(oi, 1);
    const plan = this.plans.get(site.planId);
    if (plan) {
      plan.siteKeys.delete(k);
      if (!plan.siteKeys.size) this.plans.delete(plan.id);
    }
    this.game.logMsg(`已取消施工：${FG.Buildings.byId(site.type).name}（建材已返还物流）`, 'info');
    FG.Events.emit('construct:change');
  }

  /** 取消整张蓝图的全部施工点（缺料等待的也一并取消，已预留全部返还） */
  cancelPlan(planId) {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const keys = Array.from(plan.siteKeys);
    for (const k of keys) {
      const site = this.sites.get(k);
      if (site) { this.refund(site); this.sites.delete(k); }
      const oi = this.order.indexOf(k);
      if (oi >= 0) this.order.splice(oi, 1);
    }
    this.plans.delete(planId);
    this.game.logMsg(`已取消施工计划：${plan.name}（${keys.length} 个施工点，建材全部返还）`, 'info');
    FG.Events.emit('construct:change');
  }

  /** 已预留建材返还：优先放回全图最近的可容纳箱子，余量落到施工点地面堆 */
  refund(site) {
    const m = this.game.map;
    for (const [item, count] of Object.entries(site.have)) {
      let left = count;
      // 按曼哈顿距离就近选择箱子（与取料 pullOne 的物流范围一致），逐个尝试
      const chests = [];
      for (const b of m.buildings.values()) {
        if (b.type === 'chest') chests.push({ b, d: Math.abs(b.x - site.x) + Math.abs(b.y - site.y) });
      }
      chests.sort((a, c) => a.d - c.d);
      for (const { b } of chests) {
        if (left <= 0) break;
        left = this.game.tryChestAdd(b, item, left);
      }
      // 余量落地为地面堆（自由货物，可被任何产线取用）
      if (left > 0) m.pileAdd(site.x, site.y, item, left);
    }
  }

  // ================= 每 tick：物流预留 → 施工 → 建成接入调度 =================
  tick() {
    if (!this.order.length) return;
    // 轮转起点取模（施工点会在建成/取消时从 order 摘除）
    if (this.rr >= this.order.length) this.rr = 0;
    const start = this.rr;
    for (let n = 0; n < this.order.length; n++) {
      const idx = (start + n) % this.order.length;
      const site = this.sites.get(this.order[idx]);
      if (site) this.updateSite(site);
    }
    this.rr = (start + 1) % Math.max(1, this.order.length);
  }

  updateSite(site) {
    // 1. 缺料：每 tick 至多从物流中预留 CONSTRUCT_PULL 件（多物品按 need 顺序）
    if (!this.needList(site)) {
      if (site.status !== 'building') { site.status = 'building'; FG.Events.emit('construct:change'); }
      // 2. 建材齐：推进施工进度
      site.progress++;
      if (site.progress >= site.buildTime) this.complete(site);
      return;
    }
    if (site.status !== 'waiting') { site.status = 'waiting'; FG.Events.emit('construct:change'); }
    let budget = FG.Config.CONSTRUCT_PULL;
    for (const item of Object.keys(site.need)) {
      while (budget > 0 && (site.have[item] || 0) < site.need[item]) {
        if (!this.pullOne(site.x, site.y, item)) break; // 物流中暂无该建材：等待
        site.have[item] = (site.have[item] || 0) + 1;
        budget--;
      }
      if (budget <= 0) break;
    }
  }

  /** 返回第一件仍缺的物品；不缺返回 null */
  needList(site) {
    for (const item of Object.keys(site.need)) {
      if ((site.have[item] || 0) < site.need[item]) return item;
    }
    return null;
  }

  // ================= 从物流中取 1 件建材（箱子 → 地面堆） =================
  pullOne(x, y, item) {
    const m = this.game.map;
    let best = null, bestD = Infinity;
    for (const b of m.buildings.values()) {
      if (b.type !== 'chest') continue;
      const slot = b.chest.find(s => s.type === item && s.count > 0);
      if (!slot) continue;
      const d = Math.abs(b.x - x) + Math.abs(b.y - y);
      if (d < bestD) { bestD = d; best = { chest: b, slot }; }
    }
    if (best) { best.slot.count--; return true; }
    // 无箱子：从地面物料堆就近寻找（拆除保留物料也可作建材）
    let pile = null, pileD = Infinity;
    for (const [k, p] of m.piles) {
      if (!p.some(s => s.type === item && s.count > 0)) continue;
      const [px, py] = k.split(',').map(Number);
      const d = Math.abs(px - x) + Math.abs(py - y);
      if (d < pileD) { pileD = d; pile = [px, py]; }
    }
    if (pile) return m.pileTake(pile[0], pile[1], item) === item;
    return false;
  }

  // ================= 建成：生成真实建筑，接入生产调度 =================
  complete(site) {
    const game = this.game;
    const k = FG.Utils.key(site.x, site.y);
    const b = FG.Map.create(site.type, site.x, site.y, site.dir);
    if (site.recipe) {
      b.recipe = site.recipe;
      FG.Map.syncRecipeSlots(b);
    }
    if (b.type === 'miner') b.oreType = game.map.oreAt(site.x, site.y);
    // 占位摘除（施工点不再阻塞），注册真实建筑
    this.sites.delete(k);
    const oi = this.order.indexOf(k);
    if (oi >= 0) this.order.splice(oi, 1);
    const plan = this.plans.get(site.planId);
    if (plan) {
      plan.siteKeys.delete(k);
      if (!plan.siteKeys.size) {
        game.logMsg(`✅ 施工计划完成：${plan.name}（已接入生产调度）`, 'unlock');
        this.plans.delete(plan.id);
      }
    }
    game.map.register(b);
    game.sim.register(b);
    // 同格地面物料（返还溢出物/旧建筑拆除遗留）自动回收
    game.absorbPile(b);
    if (game.selection === site) game.selectBuilding(b);
    FG.Events.emit('construct:done', b);
    FG.Events.emit('construct:change');
  }

  // ================= 施工点汇总（UI） =================
  summary() {
    let waiting = 0, building = 0;
    const need = {};
    for (const s of this.sites.values()) {
      if (s.status === 'building') building++;
      else waiting++;
      for (const item of Object.keys(s.need)) {
        const miss = s.need[item] - (s.have[item] || 0);
        if (miss > 0) need[item] = (need[item] || 0) + miss;
      }
    }
    return { total: this.sites.size, waiting, building, need, plans: this.plans.size };
  }

  /** 某施工点当前进度 0..1 */
  progressOf(site) {
    if (site.status === 'waiting') {
      let n = 0, d = 0;
      for (const item of Object.keys(site.need)) {
        d += site.need[item];
        n += Math.min(site.have[item] || 0, site.need[item]);
      }
      return d ? n / d * 0.5 : 0.5; // 等待阶段最多显示一半
    }
    return 0.5 + 0.5 * Math.min(1, site.progress / site.buildTime);
  }

  // ================= 存档 =================
  serialize() {
    const sites = [];
    for (const s of this.sites.values()) {
      sites.push({
        planId: s.planId, type: s.type, x: s.x, y: s.y, dir: s.dir,
        recipe: s.recipe, need: s.need, have: s.have,
        progress: s.progress, buildTime: s.buildTime, status: s.status,
      });
    }
    const plans = [];
    for (const p of this.plans.values()) plans.push({ id: p.id, name: p.name, siteKeys: Array.from(p.siteKeys) });
    return { sites, plans, order: this.order.slice(), rr: this.rr, seq: this.seq };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    for (const ss of (data.sites || [])) {
      const site = {
        planId: ss.planId, type: ss.type, x: ss.x, y: ss.y, dir: ss.dir || 0,
        recipe: ss.recipe || null,
        need: ss.need || FG.Buildings.costOf(ss.type),
        have: ss.have || {},
        progress: ss.progress || 0,
        buildTime: ss.buildTime || FG.Config.CONSTRUCT_BASE_TICKS,
        status: ss.status === 'building' ? 'building' : 'waiting',
      };
      this.sites.set(FG.Utils.key(ss.x, ss.y), site);
    }
    for (const sp of (data.plans || [])) {
      // 仅恢复仍含施工点的蓝图
      const keys = (sp.siteKeys || []).filter(k => this.sites.has(k));
      if (keys.length) this.plans.set(sp.id, { id: sp.id, name: sp.name, siteKeys: new Set(keys) });
    }
    // 无蓝图归属的施工点：重建一个兜底蓝图，保证完成/取消时结构一致
    for (const s of this.sites.values()) {
      if (!this.plans.has(s.planId)) {
        this.plans.set(s.planId, { id: s.planId, name: '蓝图（读档恢复）', siteKeys: new Set([FG.Utils.key(s.x, s.y)]) });
      }
    }
    this.order = (data.order || []).filter(k => this.sites.has(k));
    // 补上任何遗漏的顺序
    for (const k of this.sites.keys()) if (!this.order.includes(k)) this.order.push(k);
    this.rr = data.rr || 0;
    this.seq = data.seq || 0;
  }
};

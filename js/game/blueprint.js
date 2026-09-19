/**
 * FG.Blueprint —— 蓝图：框选捕获、旋转、成本汇总、科技/地形校验
 * FG.Construction —— 施工计划：从物流预留并消耗建材、缺料等待、取消返还、
 *                     建成后接入生产调度、施工进度随存档恢复
 *
 * 施工模型：
 *  - 计划按条目顺序逐栋施工；每 tick 为「当前待建建筑」从物流（箱子→地面物料堆）
 *    拉取缺口建材入计划库存（预留即移出物流，不再被机械臂/调度取走）；
 *  - 建材不足时计划处于「缺料等待」，物流补齐后自动继续；
 *  - 库存凑齐该建筑成本后消耗库存、落成建筑（map/sim 注册 + 配方/筛选/优先级还原），
 *    即自动纳入每 tick 的按需物流调度；
 *  - 取消计划：库存中已预留的建材返还物流（优先放回箱子，余下落到地面堆），
 *    已建成的建筑保留；
 *  - 计划整体序列化，读档后续建。
 */
FG.Blueprint = (() => {

  /** 框选捕获：把矩形区域内的建筑存为相对坐标蓝图（含配方/筛选/按需/优先级） */
  function capture(map, x0, y0, x1, y1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const entries = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const b = map.buildingAt(x, y);
        if (!b) continue;
        entries.push({
          type: b.type, dx: x - minX, dy: y - minY, dir: b.dir || 0,
          recipe: b.recipe || null,
          filter: b.filter || null,
          demandMode: !!b.demandMode,
          priority: b.priority || 'normal',
        });
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, entries };
  }

  /** 顺时针旋转 90°：条目坐标与朝向同步旋转 */
  function rotate(bp) {
    return {
      w: bp.h, h: bp.w,
      entries: bp.entries.map(e => ({
        type: e.type, dx: bp.h - 1 - e.dy, dy: e.dx, dir: ((e.dir || 0) + 1) % 4,
        recipe: e.recipe || null,
        filter: e.filter || null,
        demandMode: !!e.demandMode,
        priority: e.priority || 'normal',
      })),
    };
  }

  /** 蓝图建材总成本 {item: n} */
  function costOf(bp) {
    const total = {};
    for (const e of bp.entries) {
      const c = FG.Buildings.costOf(e.type);
      for (const k of Object.keys(c)) total[k] = (total[k] || 0) + c[k];
    }
    return total;
  }

  /**
   * 放置校验（科技 + 地形/占用 + 施工计划占格）：
   * 返回 { ok, reason, cells:[{x,y,ok,reason}] }，cells 与 entries 同序（预览着色用）。
   */
  function validate(game, bp, ox, oy) {
    const cells = [];
    let ok = true;
    const locked = new Set();
    let blocked = 0;
    for (const e of bp.entries) {
      const x = ox + e.dx, y = oy + e.dy;
      let cok = true, reason = '';
      if (!game.research.isBuildingUnlocked(e.type)) {
        cok = false; reason = 'tech';
        locked.add(FG.Buildings.byId(e.type).name);
      } else if (!game.canPlace(e.type, x, y)) {
        cok = false; reason = 'terrain'; blocked++;
      } else if (game.construction && game.construction.entryAt(x, y)) {
        cok = false; reason = 'planned'; blocked++;
      }
      if (!cok) ok = false;
      cells.push({ x, y, ok: cok, reason });
    }
    let msg = '';
    if (locked.size) msg = '科技未解锁：' + Array.from(locked).join('、');
    else if (blocked) msg = blocked + ' 个位置被占用 / 地形不符 / 已有施工计划';
    return { ok, reason: msg, cells };
  }

  return { capture, rotate, costOf, validate };
})();

// ============================================================
FG.Construction = class Construction {
  constructor(game) {
    this.game = game;
    this.plans = [];   // [{id,name,entries:[{...state}],stock:{},cursor,timer,waiting}]
    this.seq = 1;
  }

  /** 提交施工计划：蓝图条目落到世界坐标，逐栋备料施工 */
  addPlan(bp, ox, oy) {
    const plan = {
      id: 'P' + (this.seq++),
      name: '蓝图 ' + bp.w + '×' + bp.h + ' #' + (this.seq - 1),
      entries: bp.entries.map(e => ({
        type: e.type, x: ox + e.dx, y: oy + e.dy, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        state: 'wait',           // wait | done | skip
      })),
      stock: {},                 // 已预留（从物流移入计划）的建材
      cursor: 0,
      timer: 0,
      waiting: false,            // 缺料等待
    };
    this.plans.push(plan);
    FG.Events.emit('construction:change');
    return plan;
  }

  /** 某格是否有待建条目（校验/悬浮提示用） */
  entryAt(x, y) {
    for (const p of this.plans) {
      for (const e of p.entries) {
        if (e.state === 'wait' && e.x === x && e.y === y) return { plan: p, entry: e };
      }
    }
    return null;
  }

  // ================= 主循环 =================
  tick() {
    for (let i = this.plans.length - 1; i >= 0; i--) {
      const p = this.plans[i];
      p.waiting = false;
      // 推进到下一个待建条目
      while (p.cursor < p.entries.length && p.entries[p.cursor].state !== 'wait') p.cursor++;
      if (p.cursor >= p.entries.length) {
        this.finish(p);
        this.plans.splice(i, 1);
        continue;
      }
      const e = p.entries[p.cursor];
      // 落成前复验地形/占用：提交后该格可能已被占用
      if (!this.game.canPlace(e.type, e.x, e.y)) {
        e.state = 'skip';
        this.game.logMsg('⚠ 「' + p.name + '」跳过 (' + e.x + ',' + e.y + ') '
          + FG.Buildings.byId(e.type).name + '：位置被占用或地形不符', 'error');
        continue;
      }
      // 从物流预留该建筑的缺口建材（预留即移出物流）
      const cost = FG.Buildings.costOf(e.type);
      let missing = false;
      for (const item of Object.keys(cost)) {
        const want = cost[item] - (p.stock[item] || 0);
        if (want <= 0) continue;
        const got = this.pullFromLogistics(item, want);
        if (got > 0) p.stock[item] = (p.stock[item] || 0) + got;
        if (got < want) missing = true;
      }
      if (missing) { p.waiting = true; continue; }   // 缺料等待
      // 落成节奏：相邻建筑间隔 CONSTRUCT_BUILD_INTERVAL tick
      if (p.timer > 0) { p.timer--; continue; }
      // 消耗库存建材，落成建筑并接入生产调度
      for (const item of Object.keys(cost)) {
        p.stock[item] -= cost[item];
        if (p.stock[item] <= 0) delete p.stock[item];
      }
      this.buildEntry(e);
      e.state = 'done';
      p.timer = FG.Config.CONSTRUCT_BUILD_INTERVAL;
      p.cursor++;
      FG.Events.emit('construction:change');
    }
  }

  /** 落成一栋建筑：注册进地图与仿真，还原产线配置（配方/筛选/按需/优先级） */
  buildEntry(e) {
    const g = this.game;
    const b = FG.Map.create(e.type, e.x, e.y, e.dir);
    if (b.type === 'miner') b.oreType = g.map.oreAt(e.x, e.y);
    g.map.register(b);
    g.sim.register(b);   // 接入生产调度：纳入每 tick 调度/传送带/机械臂/生产更新
    if (e.recipe && b.def.recipeBuilding && g.research.isRecipeUnlocked(e.recipe)) {
      b.recipe = e.recipe;
      FG.Map.syncRecipeSlots(b);
    }
    if (b.def.inserterTier !== undefined) {
      b.filter = e.filter;
      b.demandMode = e.demandMode;
    }
    if (b.def.recipeBuilding || b.type === 'lab') b.priority = e.priority;
    g.absorbPile(b);     // 回收该格地面物料
    FG.Events.emit('building:placed', b);
    return b;
  }

  /** 从物流（箱子→地面物料堆）取走 n 件建材作为计划预留，返回实际取得数量 */
  pullFromLogistics(item, n) {
    let left = n;
    for (const b of this.game.map.buildings.values()) {
      if (left <= 0) break;
      if (b.type !== 'chest') continue;
      for (const s of b.chest) {
        if (left <= 0) break;
        if (s.type === item && s.count > 0) {
          const take = Math.min(left, s.count);
          s.count -= take;
          left -= take;
        }
      }
    }
    if (left > 0) {
      for (const [k, pile] of this.game.map.piles) {
        if (left <= 0) break;
        const s = pile.find(x => x.type === item && x.count > 0);
        if (!s) continue;
        const take = Math.min(left, s.count);
        s.count -= take;
        left -= take;
        if (s.count <= 0) pile.splice(pile.indexOf(s), 1);
        if (!pile.length) this.game.map.piles.delete(k);
      }
    }
    return n - left;
  }

  /** 把库存建材返还物流：优先放回箱子，放不下的落到 (x,y) 地面堆 */
  refundToLogistics(stock, x, y) {
    for (const item of Object.keys(stock)) {
      let left = stock[item];
      if (left <= 0) continue;
      for (const b of this.game.map.buildings.values()) {
        if (left <= 0) break;
        if (b.type === 'chest') left = this.game.tryChestAdd(b, item, left);
      }
      if (left > 0) this.game.map.pileAdd(x, y, item, left);
      stock[item] = 0;
    }
  }

  /** 计划完工：剩余预留建材返还，移出列表 */
  finish(p) {
    const ax = p.entries.length ? p.entries[0].x : 0;
    const ay = p.entries.length ? p.entries[0].y : 0;
    this.refundToLogistics(p.stock, ax, ay);
    const built = p.entries.filter(e => e.state === 'done').length;
    const skipped = p.entries.filter(e => e.state === 'skip').length;
    this.game.logMsg('🏗 施工完成「' + p.name + '」：' + built + ' 栋建筑建成并接入生产调度'
      + (skipped ? '，' + skipped + ' 栋被跳过' : ''), 'unlock');
    FG.Events.emit('construction:change');
  }

  /** 取消计划：已预留建材返还物流，已建成建筑保留 */
  cancel(planId) {
    const i = this.plans.findIndex(p => p.id === planId);
    if (i < 0) return false;
    const p = this.plans[i];
    const ax = p.entries.length ? p.entries[0].x : 0;
    const ay = p.entries.length ? p.entries[0].y : 0;
    this.refundToLogistics(p.stock, ax, ay);
    const built = p.entries.filter(e => e.state === 'done').length;
    this.plans.splice(i, 1);
    this.game.logMsg('已取消施工计划「' + p.name + '」：' + built + ' 栋已建成保留，预留建材已返还物流', 'info');
    FG.Events.emit('construction:change');
    return true;
  }

  // ================= 序列化（施工进度随存档恢复） =================
  serialize() {
    return {
      seq: this.seq,
      plans: this.plans.map(p => ({
        id: p.id, name: p.name, cursor: p.cursor, timer: p.timer, waiting: p.waiting,
        stock: Object.assign({}, p.stock),
        entries: p.entries.map(e => ({
          type: e.type, x: e.x, y: e.y, dir: e.dir, recipe: e.recipe,
          filter: e.filter, demandMode: e.demandMode, priority: e.priority, state: e.state,
        })),
      })),
    };
  }

  deserialize(data) {
    this.plans = [];
    this.seq = (data && data.seq) || 1;
    for (const sp of ((data && data.plans) || [])) {
      this.plans.push({
        id: sp.id || ('P' + (this.seq - 1)),
        name: sp.name || '施工计划',
        cursor: sp.cursor || 0,
        timer: sp.timer || 0,
        waiting: !!sp.waiting,
        stock: sp.stock || {},
        entries: (sp.entries || []).map(e => ({
          type: e.type, x: e.x, y: e.y, dir: e.dir || 0,
          recipe: e.recipe || null, filter: e.filter || null,
          demandMode: !!e.demandMode, priority: e.priority || 'normal',
          state: e.state || 'wait',
        })),
      });
    }
  }
};

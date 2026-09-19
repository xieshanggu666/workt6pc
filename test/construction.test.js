/**
 * 蓝图施工测试：node test/construction.test.js
 * 覆盖：框选生成蓝图 → 旋转几何 → 科技/地形校验 → 物流预留并消耗 →
 *       缺料等待 → 取消返还 → 建成接入调度 → 进度存档恢复
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const root = path.join(__dirname, '..');
const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/sim.js',
  'js/game/construction.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

// 空白草地小图
function newGame() {
  const g = new FG.Game();
  const w = 32, h = 24;
  const terrain = Array.from({ length: h }, () => Array(w).fill('grass'));
  const ores = Array.from({ length: h }, () => Array(w).fill(null));
  g.startWithMap({
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
    terrain, ores, water: new Set(), oil: new Set(),
  }, null, 'bp-test');
  return g;
}

function P(g, type, x, y, dir, recipe) {
  const b = FG.Map.create(type, x, y, dir || 0);
  if (recipe) { b.recipe = recipe; FG.Map.syncRecipeSlots(b); }
  g.map.register(b); g.sim.register(b);
  return b;
}
function chestOf(g, x, y) { return g.map.buildingAt(x, y); }
function chestCount(b, type) {
  const s = b.chest.find(x => x.type === type);
  return s ? s.count : 0;
}
// 给箱子批量加料
function fillChest(g, x, y, items) {
  const c = P(g, 'chest', x, y);
  for (const [t, n] of Object.entries(items)) g.sim.chestAdd(c, t, n);
  return c;
}

console.log('\n[1] 框选产线生成蓝图：只含矩形内建筑，坐标归一化');
{
  const g = newGame();
  // 熔炉(10,10) + 输入带(8,10)(9,10) + 机械臂(9,10 冲突)，换成：带(8,10)、臂(9,10)、炉(10,10)
  P(g, 'belt', 8, 10, 1);
  P(g, 'inserter', 9, 10, 1);
  const f = P(g, 'furnace', 10, 10, 0, 'smelt:iron');
  // 矩形外的建筑不应进入蓝图
  P(g, 'chest', 20, 20);
  const bp = g.construction.capture(8, 10, 10, 10);
  ok(!!bp, '框选返回蓝图');
  ok(bp.entities.length === 3, '蓝图含 3 个建筑（实际 ' + bp.entities.length + '）');
  const types = bp.entities.map(e => e.type).sort();
  ok(types.includes('belt') && types.includes('inserter') && types.includes('furnace'), '建筑类型正确');
  ok(bp.entities.every(e => e.lx >= 0 && e.ly >= 0 && e.lx <= 2 && e.ly === 0), '归一化坐标以左上角为原点');
  const fe = bp.entities.find(e => e.type === 'furnace');
  ok(fe.recipe === 'smelt:iron', '蓝图保留配方');
  const empty = g.construction.capture(1, 1, 3, 3);
  ok(empty === null, '空矩形返回 null');
}

console.log('\n[2] 旋转几何：R 旋转预览后实体坐标/方向正确变换');
{
  const g = newGame();
  P(g, 'belt', 8, 10, 1);
  P(g, 'inserter', 9, 10, 1);
  P(g, 'furnace', 10, 10, 0, 'smelt:iron');
  const bp = g.construction.capture(8, 10, 10, 10);
  // 带原朝东(dir=1)，归一化在 lx=0
  const belt = bp.entities.find(e => e.type === 'belt');
  // rot=0
  let c0 = FG.Construction.entityCell(belt, 8, 10, 0);
  ok(c0.x === 8 && c0.y === 10 && c0.dir === 1, 'rot=0 坐标/方向不变');
  // rot=1：(0,0)->(0,0)，方向东->南(2)
  let c1 = FG.Construction.entityCell(belt, 8, 10, 1);
  ok(c1.x === 8 && c1.y === 10 && c1.dir === 2, 'rot=1 东向带转为南向');
  // 熔炉归一化 lx=2,ly=0：rot=1 后 (-0,2) => lx=0,ly=2，锚点(8,10) => (8,12)
  const fur = bp.entities.find(e => e.type === 'furnace');
  let cf = FG.Construction.entityCell(fur, 8, 10, 1);
  ok(cf.x === 8 && cf.y === 12, 'rot=1 后熔炉绕原点旋转到 (8,12)（实际 ' + cf.x + ',' + cf.y + '）');
  // 旋转 4 次回到原状
  let c4 = FG.Construction.cells(bp, 8, 10, 0);
  let c4b = FG.Construction.cells(bp, 8, 10, 4 % 4);
  ok(JSON.stringify(c4.map(x => [x.x, x.y, x.dir])) === JSON.stringify(c4b.map(x => [x.x, x.y, x.dir])), '旋转一周复原');
}

console.log('\n[3] 地形/占位/科技校验：非法格标记 bad，未解锁建筑标记 locked');
{
  const g = newGame();
  P(g, 'chest', 5, 5);
  const bp = { entities: [{ lx: 0, ly: 0, type: 'belt', dir: 0 }], w: 1, h: 1 };
  // 落在已有建筑上
  let v = g.construction.validate(bp, 5, 5, 0);
  ok(!v.allOk && v.bad.has('5,5'), '落在已占格 → bad');
  // 越界
  v = g.construction.validate(bp, 999, 999, 0);
  ok(!v.allOk, '越界 → 校验失败');
  // 未解锁建筑（极速带需 logistics3）
  const bpEx = { entities: [{ lx: 0, ly: 0, type: 'expressBelt', dir: 0 }], w: 1, h: 1 };
  v = g.construction.validate(bpEx, 6, 6, 0);
  ok(!v.allOk && v.locked.has('expressBelt'), '未解锁建筑 → locked');
  // 合法
  v = g.construction.validate(bp, 6, 6, 0);
  ok(v.allOk && v.count === 1, '空格 + 已解锁 → 校验通过');
  // 水泵必须在水上：草地方格非法
  const bpPump = { entities: [{ lx: 0, ly: 0, type: 'pump', dir: 0 }], w: 1, h: 1 };
  v = g.construction.validate(bpPump, 7, 7, 0);
  ok(!v.allOk, '水泵放草地 → 地形校验失败');
}

console.log('\n[4] 提交施工计划：从箱子预留并消耗建材，建成后接入生产调度');
{
  const g = newGame();
  // 蓝图：一个传送带（需铁板×1）
  const bp = { entities: [{ lx: 0, ly: 0, type: 'belt', dir: 1 }], w: 1, h: 1 };
  // 远处放建材箱
  const chest = fillChest(g, 0, 0, { ironPlate: 5 });
  const planId = g.construction.submitPlan(bp, 12, 12, 0);
  ok(!!planId, '提交成功返回 planId');
  const site = g.construction.siteAt(12, 12);
  ok(!!site && site.status === 'waiting', '出现等待建材的施工点');
  ok(g.map.buildingAt(12, 12) === null, '施工点不是真实建筑（不参与生产/物流）');
  ok(g.construction.isSite(12, 12) && g.canPlace('belt', 12, 12) === false, '施工点占位，canPlace 拒绝重叠');
  // 1 tick：从箱中预留 1 件（CONSTRUCT_PULL=1），箱子 -1
  g.tickOnce();
  ok(chestCount(chest, 'ironPlate') === 4, '已从物流箱子中取出预留建材（箱余 4，实际 ' + chestCount(chest, 'ironPlate') + '）');
  ok((site.have.ironPlate || 0) === 1, '施工点记录已预留 1 件');
  // 跑过工时（base 20 + 1*4 = 24 tick，含取料 tick）
  ticks(g, 60);
  const b = g.map.buildingAt(12, 12);
  ok(!!b && b.type === 'belt' && b.dir === 1, '建成后原格生成真实建筑（保留方向）');
  ok(g.construction.siteAt(12, 12) === null, '建成后施工点移除');
  ok(g.sim.belts.includes(b), '建成传送带已注册进仿真（接入生产调度）');
  ok(!g.construction.plans.has(planId), '蓝图全部建成后计划关闭');
}

console.log('\n[5] 缺料等待：建材不足时保持等待，补料后自动继续建成');
{
  const g = newGame();
  // 熔炉：石×4 + 铁板×1 = 5 件
  const bp = { entities: [{ lx: 0, ly: 0, type: 'furnace', dir: 0, recipe: 'smelt:iron' }], w: 1, h: 1 };
  const chest = fillChest(g, 2, 2, { stone: 2 }); // 只有 2 石，缺 2 石 + 1 铁板
  g.construction.submitPlan(bp, 14, 14, 0);
  const site = g.construction.siteAt(14, 14);
  ticks(g, 80);
  ok(g.map.buildingAt(14, 14) === null, '建材不足：长时间后仍未建成（保持等待）');
  ok(site.status === 'waiting', '状态为等待建材');
  const haveStone = site.have.stone || 0;
  ok(haveStone === 2, '已把现有 2 件石料预留到施工点（实际 ' + haveStone + '）');
  ok(chestCount(chest, 'stone') === 0, '箱子中可预留的建材已全部取走');
  // 补料：另一只箱子
  const chest2 = fillChest(g, 3, 3, { stone: 2, ironPlate: 1 });
  ticks(g, 80);
  const b = g.map.buildingAt(14, 14);
  ok(!!b && b.type === 'furnace', '补齐建材后自动继续并建成');
  ok(b.recipe === 'smelt:iron', '建成建筑保留蓝图配方');
  ok(g.sim.crafters.includes(b), '熔炉建成即接入生产调度（crafters）');
  ok(chestCount(chest2, 'stone') === 0 && chestCount(chest2, 'ironPlate') === 0, '补齐建材被全部消耗');
}

console.log('\n[6] 取消返还：等待中点取消，已预留建材回到物流（箱子优先，余量落地）');
{
  const g = newGame();
  const chest = fillChest(g, 4, 4, { ironPlate: 1 });
  // 组装机：铁板×2 齿轮×2 电路板×1 = 5；箱子只供 1 铁板
  const bp = { entities: [{ lx: 0, ly: 0, type: 'assembler', dir: 0 }], w: 1, h: 1 };
  g.construction.submitPlan(bp, 16, 16, 0);
  const site = g.construction.siteAt(16, 16);
  ticks(g, 10);
  ok((site.have.ironPlate || 0) === 1, '已预留 1 铁板');
  // 拆掉唯一箱子：返还时无箱可放 → 落地面堆
  g.removeBuilding(chest);
  g.construction.cancelSite(site);
  ok(g.construction.siteAt(16, 16) === null, '取消后施工点移除');
  const pile = g.map.pileAt(16, 16);
  const p1 = pile ? (pile.find(s => s.type === 'ironPlate') || {}).count || 0 : 0;
  ok(p1 === 1, '无就近箱子时已预留建材落地为地面堆（1 铁板，实际 ' + p1 + '）');

  // 有就近箱子：返还入箱
  const chest3 = fillChest(g, 5, 5, { gear: 2 });
  const bp2 = { entities: [{ lx: 0, ly: 0, type: 'assembler', dir: 0 }], w: 1, h: 1 };
  g.construction.submitPlan(bp2, 16, 17, 0);
  const s2 = g.construction.siteAt(16, 17);
  ticks(g, 10);
  ok((s2.have.gear || 0) === 2, '第二张计划已预留 2 齿轮');
  g.construction.cancelSite(s2);
  ok(chestCount(chest3, 'gear') === 2, '取消后齿轮返还就近箱子（箱回 2，实际 ' + chestCount(chest3, 'gear') + '）');
  ok(!g.map.pileAt(16, 17), '入箱成功则不产生地面堆');
}

console.log('\n[7] 取消整张蓝图：多点全部取消，已预留全部返还');
{
  const g = newGame();
  // 蓝图：2 条传送带（各需铁板 1）
  const bp = {
    entities: [
      { lx: 0, ly: 0, type: 'belt', dir: 1 },
      { lx: 1, ly: 0, type: 'belt', dir: 1 },
    ], w: 2, h: 1,
  };
  fillChest(g, 8, 8, { ironPlate: 1 }); // 只够 1 条 → 一个等待
  const id = g.construction.submitPlan(bp, 18, 18, 0);
  ticks(g, 30);
  // 仅 1 件铁板：1 条带建成（工时 24 tick）、另 1 条缺料等待
  ok(g.construction.sites.size === 1, '1 建成 + 1 缺料等待（剩余施工点 ' + g.construction.sites.size + '）');
  g.construction.cancelPlan(id);
  ok(g.construction.sites.size === 0, '取消蓝图后全部施工点移除');
  ok(g.construction.plans.size === 0, '蓝图计划关闭');
  // 已建成的不撤销（只取消未完成施工点）；未建成点的预留已返还
  // 唯一一件铁板要么建成了带，要么已返还（地面/箱子），全图守恒
  let iron = chestCount(g.map.buildingAt(8, 8), 'ironPlate');
  for (const b of g.map.buildings.values()) if (b.type === 'belt') iron += 0; // 建成带不含铁板物品
  for (const pile of g.map.piles.values()) for (const s of pile) if (s.type === 'ironPlate') iron += s.count;
  // 已建成 1 条则铁板已转化为建筑（不计入物品）；未建成则返还为 1
  const builtBelts = Array.from(g.map.buildings.values()).filter(b => b.type === 'belt' && b.x >= 18 && b.y === 18).length;
  ok(builtBelts + iron === 1, '物料守恒：1 件铁板 = 已建成带 ' + builtBelts + ' + 返还 ' + iron);
}

console.log('\n[8] 建成接入生产调度：矿机→施工建成的熔炉能被按需物流识别');
{
  const g = newGame();
  // 矿机直接吐铁矿到箱子（模拟料源），再用蓝图造熔炉 + 机械臂 + 箱子
  const src = fillChest(g, 0, 10, { ironOre: 30 });
  // 蓝图：臂(10,10)朝东 + 熔炉(11,10)
  const bp = {
    entities: [
      { lx: 0, ly: 0, type: 'inserter', dir: 1 },
      { lx: 1, ly: 0, type: 'furnace', dir: 0, recipe: 'smelt:iron' },
    ], w: 2, h: 1,
  };
  // 建材箱（铁板=臂1+炉1=2；齿轮=臂1；石=炉4）
  fillChest(g, 0, 0, { ironPlate: 2, gear: 1, stone: 4 });
  // 让臂的身后格（10,10 的西边=(9,10)）有铁矿：把料箱摆到 (9,10)
  g.map.unregister(src); g.sim.unregister(src);
  src.x = 9; src.y = 10;
  g.map.register(src); g.sim.register(src);
  const armIns = P; // noop
  g.construction.submitPlan(bp, 10, 10, 0);
  ticks(g, 200);
  const arm = g.map.buildingAt(10, 10);
  const fur = g.map.buildingAt(11, 10);
  ok(!!arm && arm.type === 'inserter', '机械臂建成');
  ok(!!fur && fur.type === 'furnace', '熔炉建成');
  arm.demandMode = true; // 开启按需供给
  ticks(g, 400);
  const fed = fur.slots.inputs.ironOre.count + fur.totalCrafted + (arm.held ? 1 : 0);
  ok(fed > 0, '建成产线接入调度：铁矿被送入蓝图熔炉（在库+已炼+在途 ' + fed + '）');
  ok(fur.totalCrafted > 0, '蓝图熔炉完成冶炼（' + fur.totalCrafted + ' 铁板）');
}

console.log('\n[9] 存档恢复：施工点/已预留建材/进度/蓝图随存档还原，读档后继续建成');
{
  const g = newGame();
  const chest = fillChest(g, 1, 1, { stone: 4, ironPlate: 10 });
  // 蓝图 1 个熔炉（5 件）+ 1 条带（1 铁板）
  const bp = {
    entities: [
      { lx: 0, ly: 0, type: 'furnace', dir: 0, recipe: 'smelt:iron' },
      { lx: 1, ly: 0, type: 'belt', dir: 1 },
    ], w: 2, h: 1,
  };
  const pid = g.construction.submitPlan(bp, 20, 20, 0);
  ticks(g, 30); // 部分预留、可能一个已建成
  const data = JSON.parse(JSON.stringify(g.serialize()));
  ok(!!data.construction && data.construction.sites.length >= 0, '存档含 construction 段');

  const g2 = new FG.Game();
  let err = null;
  try { g2.deserialize(data); } catch (e) { err = e; }
  ok(!err, '读档不报错' + (err ? '：' + err.stack : ''));
  // 施工点恢复
  for (const ss of data.construction.sites) {
    const s2 = g2.construction.siteAt(ss.x, ss.y);
    ok(!!s2, '施工点 (' + ss.x + ',' + ss.y + ') 随存档恢复');
    if (s2) {
      ok(s2.type === ss.type && s2.dir === ss.dir && s2.recipe === ss.recipe, '类型/方向/配方恢复');
      let have = 0;
      for (const k of Object.keys(ss.have)) have += s2.have[k] || 0;
      let want = 0;
      for (const k of Object.keys(ss.have)) want += ss.have[k];
      ok(have === want, '已预留建材数量恢复（' + have + ' 件）');
      ok(Math.abs(s2.progress - ss.progress) === 0, '施工进度恢复');
    }
  }
  // 读档后继续：建材充足，最终全部建成
  ticks(g2, 200);
  ok(g2.construction.sites.size === 0, '读档后等待/施工继续，最终全部建成');
  ok(!!g2.map.buildingAt(20, 20) && !!g2.map.buildingAt(21, 20), '两个目标格均为真实建筑');
  ok(g2.map.buildingAt(20, 20).recipe === 'smelt:iron', '配方读档保留');

  // 旧存档兼容：无 construction 字段
  const old = JSON.parse(JSON.stringify(data));
  delete old.construction;
  const g3 = new FG.Game();
  err = null;
  try { g3.deserialize(old); ticks(g3, 10); } catch (e) { err = e; }
  ok(!err, '无 construction 段的旧存档读取/推进不报错');
  ok(g3.construction.sites.size === 0, '旧档施工点为空（按无施工计划处理）');
}

console.log('\n[10] 公平预留：多施工点轮转取料，不会一点独占全部建材');
{
  const g = newGame();
  fillChest(g, 0, 0, { ironPlate: 4 });
  // 4 条传送带蓝图（每条 1 铁板），一次提交
  const bp = {
    entities: [0, 1, 2, 3].map(i => ({ lx: i, ly: 0, type: 'belt', dir: 1 })),
    w: 4, h: 1,
  };
  g.construction.submitPlan(bp, 24, 22, 0);
  // 每点每 tick 至多 1 件，4 tick 后 4 点应各得 1（轮转）
  for (let i = 0; i < 4; i++) g.tickOnce();
  const sites = [0, 1, 2, 3].map(i => g.construction.siteAt(24 + i, 22));
  const haves = sites.map(s => s ? (s.have.ironPlate || 0) : -1);
  ok(haves.every(n => n === 1), '4 个施工点轮转各得 1 件（[' + haves + ']）');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

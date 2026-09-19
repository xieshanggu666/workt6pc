/**
 * 蓝图施工测试：node test/blueprint.test.js
 * 框选生成蓝图 → 旋转 → 科技/地形校验 → 提交施工计划 → 建材预留/消耗 →
 * 缺料等待 → 取消返还 → 建成接入生产调度 → 施工进度随存档恢复
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/sim.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
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

// 全草地地图（无矿无水，按需手动改造）
const game = new FG.Game();
const w = 60, h = 40;
const terrain = Array.from({ length: h }, () => Array(w).fill('grass'));
const ores = Array.from({ length: h }, () => Array(w).fill(null));
game.startWithMap({
  presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
  terrain, ores, water: new Set(), oil: new Set(),
}, null, 'bp-test');
const m = game.map, sim = game.sim;

function P(t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); m.register(b); sim.register(b); return b; }
function chestCount(b, type) { const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }
function pileCountAt(x, y, type) {
  const p = m.pileAt(x, y);
  if (!p) return 0;
  const s = p.find(x => x.type === type);
  return s ? s.count : 0;
}
function bpEntry(type, dx, dy, dir, extra) {
  return Object.assign({
    type, dx, dy, dir: dir || 0, recipe: null, filter: null, demandMode: false, priority: 'normal',
  }, extra || {});
}

console.log('\n[1] 框选产线生成蓝图（保留配方/方向/筛选/优先级）');
{
  const f = P('furnace', 10, 10); f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f); f.priority = 'high';
  const ins = P('inserter', 11, 10, 3); ins.filter = 'ironOre'; ins.demandMode = true;
  P('belt', 12, 10, 1);
  P('belt', 12, 11, 2);
  const bp = FG.Blueprint.capture(m, 10, 10, 12, 11);
  ok(bp.w === 3 && bp.h === 2, '蓝图尺寸 3×2（实际 ' + bp.w + '×' + bp.h + '）');
  ok(bp.entries.length === 4, '捕获 4 栋建筑（实际 ' + bp.entries.length + '）');
  const fe = bp.entries.find(e => e.type === 'furnace');
  ok(fe && fe.dx === 0 && fe.dy === 0 && fe.recipe === 'smelt:iron' && fe.priority === 'high',
    '熔炉相对坐标/配方/优先级保留');
  const ie = bp.entries.find(e => e.type === 'inserter');
  ok(ie && ie.dx === 1 && ie.dy === 0 && ie.dir === 3 && ie.filter === 'ironOre' && ie.demandMode === true,
    '机械臂相对坐标/方向/筛选/按需保留');
  // 反向框选（右下→左上）结果一致
  const bp2 = FG.Blueprint.capture(m, 12, 11, 10, 10);
  ok(bp2.entries.length === 4 && bp2.w === 3 && bp2.h === 2, '反向框选归一化');
  game._bp = bp;
}

console.log('\n[2] 蓝图旋转：条目坐标与朝向同步旋转');
{
  const bp = game._bp;
  const r1 = FG.Blueprint.rotate(bp);
  ok(r1.w === 2 && r1.h === 3, '旋转后宽高互换（2×3）');
  // 原 (dx2,dy0,dir1) 的传送带 → (h-1-0, 2) = (1,2)，朝向 dir2
  const belt = r1.entries.find(e => e.type === 'belt' && e.dir === 2);
  ok(belt && belt.dx === 1 && belt.dy === 2,
    '条目旋转 90°（(2,0)→(1,2)，实际 ' + (belt ? belt.dx + ',' + belt.dy : '无') + '）');
  const ins = r1.entries.find(e => e.type === 'inserter');
  ok(ins && ins.dir === 0 && ins.filter === 'ironOre' && ins.demandMode === true,
    '机械臂朝向随旋转且配置保留');
  const r4 = FG.Blueprint.rotate(FG.Blueprint.rotate(FG.Blueprint.rotate(FG.Blueprint.rotate(bp))));
  const same = bp.entries.every(e => {
    const m4 = r4.entries.find(x => x.type === e.type && x.dx === e.dx && x.dy === e.dy);
    return m4 && m4.dir === e.dir;
  });
  ok(same && r4.w === bp.w && r4.h === bp.h, '旋转 4 次回到原样');
}

console.log('\n[3] 按科技与地形校验');
{
  const bpFast = { w: 1, h: 1, entries: [bpEntry('fastBelt', 0, 0, 0)] };
  let v = FG.Blueprint.validate(game, bpFast, 20, 20);
  ok(!v.ok && /科技/.test(v.reason), '未解锁建筑校验拒绝（' + v.reason + '）');
  game.research.completed.add('logistics2');
  v = FG.Blueprint.validate(game, bpFast, 20, 20);
  ok(v.ok, '科技解锁后校验通过');

  m.terrain[25][20] = 'water';
  const bpFur = { w: 1, h: 1, entries: [bpEntry('furnace', 0, 0, 0)] };
  v = FG.Blueprint.validate(game, bpFur, 20, 25);
  ok(!v.ok, '水域上放熔炉被地形校验拒绝');
  const bpPump = { w: 1, h: 1, entries: [bpEntry('pump', 0, 0, 0)] };
  v = FG.Blueprint.validate(game, bpPump, 20, 25);
  ok(v.ok, '水域上允许水泵');
  v = FG.Blueprint.validate(game, bpFur, 10, 10);
  ok(!v.ok, '已占用位置校验拒绝');
  const bpMiner = { w: 1, h: 1, entries: [bpEntry('miner', 0, 0, 0)] };
  v = FG.Blueprint.validate(game, bpMiner, 30, 30);
  ok(!v.ok, '无矿脉处放矿机被拒绝');
  m.ores[30][30] = { type: 'ironOre', amount: 1000 };
  v = FG.Blueprint.validate(game, bpMiner, 30, 30);
  ok(v.ok, '矿脉上允许矿机');
  ok(v.cells.length === 1 && v.cells[0].x === 30 && v.cells[0].y === 30 && v.cells[0].ok,
    '校验返回逐格结果（预览着色用）');
}

console.log('\n[4] 提交施工计划：预留并消耗建材，建成后接入生产调度');
{
  const chest = P('chest', 5, 5);
  sim.chestAdd(chest, 'ironPlate', 10);
  sim.chestAdd(chest, 'gear', 5);
  sim.chestAdd(chest, 'stone', 10);
  game._chest = chest;

  // 蓝图：熔炉(配方/优先级) + 机械臂(筛选/按需) + 传送带 → 成本 stone5 + ironPlate2 + gear1
  const bp = {
    w: 3, h: 1,
    entries: [
      bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron', priority: 'high' }),
      bpEntry('inserter', 1, 0, 1, { filter: 'ironPlate', demandMode: true }),
      bpEntry('belt', 2, 0, 1),
    ],
  };
  game.blueprint = bp;
  ok(game.submitBlueprintPlan(40, 10), '校验通过，提交成功');
  ok(game.construction.plans.length === 1, '计划进入施工队列');
  ticks(game, 40);
  ok(game.construction.plans.length === 0, '建材齐备 → 施工完成出列');
  const f2 = m.buildingAt(40, 10);
  ok(f2 && f2.recipe === 'smelt:iron' && f2.priority === 'high', '熔炉建成且配方/优先级还原');
  ok(sim.crafters.includes(f2), '熔炉注册进仿真（接入生产调度）');
  const ins2 = m.buildingAt(41, 10);
  ok(ins2 && ins2.filter === 'ironPlate' && ins2.demandMode === true && sim.inserters.includes(ins2),
    '机械臂建成且筛选/按需还原');
  ok(m.buildingAt(42, 10) && sim.belts.includes(m.buildingAt(42, 10)), '传送带建成并入仿真');
  ok(chestCount(chest, 'stone') === 5 && chestCount(chest, 'ironPlate') === 8 && chestCount(chest, 'gear') === 4,
    '建材从物流消耗（石10→5 铁10→8 齿轮5→4）');
  // 建成的熔炉可直接投产
  f2.slots.inputs.ironOre.count = 4;
  ticks(game, 30);
  ok(f2.totalCrafted > 0, '建成建筑立即投入生产（已炼 ' + f2.totalCrafted + ' 次）');
}

console.log('\n[5] 缺料等待：建材不足时暂停，补料后自动继续');
{
  // 实验室成本 ironPlate4 + circuit1；物流无电路板 → 等待
  const bp = { w: 1, h: 1, entries: [bpEntry('lab', 0, 0, 0)] };
  game.blueprint = bp;
  ok(game.submitBlueprintPlan(44, 10), '缺料也可提交计划（等待建材）');
  ticks(game, 30);
  ok(!m.buildingAt(44, 10), '缺料期间不落成');
  const plan = game.construction.plans[0];
  ok(plan && plan.waiting, '计划处于缺料等待状态');
  ok((plan.stock.ironPlate || 0) === 4, '已有建材被预留入计划库存（铁板 4）');
  ok(chestCount(game._chest, 'ironPlate') === 4, '预留量已从箱子扣除（8→4）');
  sim.chestAdd(game._chest, 'circuit', 2);
  ticks(game, 30);
  ok(!!m.buildingAt(44, 10), '补料后自动继续并建成实验室');
  ok(game.construction.plans.length === 0, '计划完成出列');
  ok(chestCount(game._chest, 'circuit') === 1, '电路板消耗 1 件（2→1）');
}

console.log('\n[6] 取消施工计划：预留建材返还物流');
{
  // 清空电路板：实验室需铁板4+电路板1 → 电路板不足，铁板被预留后等待
  for (const s of game._chest.chest) if (s.type === 'circuit') s.count = 0;
  const bp = { w: 1, h: 1, entries: [bpEntry('lab', 0, 0, 0)] };
  game.blueprint = bp;
  ok(game.submitBlueprintPlan(46, 10), '提交计划');
  ticks(game, 10);
  const plan = game.construction.plans[0];
  ok(plan && plan.waiting && (plan.stock.ironPlate || 0) === 4,
    '缺料等待中，铁板已预留 4 件入计划库存');
  ok(chestCount(game._chest, 'ironPlate') === 0, '预留后箱子铁板被取空');
  ok(game.cancelConstruction(plan.id), '取消计划');
  ok(game.construction.plans.length === 0, '计划已移除');
  ok(chestCount(game._chest, 'ironPlate') === 4, '预留铁板返还箱子（0→4）');
  ok(!m.buildingAt(46, 10), '未建成的建筑不落地');

  // 箱子 4 槽填满后，返还放不下的物品落到地面堆
  sim.chestAdd(game._chest, 'circuit', 1);
  game.construction.refundToLogistics({ coal: 3 }, 50, 20);
  ok(pileCountAt(50, 20, 'coal') === 3, '箱子放不下的返还物落到地面堆');
}

console.log('\n[7] 施工进度随存档恢复');
{
  // 制造一个缺料等待中的计划：铁板仅 3（需 4）、无电路板 → 部分预留后等待
  for (const s of game._chest.chest) {
    if (s.type === 'circuit') s.count = 0;
    if (s.type === 'ironPlate') s.count = 3;
  }
  const bp = { w: 1, h: 1, entries: [bpEntry('lab', 0, 0, 0)] };
  game.blueprint = bp;
  ok(game.submitBlueprintPlan(50, 10), '提交计划');
  ticks(game, 5);
  const plan = game.construction.plans[0];
  ok(plan && plan.waiting && (plan.stock.ironPlate || 0) === 3, '计划等待中且铁板已预留 3');

  const data = JSON.parse(JSON.stringify(game.serialize()));
  ok(data.construction && data.construction.plans.length === 1, '存档包含施工计划');
  ok(data.blueprint && data.blueprint.entries.length === 1, '存档包含蓝图剪贴板');

  const g2 = new FG.Game();
  g2.deserialize(data);
  ok(g2.construction.plans.length === 1, '读档后施工计划恢复');
  const p2 = g2.construction.plans[0];
  ok((p2.stock.ironPlate || 0) === 3 && p2.entries[0].state === 'wait' && p2.entries[0].x === 50,
    '预留库存与条目状态恢复');
  ok(g2.blueprint && g2.blueprint.entries.length === 1, '蓝图剪贴板恢复');
  // 补料后续建完成
  const chest2 = g2.map.buildingAt(5, 5);
  g2.sim.chestAdd(chest2, 'ironPlate', 1);
  g2.sim.chestAdd(chest2, 'circuit', 1);
  ticks(g2, 30);
  ok(!!g2.map.buildingAt(50, 10), '读档后补料继续施工并建成');
  ok(g2.construction.plans.length === 0, '续建完成出列');

  // 旧存档兼容：无 construction / blueprint 字段
  const old = JSON.parse(JSON.stringify(data));
  delete old.construction;
  delete old.blueprint;
  const g3 = new FG.Game();
  let err = null;
  try { g3.deserialize(old); ticks(g3, 20); } catch (e) { err = e; }
  ok(!err, '旧存档（无施工字段）读取与仿真不报错' + (err ? '：' + err.stack : ''));
  ok(g3.construction.plans.length === 0 && !g3.blueprint, '旧存档施工计划/剪贴板为空');

  // 清理 g1 上残留的计划（返还 3 铁板），避免影响后续用例
  game.construction.cancel(plan.id);
  ticks(game, 1);
}

console.log('\n[8] 成本汇总 / 计划占格校验 / 落成时地形复验');
{
  const cost = FG.Blueprint.costOf({ entries: [{ type: 'belt' }, { type: 'inserter' }, { type: 'lab' }] });
  ok(cost.ironPlate === 6 && cost.gear === 1 && cost.circuit === 1,
    '蓝图成本汇总（铁板6 齿轮1 电路板1，实际 ' + JSON.stringify(cost) + '）');

  // 计划 A：缺电路板 → 等待；同位置再次提交被拒
  const bp = { w: 1, h: 1, entries: [bpEntry('lab', 0, 0, 0)] };
  game.blueprint = bp;
  ok(game.submitBlueprintPlan(52, 10), '提交计划 A（缺料等待）');
  ticks(game, 3);
  const v = FG.Blueprint.validate(game, bp, 52, 10);
  ok(!v.ok, '已有施工计划的位置校验拒绝');
  ok(!game.submitBlueprintPlan(52, 10), '重复提交被拦截');
  ok(game.construction.plans.length === 1, '仍只有 1 个计划');

  // 计划 B：双传送带；落成瞬间第二格被占 → 跳过，计划照常完工
  sim.chestAdd(game._chest, 'ironPlate', 5);
  const bp2 = { w: 2, h: 1, entries: [bpEntry('belt', 0, 0, 1), bpEntry('belt', 1, 0, 1)] };
  game.blueprint = bp2;
  ok(game.submitBlueprintPlan(40, 20), '提交双传送带计划 B');
  P('chest', 41, 20);   // 抢先占据第二格
  ticks(game, 30);
  ok(m.buildingAt(40, 20) && m.buildingAt(40, 20).type === 'belt', '第一格传送带建成');
  ok(m.buildingAt(41, 20).type === 'chest', '被占格保持原建筑（条目跳过）');
  ok(game.construction.plans.length === 1, '计划 B 完工出列（仅剩等待中的计划 A）');
  game.construction.cancel(game.construction.plans[0].id);
  ticks(game, 1);
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

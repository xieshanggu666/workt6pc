/**
 * 浏览器环境冒烟测试（无浏览器）：mock DOM/Canvas，加载全部脚本，
 * 模拟「新游戏 → 框选蓝图 → 提交 → 施工 → 建成」整链路，验证 UI 渲染与事件不报错。
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

// ---------- Canvas 2D mock ----------
function makeCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: [] });
      if (k === 'createLinearGradient') return { addColorStop: noop };
      if (k === 'canvas') return makeCanvas();
      return typeof k === 'string' ? noop : undefined;
    },
    set() { return true; },
  });
}
function makeCanvas() {
  return {
    width: 800, height: 600,
    style: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: () => {},
    parentElement: makeEl('parent'),
  };
}

// ---------- DOM element mock ----------
function makeEl(id) {
  const el = {
    id: id || '',
    className: '',
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    clientWidth: 800, clientHeight: 600,
    width: 800, height: 600,
    value: '',
    checked: false,
    hidden: false,
    title: '',
    children: [],
    _listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    set onclick(f) { this._onclick = f; },
    get onclick() { return this._onclick || null; },
    set onchange(f) { this._onchange = f; },
    get onchange() { return this._onchange || null; },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() { if (this._onclick) this._onclick({}); },
    createElement: undefined,
  };
  return el;
}

const registry = new Map();
function makeCanvasEl() {
  const c = makeEl();
  c.tagName = 'canvas';
  c.getContext = () => makeCtx();
  c.parentElement = makeEl('parent');
  return c;
}
function getEl(id) {
  if (!registry.has(id)) {
    registry.set(id, id === 'map-canvas' ? makeCanvasEl() : makeEl(id));
  }
  return registry.get(id);
}

const documentMock = {
  getElementById: (id) => getEl(id),
  querySelector: () => null,
  querySelectorAll: (sel) => sel === '.modal-mask' ? [] : [],
  createElement: (tag) => {
    const e = makeEl();
    e.tagName = tag;
    if (tag === 'canvas') return makeCanvas();
    return e;
  },
  documentElement: makeEl('html'),
  addEventListener: () => {},
};

const listeners = {};
global.innerWidth = 1280; global.innerHeight = 800;
global.devicePixelRatio = 1;
global.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
global.removeEventListener = () => {};
global.document = documentMock;

global.window = global;
window.FG = window.FG || {};

global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => {};
global.alert = (m) => { console.log('  [alert]', m); };
global.FileReader = function () {};
global.Blob = function () {};
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

const root = path.join(__dirname, '..');
const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/sim.js',
  'js/game/construction.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/game.js',
  'js/ui/renderer.js', 'js/ui/toolbar.js', 'js/ui/panels.js',
  'js/ui/tech.js', 'js/ui/modals.js', 'js/ui/topbar.js',
  'js/main.js',
];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };

let loadErr = null;
try {
  for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
} catch (e) { loadErr = e; }
ok(!loadErr, '全部脚本加载（含 UI）无异常' + (loadErr ? '\n' + loadErr.stack : ''));

const FG = global.FG;
ok(!!FG.game, 'FG.game 已由 main.js 创建');

let err = null;
try {
  // 新游戏
  FG.game.newGame('greenfield', 'small', 42, '1', '冒烟测试');
  const g = FG.game, m = g.map;

  // 找一块无矿草地放源产线
  // 箱子 + 熔炉 + 传送带 产线（真实建筑），供框选
  function P(t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); m.register(b); g.sim.register(b); return b; }
  P('belt', 10, 10, 1);
  const fur = P('furnace', 11, 10, 0);
  g.setRecipe(fur, 'smelt:iron');

  // 建材箱
  const mat = P('chest', 2, 2);
  g.sim.chestAdd(mat, 'stone', 40);
  g.sim.chestAdd(mat, 'ironPlate', 40);
  g.sim.chestAdd(mat, 'gear', 20);

  // 渲染一帧（菜单未进前 render 直接返回；进入后渲染）
  FG.Renderer.setMouseTile(12, 12);
  FG.Renderer.render();

  // 框选生成蓝图
  g.startCapture();
  ok(g.bpMode === 'capturing', '进入框选模式');
  g.finishCapture(10, 10, 11, 10);
  ok(g.bpMode === 'placing' && g.blueprint.entities.length === 2, '框选 2 格产线生成蓝图，进入放置');

  // 旋转 + 锚点 + 校验 + 渲染预览
  g.rotateBlueprint();
  g.setBlueprintAnchor(14, 14);
  let v = g.blueprintValidation();
  ok(v.allOk, '旋转预览校验通过（' + v.count + ' 格）');
  FG.Renderer.render();

  // 非法位置（落在已占用的建材区外即可，这里落到 (10,10) 自身会冲突）
  g.setBlueprintAnchor(10, 10);
  v = g.blueprintValidation();
  ok(!v.allOk, '与自身重叠的位置校验失败');

  // 回到合法位置提交
  g.rotateBlueprint(); // 再转，随便测不报错
  g.rotateBlueprint();
  g.rotateBlueprint(); // 转回 rot=0
  g.setBlueprintAnchor(14, 14);
  const pid = g.submitBlueprintAt(14, 14);
  ok(!!pid, '提交施工计划成功');
  ok(g.bpMode === null, '提交后退出蓝图模式');

  // 推进仿真直到全部建成（belt 1 铁板；furnace 4石+1铁板）
  for (let i = 0; i < 400; i++) { g.tickOnce(); }
  FG.Renderer.render();
  const b1 = m.buildingAt(14, 14), b2 = m.buildingAt(15, 14);
  ok(!!b1 && b1.type === 'belt', '蓝图位置 1 建成传送带');
  ok(!!b2 && b2.type === 'furnace' && b2.recipe === 'smelt:iron', '蓝图位置 2 建成熔炉且配方保留');
  ok(g.construction.sites.size === 0, '施工点全部清空');

  // 选中施工点测试（再造一张缺料蓝图）
  g.startCapture();
  g.finishCapture(14, 14, 15, 14);
  g.setBlueprintAnchor(18, 18);
  g.submitBlueprintAt(18, 18);
  const site = g.construction.siteAt(18, 18);
  ok(!!site, '新施工点存在');
  g.selectBuilding(site);
  FG.Panels.render(); // 施工点信息面板
  for (let i = 0; i < 5; i++) g.tickOnce();
  FG.Panels.render();
  // 取消
  g.construction.cancelSite(site);
  FG.Panels.render();

  // 无选择时的概况（含施工板块）
  const site2 = g.construction.siteAt(19, 18);
  if (site2) g.construction.cancelPlan(site2.planId);
  g.selection = null;
  FG.Events.emit('selection:change');
  FG.Panels.render();

  // 工具栏渲染（含蓝图按钮、建材文本）
  FG.Toolbar.renderBuildings();

  // 顶栏资源条
  FG.Topbar && (0); // topbar 通过事件驱动；手动调一次内部 strip
  FG.Events.emit('sim:tick');

  // 存档/读档（经 UI 同一路径）
  g.saveTo('1', '冒烟测试');
  const data = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new FG.Game();
  g2.deserialize(data);
  FG.Renderer.init(getEl('map-canvas'), g2); // 重新绑定渲染器到新 game
  for (let i = 0; i < 300; i++) g2.tickOnce();
  FG.Renderer.render();
  ok(true, '读档后渲染 + 推进无异常');
} catch (e) {
  err = e;
}
ok(!err, '整链路（框选→旋转→校验→提交→施工→建成→面板→存档）无异常' + (err ? '\n' + err.stack : ''));

console.log('\n冒烟结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

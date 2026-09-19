/**
 * FG.Toolbar —— 左侧建筑工具栏
 */
FG.Toolbar = (() => {
  const catsEl = () => document.getElementById('tb-cats');
  const listEl = () => document.getElementById('tb-buildings');
  const hintEl = () => document.getElementById('tb-hint');
  let activeCat = 'extraction';

  const HINTS = {
    extraction: '左键放置；右键/Esc 取消。矿机需放在矿脉上，水泵放水域旁。',
    production: '放置后用右侧面板选择配方；用机械臂连接传送带与建筑。',
    logistics: '传送带按住拖拽可连成直线；机械臂 R 旋转；管道连接产液与用液建筑。',
    science: '实验室需要科学包，由组装机生产；研究在 🔬 科技树中选择。',
  };

  function init() {
    renderCats();
    renderBuildings();
    hintEl().textContent = HINTS[activeCat];
    FG.Events.on('research:complete', renderBuildings);
    FG.Events.on('ghost:change', () => { renderBuildings(); });
    FG.Events.on('bp:change', () => { renderBuildings(); });
    FG.Events.on('game:start', () => { renderBuildings(); });
  }

  /** 建材需求短文本：铁板×2 齿轮×1 */
  function costText(type) {
    const cost = FG.Buildings.costOf(type);
    return Object.entries(cost).map(([id, n]) =>
      (FG.Items.byId(id) ? FG.Items.byId(id).name : id) + '×' + n).join(' ');
  }

  function renderCats() {
    catsEl().innerHTML = '';
    for (const cat of FG.Buildings.CATS) {
      const b = document.createElement('button');
      b.textContent = cat.name;
      b.className = cat.id === activeCat ? 'active' : '';
      b.onclick = () => {
        activeCat = cat.id;
        renderCats();
        renderBuildings();
        hintEl().textContent = HINTS[cat.id];
      };
      catsEl().appendChild(b);
    }
  }

  function renderBuildings() {
    const el = listEl();
    el.innerHTML = '';
    const game = FG.game;

    // 蓝图工具卡（置于建筑列表顶部，跨全部分类）
    const bpBtn = document.createElement('button');
    const bpActive = game.bpMode !== null;
    bpBtn.className = 'bld-btn bp-tool' + (bpActive ? ' selected' : '');
    bpBtn.innerHTML = `<span class="bp-icon">▭</span><span class="bld-name">${
      game.bpMode === 'capturing' ? '框选中…' : game.bpMode === 'placing' ? '放置蓝图…' : '蓝图框选 (B)'
    }</span>`;
    bpBtn.title = '框选已有产线生成蓝图，R 旋转预览，左键提交施工计划。建材从箱子/地面物料预留并消耗。';
    bpBtn.onclick = () => { if (game.bpMode) game.cancelBlueprint(); else game.startCapture(); };
    el.appendChild(bpBtn);

    // 蓝图模式下：提示性占位，列表隐藏建筑以免误放
    if (game.bpMode) {
      const tip = document.createElement('div');
      tip.className = 'bp-mode-tip';
      tip.innerHTML = game.bpMode === 'capturing'
        ? '在地图上<b>按住左键拖出矩形</b>框选产线<br>右键 / Esc 取消'
        : '移动鼠标<b>预览</b>位置 · <b>R</b> 旋转<br><b>左键</b>提交施工计划<br>右键 / Esc 放弃蓝图';
      el.appendChild(tip);
      hintEl().textContent = game.bpMode === 'capturing'
        ? '框选模式：按住左键拖出矩形，框住已有产线生成蓝图。'
        : '放置模式：R 旋转预览，左键提交施工计划（按科技与地形校验）。';
      return;
    }

    for (const def of FG.Buildings.byCat(activeCat)) {
      const unlocked = game.research.isBuildingUnlocked(def.id);
      const btn = document.createElement('button');
      btn.className = 'bld-btn' + (unlocked ? '' : ' locked') + (game.ghost && game.ghost.type === def.id ? ' selected' : '');
      const ct = costText(def.id);
      btn.title = def.desc + (ct ? '\n建材：' + ct + '（蓝图施工消耗）' : '');
      const icon = FG.Renderer.buildingIcon(def.id, 40);
      icon.width = 40; icon.height = 40;
      btn.appendChild(icon);
      const name = document.createElement('span');
      name.className = 'bld-name';
      name.textContent = def.name;
      btn.appendChild(name);
      if (ct) {
        const cost = document.createElement('span');
        cost.className = 'bld-cost';
        cost.textContent = ct;
        btn.appendChild(cost);
      }
      if (!unlocked) {
        btn.title = '需要研究：' + (FG.Research.byId(def.unlockedBy) ? FG.Research.byId(def.unlockedBy).name : def.unlockedBy);
        btn.onclick = () => {
          const tech = FG.Research.byId(def.unlockedBy);
          if (tech) { FG.Tech.open(); FG.Tech.focus(def.unlockedBy); }
        };
      } else {
        btn.onclick = () => {
          if (game.ghost && game.ghost.type === def.id) game.cancelGhost();
          else game.setGhost(def.id);
        };
      }
      el.appendChild(btn);
    }
    hintEl().textContent = HINTS[activeCat];
  }

  return { init, renderBuildings };
})();

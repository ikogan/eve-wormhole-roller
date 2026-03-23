'use strict';

const { createApp, ref, computed, watch, reactive } = Vue;

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_SHIPS    = 'eve-whr-ships-v1';
const STORAGE_THEME    = 'eve-whr-theme-v1';
const STORAGE_WH       = 'eve-whr-wormhole-v1';
const STORAGE_UNIT     = 'eve-whr-unit-v1';
const STORAGE_PASSES   = 'eve-whr-passes-v1';
const STORAGE_FAR_SIDE        = 'eve-whr-far-side-v1';
const STORAGE_ROLLING_TARGET  = 'eve-whr-rolling-target-v1';

// Individual ship mass limits per wormhole size (stored internally in kg)
const WH_SIZES = [
  { id: 'small',  label: 'Small',             desc: 'Destroyer / HIC / Odysseus',         maxShipMass:     5_000_000 },
  { id: 'medium', label: 'Medium',            desc: 'Battlecruiser',                       maxShipMass:    62_000_000 },
  { id: 'large',  label: 'Large',             desc: 'Battleship / Orca',                   maxShipMass:   375_000_000 },
  { id: 'xl',     label: 'Extra Large',       desc: 'Freighter / Rorqual',                 maxShipMass: 1_000_000_000 },
  { id: 'xxl',    label: 'Extra Extra Large', desc: 'Capitals (excl. Supercarrier/Titan)', maxShipMass: 2_000_000_000 },
];

// ─── Pure Utilities ───────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Format a number with K/M/B suffix (no unit label) */
function _fmt(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
  return Number(n).toFixed(0);
}

// ─── Optimal Pass Calculator (Web Worker) ─────────────────────────────────────
/**
 * buildPlan logic lives inside the worker source string so it runs off the main
 * thread. Using a Blob URL keeps the app single-file and compatible with file://.
 */
const CALC_WORKER_SRC = `
var MAX_PLAN_PASSES = 100;
function buildPlan(options, target) {
  if (target <= 0) return { alreadyCollapsed: true, passes: [], totalMass: 0 };
  if (!options || !options.length) return { impossible: true, passes: [], totalMass: 0, msg: 'No eligible ships for this wormhole size.' };
  const sorted   = options.slice().sort((a, b) => b.mass - a.mass);
  const heaviest = sorted[0];
  const lightest = sorted[sorted.length - 1];
  if (heaviest.mass <= 0) return { impossible: true, passes: [], totalMass: 0, msg: 'All ships have zero mass.' };
  let cumulative = 0;
  const plan = [];
  while (cumulative < target) {
    plan.push(Object.assign({}, heaviest));
    cumulative += heaviest.mass;
    if (plan.length > MAX_PLAN_PASSES + 1) {
      if (plan.length % 2 !== 0) { plan.push(Object.assign({}, lightest)); cumulative += lightest.mass; }
      return { tooMany: true, passCount: plan.length, totalMass: cumulative };
    }
  }
  if (plan.length % 2 !== 0) { plan.push(Object.assign({}, lightest)); cumulative += lightest.mass; }
  let running = 0;
  return {
    passes: plan.map(function(p) { running += p.mass; return Object.assign({}, p, { running: running }); }),
    totalMass: cumulative
  };
}
self.onmessage = function(e) {
  var d = e.data;
  self.postMessage({
    bestCasePlan:  buildPlan(d.options, d.massToColMin),
    worstCasePlan: buildPlan(d.options, d.massToColMax),
  });
};
`;

// Create a persistent worker from the blob (works on file:// and http://)
const _calcWorkerBlob = new Blob([CALC_WORKER_SRC], { type: 'application/javascript' });
const _calcWorkerUrl  = URL.createObjectURL(_calcWorkerBlob);
const _calcWorker     = new Worker(_calcWorkerUrl);

// ─── Vue Application ──────────────────────────────────────────────────────────
createApp({
  setup() {
    // ── State ────────────────────────────────────────────────────────────────
    const activeTab     = ref('setup');
    const selectedTheme = ref(localStorage.getItem(STORAGE_THEME) || 'caldari');
    const massUnit      = ref(localStorage.getItem(STORAGE_UNIT)  || 'kg'); // 'kg' | 't'

    const savedWh = JSON.parse(localStorage.getItem(STORAGE_WH) || 'null');
    const wormhole = reactive({
      name:      savedWh?.name      ?? '',
      totalMass: savedWh?.totalMass ?? 0,  // always stored in kg
      status:    savedWh?.status    ?? 'stable',
      size:      savedWh?.size      ?? '', // '' = unknown / not set
    });

    const ships      = ref(JSON.parse(localStorage.getItem(STORAGE_SHIPS)    || '[]'));
    const passes     = ref(JSON.parse(localStorage.getItem(STORAGE_PASSES)   || '[]'));
    const farSideShips = ref(JSON.parse(localStorage.getItem(STORAGE_FAR_SIDE) || '[]'));
    const rollingTarget = ref(localStorage.getItem(STORAGE_ROLLING_TARGET) || 'collapse'); // 'collapse' | 'critical'

    const passForm = reactive({
      mode:       'ship',  // 'ship' | 'custom'
      shipId:     '',
      passType:   'cold',  // 'hot' | 'cold'
      customMass: null,    // stored in kg
    });

    const farSideForm = reactive({
      mode:        'ship',  // 'ship' | 'custom'
      shipId:      '',
      passType:    'cold',
      customMass:  null,    // stored in kg
      customLabel: '',
    });

    const shipModal = reactive({
      open:  false,
      isNew: true,
      draft: { id: '', name: '', coldMass: null, hotMass: null }, // stored in kg
    });

    const yamlFileRef = ref(null);

    // ── Persistence ──────────────────────────────────────────────────────────
    watch(ships,       val => localStorage.setItem(STORAGE_SHIPS,    JSON.stringify(val)), { deep: true });
    watch(passes,      val => localStorage.setItem(STORAGE_PASSES,   JSON.stringify(val)), { deep: true });
    watch(farSideShips,val => localStorage.setItem(STORAGE_FAR_SIDE, JSON.stringify(val)), { deep: true });
    watch(wormhole, val => localStorage.setItem(STORAGE_WH,    JSON.stringify({ ...val })), { deep: true });
    watch(massUnit, val => localStorage.setItem(STORAGE_UNIT, val));
    watch(rollingTarget, val => localStorage.setItem(STORAGE_ROLLING_TARGET, val));

    // ── Theme ────────────────────────────────────────────────────────────────
    function applyTheme() {
      document.documentElement.setAttribute('data-theme', selectedTheme.value);
      localStorage.setItem(STORAGE_THEME, selectedTheme.value);
    }
    applyTheme();

    // ── Unit helpers ─────────────────────────────────────────────────────────
    /**
     * Format a value stored in kg for display in the current unit.
     * Returns e.g. "350\u202fkg" or "350\u202ft" (narrow no-break space before unit).
     */
    function fmtMass(kg) {
      if (massUnit.value === 't') return _fmt(kg / 1000) + '\u202ft';
      return _fmt(kg) + '\u202fkg';
    }

    /** Convert user input (in current unit) to kg for storage. */
    function _toKg(v)  { return massUnit.value === 't' ? (Number(v) || 0) * 1000 : (Number(v) || 0); }
    /** Convert kg to current display unit for populating input fields. */
    function _fromKg(kg) { return (!kg || kg <= 0) ? null : massUnit.value === 't' ? kg / 1000 : kg; }

    // Step size for number inputs (1M kg or 1K t = same physical mass)
    const unitStep = computed(() => massUnit.value === 't' ? 1000 : 1_000_000);

    // Computed setters bridge input values ↔ internal kg storage
    const whTotalMassInput = computed({ get: () => _fromKg(wormhole.totalMass), set: v => { wormhole.totalMass = _toKg(v); } });
    const draftColdInput   = computed({ get: () => _fromKg(shipModal.draft.coldMass), set: v => { shipModal.draft.coldMass = _toKg(v); } });
    const draftHotInput    = computed({ get: () => _fromKg(shipModal.draft.hotMass),  set: v => { shipModal.draft.hotMass  = _toKg(v); } });
    const customMassInput  = computed({ get: () => _fromKg(passForm.customMass),      set: v => { passForm.customMass = _toKg(v); } });

    // ── Wormhole Size ────────────────────────────────────────────────────────
    const whSizeInfo  = computed(() => WH_SIZES.find(s => s.id === wormhole.size) ?? null);
    const whSizeLimit = computed(() => whSizeInfo.value?.maxShipMass ?? null); // kg or null

    /** True if a mass (kg) fits through the configured wormhole size. */
    function massFits(kg) { return !whSizeLimit.value || kg <= whSizeLimit.value; }

    // ── Mass Computeds ───────────────────────────────────────────────────────
    const usedMass = computed(() => passes.value.reduce((s, p) => s + p.mass, 0));
    const usedPct  = computed(() => wormhole.totalMass > 0 ? (usedMass.value / wormhole.totalMass) * 100 : 0);

    const massToReduced  = computed(() => Math.max(0, wormhole.totalMass * 0.5 - usedMass.value));
    const massToCritical = computed(() => Math.max(0, wormhole.totalMass * 0.9 - usedMass.value));
    const massToColMin   = computed(() => Math.max(0, wormhole.totalMass * (rollingTarget.value === 'critical' ? 0.9 : 1.0) - usedMass.value));
    const massToColMax   = computed(() => Math.max(0, wormhole.totalMass * (rollingTarget.value === 'critical' ? 1.0 : 1.1) - usedMass.value));

    // ── Far Side Ships ───────────────────────────────────────────────────────
    const farSideMass = computed(() => farSideShips.value.reduce((s, f) => s + f.mass, 0));
    // Mass remaining for rolling passes after far-side ships return
    const effectiveMassToColMin = computed(() => Math.max(0, massToColMin.value - farSideMass.value));
    const effectiveMassToColMax = computed(() => Math.max(0, massToColMax.value - farSideMass.value));
    // True when far-side ships alone will bring the WH into its collapse window
    const farSideAloneCollapses  = computed(() => farSideMass.value > 0 && farSideMass.value >= massToColMin.value);
    const farSideOverCollapses   = computed(() => farSideMass.value > massToColMax.value);

    const farSideSelectedShip = computed(() => ships.value.find(s => s.id === farSideForm.shipId) ?? null);
    const farSideShipMass     = computed(() => {
      if (!farSideSelectedShip.value) return 0;
      return farSideForm.passType === 'hot'
        ? (farSideSelectedShip.value.hotMass  || 0)
        : (farSideSelectedShip.value.coldMass || 0);
    });
    const canSubmitFarSide = computed(() => {
      if (farSideForm.mode === 'ship') return !!farSideForm.shipId && farSideShipMass.value > 0;
      return Number(farSideForm.customMass) > 0;
    });
    const farSideCustomMassInput = computed({
      get: () => _fromKg(farSideForm.customMass),
      set: v  => { farSideForm.customMass = _toKg(Number(v) || 0) || null; },
    });

    // ── Mass Bar ─────────────────────────────────────────────────────────────
    const barTotalWidth  = computed(() => wormhole.totalMass * 1.1 || 1);
    const barFillStyle   = computed(() => {
      const pct   = Math.min((usedMass.value / barTotalWidth.value) * 100, 100);
      const color = usedPct.value >= 90 ? 'var(--color-bar-fill-danger)'
                  : usedPct.value >= 50 ? 'var(--color-bar-fill-mid)'
                  : 'var(--color-bar-fill-safe)';
      return { width: pct + '%', backgroundColor: color };
    });
    const barVarianceStyle   = computed(() => { const l = (1/1.1)*100; return { left: l+'%', width: (100-l)+'%' }; });
    const markerReducedLeft  = computed(() => (wormhole.totalMass * 0.5 / barTotalWidth.value * 100) + '%');
    const markerCriticalLeft = computed(() => (wormhole.totalMass * 0.9 / barTotalWidth.value * 100) + '%');
    const markerTotalLeft    = computed(() => (wormhole.totalMass * 1.0 / barTotalWidth.value * 100) + '%');

    // ── Status ───────────────────────────────────────────────────────────────
    const statusClass = computed(() => `status-${wormhole.status}`);

    // ── Pass Form ────────────────────────────────────────────────────────────
    const selectedShip  = computed(() => ships.value.find(s => s.id === passForm.shipId) ?? null);
    const shipPassMass  = computed(() => {
      if (!selectedShip.value) return 0;
      return passForm.passType === 'hot' ? (selectedShip.value.hotMass || 0) : (selectedShip.value.coldMass || 0);
    });
    const shipPassFits  = computed(() => massFits(shipPassMass.value));
    const canSubmitPass = computed(() => {
      if (passForm.mode === 'ship') return !!passForm.shipId && shipPassMass.value > 0;
      return Number(passForm.customMass) > 0;
    });

    // ── Pass History ─────────────────────────────────────────────────────────
    const passesWithRunning = computed(() => {
      let running = 0;
      return passes.value.map((p, idx) => { running += p.mass; return { ...p, running, num: idx + 1 }; });
    });
    const passesReversed = computed(() => [...passesWithRunning.value].reverse());

    function passLabel(pass) {
      if (pass.mode === 'custom') return 'Custom Pass';
      const ship = ships.value.find(s => s.id === pass.shipId);
      return `${ship?.name ?? 'Unknown'} (${pass.passType === 'hot' ? '♨ Hot' : '❄ Cold'})`;
    }

    // ── Calculator ───────────────────────────────────────────────────────────
    // Only include ship+passType combos that fit through the wormhole size
    const passOptions = computed(() => {
      const opts = [];
      for (const ship of ships.value) {
        if ((ship.coldMass || 0) > 0 && massFits(ship.coldMass)) opts.push({ label: `${ship.name} — Cold`, mass: ship.coldMass });
        if ((ship.hotMass  || 0) > 0 && massFits(ship.hotMass))  opts.push({ label: `${ship.name} — Hot`,  mass: ship.hotMass  });
      }
      return opts;
    });

    // Ships completely excluded by size (neither cold nor hot fits)
    const excludedShips = computed(() =>
      whSizeLimit.value
        ? ships.value.filter(s => !massFits(s.coldMass || 0) && !massFits(s.hotMass || 0))
        : []
    );

    // Ships that can pass cold but whose hot mass exceeds the size limit
    const coldOnlyShips = computed(() =>
      whSizeLimit.value
        ? ships.value.filter(s =>
            massFits(s.coldMass || 0) &&
            (s.hotMass || 0) > 0 && !massFits(s.hotMass || 0)
          )
        : []
    );

    const worstCasePlan = ref(null);
    const bestCasePlan  = ref(null);
    const calcBusy      = ref(false);
    const calcDirty     = ref(true); // true = needs recalc on next tab visit

    // Receive results back from the worker
    _calcWorker.onmessage = (e) => {
      worstCasePlan.value = e.data.worstCasePlan;
      bestCasePlan.value  = e.data.bestCasePlan;
      calcBusy.value = false;
    };

    // Mark dirty whenever the inputs that affect the calc change
    watch([passOptions, massToColMin, massToColMax], () => { calcDirty.value = true; });
    watch(farSideShips, () => { calcDirty.value = true; }, { deep: true });

    // Only calculate when the user navigates to the Calculator tab
    function triggerCalc() {
      if (!calcDirty.value) return;
      calcBusy.value      = true;
      worstCasePlan.value = null;
      bestCasePlan.value  = null;
      calcDirty.value     = false;
      _calcWorker.postMessage({
        options:      passOptions.value,
        massToColMin: effectiveMassToColMin.value,
        massToColMax: effectiveMassToColMax.value,
      });
    }

    watch(activeTab, tab => { if (tab === 'calc') triggerCalc(); });

    // ── Actions ──────────────────────────────────────────────────────────────
    function addPass() {
      if (!canSubmitPass.value) return;

      // Warn if selected ship+passType cannot physically fit through this wormhole size
      if (passForm.mode === 'ship' && whSizeLimit.value && !shipPassFits.value) {
        const ok = confirm(
          '\u26a0 Size Warning\n\n' +
          `${selectedShip.value.name} (${passForm.passType}) mass is ${fmtMass(shipPassMass.value)}, ` +
          `which exceeds the ${whSizeInfo.value.label} wormhole size limit of ${fmtMass(whSizeLimit.value)}.\n\n` +
          'This ship cannot physically pass through this wormhole type.\n\nRecord anyway?'
        );
        if (!ok) return;
      }

      let entry;
      if (passForm.mode === 'ship') {
        entry = { id: genId(), mode: 'ship', shipId: passForm.shipId, passType: passForm.passType, mass: shipPassMass.value };
      } else {
        entry = { id: genId(), mode: 'custom', mass: Number(passForm.customMass) };
        passForm.customMass = null;
      }
      passes.value.push(entry);
    }

    function removePass(id) {
      const idx = passes.value.findIndex(p => p.id === id);
      if (idx >= 0) passes.value.splice(idx, 1);
    }

    function clearPasses() {
      if (confirm('Clear all recorded passes for this session?')) passes.value = [];
    }

    function resetSession() {
      if (confirm('Reset everything? This will clear all passes, far side ships, and wormhole data.')) {
        passes.value = []; farSideShips.value = [];
        wormhole.name = ''; wormhole.totalMass = 0;
        wormhole.status = 'stable'; wormhole.size = '';
      }
    }

    // ── Far Side Ships Management ─────────────────────────────────────────────
    function addFarSideShip() {
      if (!canSubmitFarSide.value) return;
      let entry;
      if (farSideForm.mode === 'ship') {
        entry = {
          id: genId(), mode: 'ship',
          shipId: farSideForm.shipId, passType: farSideForm.passType,
          label: `${farSideSelectedShip.value.name} (${farSideForm.passType === 'hot' ? '♨ Hot' : '❄ Cold'})`,
          mass: farSideShipMass.value,
        };
      } else {
        entry = {
          id: genId(), mode: 'custom',
          label: farSideForm.customLabel.trim() || 'Custom Ship',
          mass: Number(farSideForm.customMass),
        };
        farSideForm.customMass  = null;
        farSideForm.customLabel = '';
      }
      farSideShips.value.push(entry);
    }

    function removeFarSideShip(id) {
      const idx = farSideShips.value.findIndex(f => f.id === id);
      if (idx >= 0) farSideShips.value.splice(idx, 1);
    }

    // ── Ship Management ──────────────────────────────────────────────────────
    function openAddShip()    { shipModal.isNew = true; shipModal.draft = { id: '', name: '', coldMass: null, hotMass: null }; shipModal.open = true; }
    function openEditShip(s)  { shipModal.isNew = false; shipModal.draft = { ...s }; shipModal.open = true; }
    function closeShipModal() { shipModal.open = false; }

    const shipModalValid = computed(() => {
      const d = shipModal.draft;
      return d.name?.trim().length > 0 && Number(d.coldMass) > 0 && Number(d.hotMass) > 0;
    });

    function saveShip() {
      if (!shipModalValid.value) return;
      const data = { ...shipModal.draft, coldMass: Number(shipModal.draft.coldMass), hotMass: Number(shipModal.draft.hotMass) };
      if (shipModal.isNew) { data.id = genId(); ships.value.push(data); }
      else { const i = ships.value.findIndex(s => s.id === data.id); if (i >= 0) ships.value.splice(i, 1, data); }
      closeShipModal();
    }

    function deleteShip(id) {
      if (confirm('Remove this ship from the fleet?')) ships.value = ships.value.filter(s => s.id !== id);
    }

    function cloneShip(s) {
      ships.value.push({ ...s, id: genId(), name: s.name + ' (copy)' });
    }

    // ── YAML ─────────────────────────────────────────────────────────────────
    // YAML always stores masses in kg for portability, regardless of display unit
    function exportYAML() {
      const text = jsyaml.dump(
        { ships: ships.value.map(s => ({ name: s.name, coldMass: s.coldMass, hotMass: s.hotMass })) },
        { lineWidth: 120 }
      );
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([text], { type: 'text/yaml' })),
        download: 'wormhole-fleet.yaml',
      });
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function triggerImport() { yamlFileRef.value.click(); }

    function handleYAMLFile(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const parsed = jsyaml.load(e.target.result);
          if (!parsed?.ships || !Array.isArray(parsed.ships)) { alert('Invalid YAML: expected a top-level "ships" list.'); return; }
          const valid = parsed.ships.filter(s => s.name && Number(s.coldMass) > 0 && Number(s.hotMass) > 0);
          if (!valid.length) { alert('No valid ships found in the YAML file.'); return; }
          if (confirm(`Import ${valid.length} ship(s)?\nThis will replace your current fleet.`)) {
            ships.value = valid.map(s => ({ id: genId(), name: String(s.name), coldMass: Number(s.coldMass), hotMass: Number(s.hotMass) }));
          }
        } catch (err) { alert('Failed to parse YAML: ' + err.message); }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    function threshClass(val) { return val <= 0 ? 'text-success' : ''; }

    // ── Display Plans (rolling passes + far-side return rows merged) ──────────
    function _whStateAfter(pct) {
      if (pct >= 100) return 'Collapsed ⊗';
      if (pct >= 90)  return 'Critical ⚠';
      if (pct >= 50)  return 'Reduced';
      return 'Stable';
    }

    function buildDisplayPlan(plan) {
      if (!plan || plan.impossible || plan.tooMany) return [];

      const base  = usedMass.value;       // mass already recorded this session
      const total = wormhole.totalMass;
      const thresholds = [
        { key: 'reduced',   label: 'Reduced (50%)',    mass: total * 0.5 },
        { key: 'critical',  label: 'Critical (90%)',   mass: total * 0.9 },
        { key: 'collapsed', label: 'Collapsed (100%)', mass: total * 1.0 },
      ].filter(t => t.mass > base); // skip thresholds already crossed

      const rollingRows = (plan.passes || []).map(p => ({ ...p, rowType: 'rolling' }));
      let running = plan.totalMass || 0;
      const farRows = farSideShips.value.map(f => {
        running += f.mass;
        return { rowType: 'far-side', label: f.label, mass: f.mass, running };
      });
      const rawRows = [...rollingRows, ...farRows];

      // Interleave threshold separators after the pass that crosses each threshold
      const allRows = [];
      let prevRunning = 0;
      for (const row of rawRows) {
        const totalThrough = base + row.running;
        const remaining    = total - totalThrough;
        const pct          = total > 0 ? (totalThrough / total) * 100 : 0;
        allRows.push({ ...row, totalThrough, remaining, pct, stateAfter: _whStateAfter(pct) });
        for (const thr of thresholds) {
          const rel = thr.mass - base;
          if (prevRunning < rel && row.running >= rel) {
            allRows.push({ rowType: 'threshold', label: thr.label, key: thr.key });
          }
        }
        prevRunning = row.running;
      }

      // Assign sequential pass numbers (skipping threshold rows) and mark final
      let passNum = 0;
      let lastPassIdx = -1;
      for (let i = 0; i < allRows.length; i++) {
        if (allRows[i].rowType !== 'threshold') { allRows[i].num = ++passNum; lastPassIdx = i; }
      }
      if (lastPassIdx >= 0) allRows[lastPassIdx] = { ...allRows[lastPassIdx], isFinal: true };

      return allRows;
    }
    const displayBestCase  = computed(() => buildDisplayPlan(bestCasePlan.value));
    const displayWorstCase = computed(() => buildDisplayPlan(worstCasePlan.value));

    // ── Pass row hover tooltip ────────────────────────────────────────────────
    const passTooltip = reactive({ show: false, x: 0, y: 0, row: null });

    function showPassTooltip(event, row) {
      const rect = event.currentTarget.getBoundingClientRect();
      passTooltip.row  = row;
      passTooltip.x    = rect.left + rect.width / 2;
      passTooltip.y    = rect.top - 8;
      passTooltip.show = true;
    }
    function hidePassTooltip() { passTooltip.show = false; }

    // ── Expose to template ───────────────────────────────────────────────────
    return {
      activeTab, selectedTheme, massUnit, wormhole, ships, passes, passForm, shipModal, yamlFileRef,
      WH_SIZES, whSizeInfo, whSizeLimit, excludedShips, coldOnlyShips,
      usedMass, usedPct,
      massToReduced, massToCritical, massToColMin, massToColMax,
      farSideShips, farSideForm, farSideMass, farSideSelectedShip, farSideShipMass,
      canSubmitFarSide, farSideCustomMassInput, farSideAloneCollapses, farSideOverCollapses,
      effectiveMassToColMin, effectiveMassToColMax,
      rollingTarget, displayBestCase, displayWorstCase,
      passTooltip, showPassTooltip, hidePassTooltip,
      barFillStyle, barVarianceStyle, markerReducedLeft, markerCriticalLeft, markerTotalLeft,
      statusClass, selectedShip, shipPassMass, shipPassFits, canSubmitPass,
      passesReversed, passOptions, worstCasePlan, bestCasePlan, calcBusy,
      shipModalValid, unitStep,
      whTotalMassInput, draftColdInput, draftHotInput, customMassInput,
      applyTheme, fmtMass, massFits,
      addPass, removePass, clearPasses, resetSession,
      addFarSideShip, removeFarSideShip,
      passLabel, threshClass,
      openAddShip, openEditShip, closeShipModal, saveShip, deleteShip, cloneShip,
      exportYAML, triggerImport, handleYAMLFile,
    };
  },
}).mount('#app');

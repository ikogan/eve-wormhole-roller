'use strict';

const { createApp, ref, computed, watch, reactive } = Vue;

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_SHIPS          = 'eve-whr-ships-v1';
const STORAGE_THEME          = 'eve-whr-theme-v1';
const STORAGE_WH             = 'eve-whr-wormhole-v1';
const STORAGE_UNIT           = 'eve-whr-unit-v1';
const STORAGE_PASSES         = 'eve-whr-passes-v1';
const STORAGE_FAR_SIDE       = 'eve-whr-far-side-v1';
const STORAGE_ROLLING_TARGET = 'eve-whr-rolling-target-v1';
const STORAGE_PILOTS         = 'eve-whr-pilots-v1';

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

// ─── Multi-Pilot Pass Calculator (Web Worker) ─────────────────────────────────
/**
 * Algorithm overview:
 *
 * We need to push at least `targetCapacity` kg through the wormhole to collapse
 * it, with two hard constraints:
 *   1. All mass BEFORE the final hot return must be < targetCapacity (WH stays open).
 *   2. The final hot return must bring total mass to >= targetCapacity (WH collapses).
 *
 * Structure: K "bulk" round-trips (any hot/cold mix) decomposed into M full
 * N-pilot groups plus a final group with the remaining K%N extra RTs and the
 * collapse pass. Minimum passes is achieved by:
 *   - Using the heaviest ship at HOT for bulk passes (max mass per pass).
 *   - Switching the minimum number of bulk passes to cold/cold (or hot/cold) when
 *     the all-hot total would exceed the upper bound of the allowed window.
 *   - Trying every ship as the "finalShip" (makes the last hot return).
 *
 * Worker runs off the main thread via a Blob URL (works on file:// and http://).
 */
const CALC_WORKER_SRC = `
var MAX_GROUPS = 60;
var MAX_K_EXTRA = 3; // extra K values to try beyond kMin if kMin itself doesn't fit

// targetCapacity: the specific WH capacity we're planning for (min or max variant).
function buildMultiPilotPlan(mpOptions, numPilots, scoutMasses, targetCapacity) {
  if (targetCapacity <= 0) return { alreadyCollapsed: true, groups: [] };
  if (!mpOptions || !mpOptions.length) return { impossible: true, msg: 'No eligible ships for this wormhole size.' };

  // Sort by hot mass descending — heaviest hot ship maximises mass per bulk pass
  var sorted = mpOptions.slice().sort(function(a, b) { return b.hotMass - a.hotMass; });
  var heavy = sorted[0];
  if (!heavy.hotMass) return { impossible: true, msg: 'All ships have zero hot mass.' };

  var scoutMassTotal = 0;
  for (var s = 0; s < scoutMasses.length; s++) scoutMassTotal += scoutMasses[s];

  // Each bulk round-trip uses the heavy ship; hot/hot is the maximum, cold/cold is the minimum.
  var maxRT = 2 * heavy.hotMass;   // hot enter + hot return
  var minRT = 2 * heavy.coldMass;  // cold enter + cold return
  if (minRT <= 0) minRT = maxRT;   // cold mass absent: only hot available

  var bestResult = null;

  // Try every ship as the final collapse ship (makes the very last hot return pass)
  for (var si = 0; si < sorted.length; si++) {
    var finalShip = sorted[si];
    if (!finalShip.hotMass) continue;

    // Fixed mass in the final group that happens BEFORE the hot return:
    //   finalShip cold enter + scout returns
    var beforeHotBase = finalShip.coldMass + scoutMassTotal;
    if (beforeHotBase >= targetCapacity) continue; // WH would already collapse without the hot pass

    // Bulk mass window: the K bulk round-trips must land in [M_min, M_max]
    // so that (bulk + beforeHotBase) < targetCapacity  AND
    //         (bulk + beforeHotBase + finalShip.hotMass) >= targetCapacity
    var M_min = targetCapacity - finalShip.hotMass - beforeHotBase;
    var M_max = targetCapacity - beforeHotBase - 1; // strict <, subtract 1 kg

    if (M_max < 0) continue;

    // Minimum K round-trips to reach M_min using maximum-mass hot passes
    var kMin = M_min <= 0 ? 0 : Math.ceil(M_min / maxRT);

    // Try kMin and a few increments (in case kMin itself doesn't produce an in-range mix)
    for (var kTry = kMin; kTry <= kMin + MAX_K_EXTRA; kTry++) {
      var config = _findBulkConfig(kTry, heavy, M_min, M_max, maxRT, minRT);
      if (!config) continue;

      var result = _makeGroups(kTry, numPilots, heavy, finalShip, config, scoutMasses, scoutMassTotal);
      if (result && result.totalGroups <= MAX_GROUPS) {
        if (!bestResult || result.totalPasses < bestResult.totalPasses) {
          bestResult = result;
        }
        break; // found a valid result for this final ship — kMin is already minimum K
      }
    }
  }

  return bestResult || { impossible: true, msg: 'No valid plan found. Try adding ships with different mass values or more pilots.' };
}

/**
 * Given K bulk round-trips and the heavy ship, find a hot/cold mix whose total
 * mass lands in [M_min, M_max].
 *
 * Each round-trip is one of:
 *   "hot"  — hot enter + hot return  = 2 * hotMass
 *   "mix"  — hot enter + cold return = hotMass + coldMass  (saves one coldMass-hotMass gap)
 *   "cold" — cold enter + cold return = 2 * coldMass
 *
 * Strategy: start all-hot, then switch whole round-trips to cold/cold. If the
 * granularity of a full cold switch overshoots, try one "mix" RT (hot+cold) to
 * get finer control.
 */
function _findBulkConfig(K, heavy, M_min, M_max, maxRT, minRT) {
  if (K === 0) {
    return (M_min <= 0) ? { hotRTs: 0, mixRTs: 0, coldRTs: 0, total: 0 } : null;
  }

  var allHotTotal = K * maxRT;

  // All-hot already in range?
  if (allHotTotal >= M_min && allHotTotal <= M_max) {
    return { hotRTs: K, mixRTs: 0, coldRTs: 0, total: allHotTotal };
  }

  if (allHotTotal > M_max) {
    // Need to reduce. Switch some round-trips from hot/hot toward cold/cold.
    var savingsFull = maxRT - minRT;          // per cold/cold switch
    var savingsHalf = heavy.hotMass - heavy.coldMass; // per mix (hot+cold) switch

    // Minimum full cold switches needed to get total into range
    var nFull = savingsFull > 0 ? Math.ceil((allHotTotal - M_max) / savingsFull) : K + 1;
    if (nFull > K) return null;

    var totalAfterFull = allHotTotal - nFull * savingsFull;
    if (totalAfterFull >= M_min && totalAfterFull <= M_max) {
      return { hotRTs: K - nFull, mixRTs: 0, coldRTs: nFull, total: totalAfterFull };
    }

    // totalAfterFull < M_min: nFull switched too many. Try (nFull-1) full + 1 mix.
    if (nFull > 0 && savingsHalf > 0) {
      var totalMixed = allHotTotal - (nFull - 1) * savingsFull - savingsHalf;
      if (totalMixed >= M_min && totalMixed <= M_max) {
        return { hotRTs: K - nFull, mixRTs: 1, coldRTs: nFull - 1, total: totalMixed };
      }
    }

    // Try nFull cold switches without any mix (may be just barely outside range)
    // If still > M_max, add one more switch
    if (totalAfterFull > M_max && nFull < K) {
      var totalExtra = allHotTotal - (nFull + 1) * savingsFull;
      if (totalExtra >= M_min && totalExtra <= M_max) {
        return { hotRTs: K - nFull - 1, mixRTs: 0, coldRTs: nFull + 1, total: totalExtra };
      }
    }
  }

  // allHotTotal < M_min: K is too small — caller should try a larger K
  return null;
}

/**
 * Build the group structure from K total bulk round-trips plus the final group.
 *
 * K decomposes as: M full N-pilot bulk groups + extraRTs extra round-trips that
 * live inside the final group (before the collapse pass).
 *
 * config.hotRTs  round-trips use hot enter + hot return (heaviest)
 * config.mixRTs  round-trips use hot enter + cold return (one direction each)
 * config.coldRTs round-trips use cold enter + cold return (lightest)
 *
 * Round-trips are allocated hottest-first so that the heavier passes happen in
 * early bulk groups (the final group extras will tend to be the lighter cold passes,
 * giving more control near the collapse threshold).
 */
function _makeGroups(K, numPilots, heavyShip, finalShip, config, scoutMasses, scoutMassTotal) {
  // Pre-build the ordered list of K round-trips (hottest first).
  // Each rt: { em, et } = enter mass/type; { rm, rt } = return mass/type.
  var rts = [];
  for (var i = 0; i < config.hotRTs;  i++) rts.push({ em: heavyShip.hotMass,  et: 'hot',  rm: heavyShip.hotMass,  rt: 'hot'  });
  for (var i = 0; i < config.mixRTs;  i++) rts.push({ em: heavyShip.hotMass,  et: 'hot',  rm: heavyShip.coldMass, rt: 'cold' });
  for (var i = 0; i < config.coldRTs; i++) rts.push({ em: heavyShip.coldMass, et: 'cold', rm: heavyShip.coldMass, rt: 'cold' });

  var M        = Math.floor(K / numPilots); // full N-pilot bulk groups
  var extraRTs = K % numPilots;             // extra RTs inside the final group
  var groups   = [];

  // M full bulk groups — all N pilots do one round-trip each
  for (var gi = 0; gi < M; gi++) {
    var enters = [], returns = [];
    var base = gi * numPilots;
    for (var p = 0; p < numPilots; p++) {
      var rt = rts[base + p];
      enters.push({ name: heavyShip.name, mass: rt.em, passType: rt.et, direction: 'enter' });
      returns.push({ name: heavyShip.name, mass: rt.rm, passType: rt.rt, direction: 'return' });
    }
    groups.push({ type: 'bulk', pilotCount: numPilots, enters: enters, scoutReturns: [], returns: returns });
  }

  // Final group: extraRTs extra round-trips + finalShip cold enter + scouts + returns + hot collapse
  var fgEnters = [], fgReturns = [], fgScouts = [];
  var fgPilots = extraRTs + 1; // +1 for the finalShip pilot
  var fgBase   = M * numPilots;

  for (var p = 0; p < extraRTs; p++) {
    var rt = rts[fgBase + p];
    fgEnters.push({ name: heavyShip.name, mass: rt.em, passType: rt.et, direction: 'enter' });
    fgReturns.push({ name: heavyShip.name, mass: rt.rm, passType: rt.rt, direction: 'return' });
  }

  fgEnters.push({ name: finalShip.name, mass: finalShip.coldMass, passType: 'cold', direction: 'enter' });

  for (var s = 0; s < scoutMasses.length; s++) {
    fgScouts.push({ name: 'Scout', mass: scoutMasses[s], passType: 'cold', direction: 'return', isScout: true });
  }

  fgReturns.push({ name: finalShip.name, mass: finalShip.hotMass, passType: 'hot', direction: 'return', isFinal: true });

  groups.push({ type: 'final', pilotCount: fgPilots, enters: fgEnters, scoutReturns: fgScouts, returns: fgReturns });

  var totalPasses = 0;
  for (var g = 0; g < groups.length; g++) {
    totalPasses += groups[g].enters.length + groups[g].scoutReturns.length + groups[g].returns.length;
  }
  var totalMass = config.total + finalShip.coldMass + scoutMassTotal + finalShip.hotMass;

  return { groups: groups, totalMass: totalMass, totalPasses: totalPasses, totalGroups: groups.length };
}

self.onmessage = function(e) {
  var d = e.data;
  self.postMessage({
    bestCasePlan:  buildMultiPilotPlan(d.mpOptions, d.numPilots, d.scoutMasses, d.massToColMin),
    worstCasePlan: buildMultiPilotPlan(d.mpOptions, d.numPilots, d.scoutMasses, d.massToColMax),
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
    const numPilots  = ref(Number(localStorage.getItem(STORAGE_PILOTS)) || 2);

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
    watch(numPilots, val => localStorage.setItem(STORAGE_PILOTS, String(val)));

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

    // When the user records an observed state change, treat at least that state's
    // threshold as consumed — even if fewer actual passes have been recorded.
    const statusMinUsed = computed(() => {
      switch (wormhole.status) {
        case 'reduced':   return wormhole.totalMass * 0.50;
        case 'critical':  return wormhole.totalMass * 0.90;
        case 'collapsed': return wormhole.totalMass * 1.00;
        default:          return 0;
      }
    });

    // Mass from passes recorded *after* the last state-change entry. Passes before
    // the state change observation are accounted for by statusMinUsed (they're why
    // the WH reached that state). Passes after it are additional rolling progress.
    const usedMassAfterLastState = computed(() => {
      let lastStateIdx = -1;
      for (let i = passes.value.length - 1; i >= 0; i--) {
        if (passes.value[i].mode === 'state') { lastStateIdx = i; break; }
      }
      if (lastStateIdx < 0) return usedMass.value; // no state entries — all passes count
      return passes.value.slice(lastStateIdx + 1).reduce((s, p) => s + p.mass, 0);
    });

    // effectiveUsedMass: max of (what we actually recorded) vs (state floor + passes after it).
    // This ensures each new pass after a state observation reduces the remaining plan.
    const effectiveUsedMass = computed(() =>
      Math.max(usedMass.value, statusMinUsed.value + usedMassAfterLastState.value)
    );

    const usedPct  = computed(() => wormhole.totalMass > 0 ? (effectiveUsedMass.value / wormhole.totalMass) * 100 : 0);

    const massToReduced  = computed(() => Math.max(0, wormhole.totalMass * 0.5 - effectiveUsedMass.value));
    const massToCritical = computed(() => Math.max(0, wormhole.totalMass * 0.9 - effectiveUsedMass.value));
    const massToColMin   = computed(() => Math.max(0, wormhole.totalMass * (rollingTarget.value === 'critical' ? 0.9 : 1.0) - effectiveUsedMass.value));
    const massToColMax   = computed(() => Math.max(0, wormhole.totalMass * (rollingTarget.value === 'critical' ? 1.0 : 1.1) - effectiveUsedMass.value));

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

    function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

    function passLabel(pass) {
      if (pass.mode === 'state') return `⚑ → ${capitalise(pass.newStatus)}`;
      if (pass.mode === 'plan')  return pass.label;
      if (pass.mode === 'custom') return 'Custom Pass';
      const ship = ships.value.find(s => s.id === pass.shipId);
      return `${ship?.name ?? 'Unknown'} (${pass.passType === 'hot' ? '♨ Hot' : '❄ Cold'})`;
    }

    // ── Calculator ───────────────────────────────────────────────────────────
    // passOptions: flat list for the add-pass form dropdowns (unchanged)
    const passOptions = computed(() => {
      const opts = [];
      for (const ship of ships.value) {
        if ((ship.coldMass || 0) > 0 && massFits(ship.coldMass)) opts.push({ label: `${ship.name} — Cold`, mass: ship.coldMass });
        if ((ship.hotMass  || 0) > 0 && massFits(ship.hotMass))  opts.push({ label: `${ship.name} — Hot`,  mass: ship.hotMass  });
      }
      return opts;
    });

    // mpShipOptions: ship objects for the multi-pilot worker (need both masses)
    const mpShipOptions = computed(() =>
      ships.value
        .filter(s => (s.coldMass || 0) > 0 && (s.hotMass || 0) > 0 && massFits(s.coldMass || 0))
        .map(s => ({ id: s.id, name: s.name, coldMass: s.coldMass, hotMass: s.hotMass }))
    );

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
    const calcDirty     = ref(false);

    // Receive results back from the worker
    _calcWorker.onmessage = (e) => {
      worstCasePlan.value = e.data.worstCasePlan;
      bestCasePlan.value  = e.data.bestCasePlan;
      calcBusy.value = false;
      if (calcDirty.value) triggerCalc();
    };

    function triggerCalc() {
      if (calcBusy.value) { calcDirty.value = true; return; }
      calcBusy.value      = true;
      worstCasePlan.value = null;
      bestCasePlan.value  = null;
      calcDirty.value     = false;
      _calcWorker.postMessage({
        mpOptions:    mpShipOptions.value,
        numPilots:    numPilots.value,
        scoutMasses:  farSideShips.value.map(f => f.mass),
        massToColMin: effectiveMassToColMin.value,
        massToColMax: effectiveMassToColMax.value,
      });
    }

    watch([mpShipOptions, massToColMin, massToColMax, effectiveUsedMass, numPilots], () => triggerCalc());
    watch(farSideShips, () => triggerCalc(), { deep: true });
    watch(activeTab, tab => { if (tab === 'roll') triggerCalc(); });

    triggerCalc(); // run immediately on load

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
      // Keep wormhole.status in sync with the most recent remaining state entry
      const lastState = [...passes.value].reverse().find(p => p.mode === 'state');
      wormhole.status = lastState?.newStatus ?? 'stable';
    }

    function clearPasses() {
      if (confirm('Clear all recorded passes for this session?')) passes.value = [];
    }

    // Record a pass directly from a plan row (plan rows have label + mass)
    function recordPlanPass(row) {
      passes.value.push({ id: genId(), mode: 'plan', label: row.label, mass: row.mass });
    }

    // State progression: stable → reduced → critical → collapsed
    const nextWhState = computed(() => {
      const seq = { stable: 'reduced', reduced: 'critical', critical: 'collapsed' };
      return seq[wormhole.status] ?? null;
    });

    function advanceWhState() {
      const next = nextWhState.value;
      if (!next) return;
      wormhole.status = next;
      passes.value.push({ id: genId(), mode: 'state', newStatus: next, mass: 0 });
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

    function _whStateAfter(pct) {
      if (pct >= 100) return 'Collapsed ⊗';
      if (pct >= 90)  return 'Critical ⚠';
      if (pct >= 50)  return 'Reduced';
      return 'Stable';
    }

    function _insertThresholds(rows, thresholds, base, prevRunning, curRunning) {
      for (const thr of thresholds) {
        const rel = thr.mass - base;
        if (prevRunning < rel && curRunning >= rel) {
          rows.push({ rowType: 'threshold', label: thr.label, key: thr.key });
        }
      }
    }

    // Build flat display rows from a grouped multi-pilot plan.
    // Returns rows of types: group-header, phase-header, rolling, threshold.
    function buildGroupedDisplayPlan(plan) {
      if (!plan || plan.impossible || plan.alreadyCollapsed) return [];
      if (!plan.groups || !plan.groups.length) return [];

      const b      = effectiveUsedMass.value;
      const total  = wormhole.totalMass;
      const thresholds = [
        { key: 'reduced',   label: 'Reduced (50%)',    mass: total * 0.5 },
        { key: 'critical',  label: 'Critical (90%)',   mass: total * 0.9 },
        { key: 'collapsed', label: 'Collapsed (100%)', mass: total * 1.0 },
      ].filter(t => t.mass > b);

      const rows = [];
      let running = 0;
      let prevRunning = 0;

      function addPass(pass) {
        const prev = running;
        running += pass.mass;
        const totalThrough = b + running;
        const pct = total > 0 ? (totalThrough / total) * 100 : 0;
        rows.push({
          rowType: 'rolling',
          direction: pass.direction,
          isScout:  !!pass.isScout,
          isFinal:  !!pass.isFinal,
          label: `${pass.name} — ${pass.passType === 'hot' ? '♨ Hot' : '❄ Cold'}`,
          mass: pass.mass,
          passType: pass.passType,
          running,
          totalThrough,
          pct,
          stateAfter: _whStateAfter(pct),
        });
        _insertThresholds(rows, thresholds, b, prevRunning, running);
        prevRunning = running;
      }

      for (let gi = 0; gi < plan.groups.length; gi++) {
        const group = plan.groups[gi];
        const groupNum = gi + 1;

        rows.push({
          rowType:      'group-header',
          groupNum,
          groupType:    group.type,
          pilotCount:   group.pilotCount,
          totalGroups:  plan.groups.length,
        });

        // Enter phase
        rows.push({ rowType: 'phase-header', direction: 'enter', count: group.enters.length });
        for (const pass of group.enters) addPass(pass);

        // Scout returns (final group only, shown before regular returns)
        if (group.scoutReturns && group.scoutReturns.length) {
          rows.push({ rowType: 'phase-header', direction: 'scout-return', count: group.scoutReturns.length });
          for (const pass of group.scoutReturns) addPass(pass);
        }

        // Return phase
        rows.push({ rowType: 'phase-header', direction: 'return', count: group.returns.length });
        for (const pass of group.returns) addPass(pass);
      }

      // Mark the very first rolling row as 'isNext' (the next action to take)
      const firstRolling = rows.find(r => r.rowType === 'rolling');
      if (firstRolling) firstRolling.isNext = true;

      return rows;
    }

    // ── Unified Plan (done passes + planned groups merged) ────────────────────
    const activePlanView = ref('worst');

    function buildFullDisplayPlan(plan) {
      const result = [];

      for (const p of passesWithRunning.value) {
        if (p.mode === 'state') {
          result.push({ rowType: 'state-marker', id: p.id, label: passLabel(p), newStatus: p.newStatus });
        } else {
          const pct = wormhole.totalMass > 0 ? (p.running / wormhole.totalMass) * 100 : 0;
          result.push({
            rowType: 'done',
            id: p.id,
            label: passLabel(p),
            mass: p.mass,
            running: p.running,
            num: p.num,
            totalThrough: p.running,
            pct,
            stateAfter: _whStateAfter(pct),
          });
        }
      }

      const plannedRows = buildGroupedDisplayPlan(plan);

      const hasCompleted = result.some(r => r.rowType === 'done');
      const hasPlanned   = plannedRows.some(r => r.rowType === 'rolling');
      if (hasCompleted && hasPlanned) result.push({ rowType: 'divider' });

      for (const row of plannedRows) result.push(row);

      return result;
    }

    const displayFullBestCase = computed(() => buildFullDisplayPlan(bestCasePlan.value));
    const displayFullWorstCase = computed(() => buildFullDisplayPlan(worstCasePlan.value));
    const activePlanDisplay = computed(() =>
      activePlanView.value === 'best' ? displayFullBestCase.value : displayFullWorstCase.value
    );
    const activePlan = computed(() =>
      activePlanView.value === 'best' ? bestCasePlan.value : worstCasePlan.value
    );
    const nextPassRow = computed(() => {
      const display = activePlanDisplay.value;
      return display.find(r => r.rowType === 'rolling' && r.isNext) ?? null;
    });


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
      usedMass, effectiveUsedMass, statusMinUsed, usedPct,
      massToReduced, massToCritical, massToColMin, massToColMax,
      farSideShips, farSideForm, farSideMass, farSideSelectedShip, farSideShipMass,
      canSubmitFarSide, farSideCustomMassInput, farSideAloneCollapses, farSideOverCollapses,
      effectiveMassToColMin, effectiveMassToColMax,
      rollingTarget, numPilots,
      activePlanView, activePlanDisplay, activePlan, nextPassRow,
      passTooltip, showPassTooltip, hidePassTooltip,
      barFillStyle, barVarianceStyle, markerReducedLeft, markerCriticalLeft, markerTotalLeft,
      statusClass, selectedShip, shipPassMass, shipPassFits, canSubmitPass,
      passesReversed, passesWithRunning, passOptions, worstCasePlan, bestCasePlan, calcBusy,
      shipModalValid, unitStep,
      whTotalMassInput, draftColdInput, draftHotInput, customMassInput,
      applyTheme, fmtMass, massFits,
      addPass, removePass, clearPasses, resetSession, recordPlanPass, advanceWhState, nextWhState,
      addFarSideShip, removeFarSideShip,
      passLabel,
      openAddShip, openEditShip, closeShipModal, saveShip, deleteShip, cloneShip,
      exportYAML, triggerImport, handleYAMLFile,
    };
  },
}).mount('#app');

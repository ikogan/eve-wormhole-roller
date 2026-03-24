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
const STORAGE_SHOW_PLAN      = 'eve-whr-show-plan-v1';
const STORAGE_ACTIVE_TAB     = 'eve-whr-active-tab-v1';
const STORAGE_PLAN_VIEW      = 'eve-whr-plan-view-v1';

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

// targetCapacity: the specific WH capacity we're planning for (min or max variant).
function buildMultiPilotPlan(mpOptions, numPilots, scoutShips, strandedShips, targetCapacity) {
  numPilots = (numPilots >= 1 && isFinite(numPilots)) ? Math.floor(numPilots) : 1;
  if (targetCapacity <= 0) return { alreadyCollapsed: true, groups: [] };
  if (!mpOptions || !mpOptions.length) return { impossible: true, msg: 'No eligible ships for this wormhole size.' };

  // Sort by hot mass descending — heaviest hot ship maximises mass per bulk pass
  var sorted = mpOptions.slice().sort(function(a, b) { return b.hotMass - a.hotMass; });
  var heavy = sorted[0];
  if (!heavy.hotMass) return { impossible: true, msg: 'All ships have zero hot mass.' };

  var scoutMassTotal = 0;
  for (var s = 0; s < scoutShips.length; s++) scoutMassTotal += scoutShips[s].mass;

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

    // _findBulkConfig is exhaustive within a given K, so kMin always gives the correct answer.
    var config = _findBulkConfig(kMin, heavy, M_min, M_max, maxRT, minRT);
    if (!config) continue;

    var result = _makeGroups(kMin, numPilots, heavy, finalShip, config, scoutShips, scoutMassTotal, strandedShips);
    if (result && result.totalGroups <= MAX_GROUPS) {
      if (!bestResult || result.totalPasses < bestResult.totalPasses) {
        bestResult = result;
      }
    }
  }

  return bestResult || { impossible: true, msg: 'No valid plan found. Try adding ships with different mass values or more pilots.' };
}

/**
 * Given K bulk round-trips and the heavy ship, find a hot/cold mix whose total
 * mass lands in [M_min, M_max].
 *
 * Each round-trip contributes one of:
 *   "hot"  — hot enter + hot return  = 2 * hotMass         (max per-RT mass)
 *   "mix"  — hot enter + cold return = hotMass + coldMass  (saves d = hotMass - coldMass)
 *   "cold" — cold enter + cold return = 2 * coldMass       (saves 2*d vs all-hot)
 *
 * Parameterise by n = savings units: each mix uses 1 unit, each cold uses 2 units.
 * Achievable totals: allHotTotal - n*d for n ∈ {0, 1, …, 2K}.
 * Find minimum n such that the total lands in [M_min, M_max].
 * Decompose: coldRTs = floor(n/2), mixRTs = n%2 (0 or 1), hotRTs = K - coldRTs - mixRTs.
 */
function _findBulkConfig(K, heavy, M_min, M_max, maxRT, minRT) {
  if (K === 0) {
    return (M_min <= 0) ? { hotRTs: 0, mixRTs: 0, coldRTs: 0, total: 0 } : null;
  }

  var allHotTotal = K * maxRT;
  var d = heavy.hotMass - heavy.coldMass; // savings per unit

  if (d <= 0) {
    // No distinction between hot and cold — only all-hot available
    return (allHotTotal >= M_min && allHotTotal <= M_max)
      ? { hotRTs: K, mixRTs: 0, coldRTs: 0, total: allHotTotal }
      : null;
  }

  // Savings needed to reach M_max from below (lower bound on n)
  var S_min = Math.max(0, allHotTotal - M_max);
  // Savings needed to still stay above M_min (upper bound on n)
  var S_max = allHotTotal - M_min;

  if (S_max < 0 || S_min > 2 * K * d) return null; // completely out of range

  var n_min = Math.ceil(S_min / d);
  var n_max = Math.min(Math.floor(S_max / d), 2 * K);
  if (n_min > n_max) return null;

  // Use minimum n (fewest cold/mix RTs) — prefer hot passes for tighter mass control
  var n = n_min;
  var coldRTs = Math.floor(n / 2);
  var mixRTs  = n % 2;
  var hotRTs  = K - coldRTs - mixRTs;
  if (hotRTs < 0) return null;

  var total = hotRTs * maxRT + mixRTs * (heavy.hotMass + heavy.coldMass) + coldRTs * minRT;
  return { hotRTs: hotRTs, mixRTs: mixRTs, coldRTs: coldRTs, total: total };
}

/**
 * Build the group structure from K total bulk round-trips plus the final group.
 *
 * K = M full N-pilot bulk groups + extraRTs remainder single-pilot groups + 1 final group.
 *
 * Each extraRT becomes its own 1-pilot solo group (enter then return) placed after
 * the full bulk groups. This ensures at most 1 pilot is ever on the far side during
 * the collapse window, regardless of how many total pilots are rolling.
 *
 * config.hotRTs  round-trips use hot enter + hot return (heaviest)
 * config.mixRTs  round-trips use hot enter + cold return (one direction each)
 * config.coldRTs round-trips use cold enter + cold return (lightest)
 */
function _makeGroups(K, numPilots, heavyShip, finalShip, config, scoutShips, scoutMassTotal, strandedShips) {
  // Pre-build the ordered list of K round-trips (hottest first).
  var rts = [];
  for (var i = 0; i < config.hotRTs;  i++) rts.push({ em: heavyShip.hotMass,  et: 'hot',  rm: heavyShip.hotMass,  rt: 'hot'  });
  for (var i = 0; i < config.mixRTs;  i++) rts.push({ em: heavyShip.hotMass,  et: 'hot',  rm: heavyShip.coldMass, rt: 'cold' });
  for (var i = 0; i < config.coldRTs; i++) rts.push({ em: heavyShip.coldMass, et: 'cold', rm: heavyShip.coldMass, rt: 'cold' });

  var M        = Math.floor(K / numPilots); // full N-pilot bulk groups
  var extraRTs = K % numPilots;             // remainder single-pilot solo groups
  var groups   = [];

  // M full bulk groups — all N pilots do one round-trip each.
  for (var gi = 0; gi < M; gi++) {
    var enters = [], returns = [];
    var base = gi * numPilots;
    for (var p = 0; p < numPilots; p++) {
      var rt = rts[base + p];
      enters.push({ name: heavyShip.name, mass: rt.em, passType: rt.et, direction: 'enter', hotMass: heavyShip.hotMass, coldMass: heavyShip.coldMass });
      returns.push({ name: heavyShip.name, mass: rt.rm, passType: rt.rt, direction: 'return', hotMass: heavyShip.hotMass, coldMass: heavyShip.coldMass });
    }
    groups.push({ type: 'bulk', pilotCount: numPilots, enters: enters, scoutReturns: [], returns: returns });
  }

  // Each extraRT becomes its own 1-pilot solo group (safer: only 1 pilot at risk at a time).
  var fgBase = M * numPilots;
  for (var p = 0; p < extraRTs; p++) {
    var rt = rts[fgBase + p];
    groups.push({ type: 'bulk', pilotCount: 1,
      enters:       [{ name: heavyShip.name, mass: rt.em, passType: rt.et, direction: 'enter', hotMass: heavyShip.hotMass, coldMass: heavyShip.coldMass }],
      scoutReturns: [],
      returns:      [{ name: heavyShip.name, mass: rt.rm, passType: rt.rt, direction: 'return', hotMass: heavyShip.hotMass, coldMass: heavyShip.coldMass }]
    });
  }

  // Final group: only the collapse pilot + scouts (exactly 1 pilot at risk during collapse).
  var fgScouts = [];
  for (var s = 0; s < scoutShips.length; s++) {
    fgScouts.push({ name: scoutShips[s].name, mass: scoutShips[s].mass, passType: 'cold', direction: 'return', isScout: true });
  }

  groups.push({ type: 'final', pilotCount: 1 + scoutShips.length,
    enters:       [{ name: finalShip.name, mass: finalShip.coldMass, passType: 'cold', direction: 'enter', hotMass: finalShip.hotMass, coldMass: finalShip.coldMass }],
    scoutReturns: fgScouts,
    returns:      [{ name: finalShip.name, mass: finalShip.hotMass, passType: 'hot', direction: 'return', isFinal: true, hotMass: finalShip.hotMass, coldMass: finalShip.coldMass }]
  });

  // If any ships are stranded on the far side, prepend a return-only group so they exit FIRST
  // before any new pilots enter. This ensures no one is left on the far side.
  if (strandedShips && strandedShips.length > 0) {
    var strandedReturns = [];
    for (var s = 0; s < strandedShips.length; s++) {
      var ss = strandedShips[s];
      strandedReturns.push({ name: ss.name, mass: ss.coldMass || ss.mass, passType: 'cold', direction: 'return', isStranded: true, hotMass: ss.hotMass || null, coldMass: ss.coldMass || null });
    }
    groups.unshift({ type: 'stranded', pilotCount: strandedShips.length, enters: [], scoutReturns: strandedReturns, returns: [] });
  }

  var totalPasses = 0;
  var strandedMassTotal = 0;
  for (var s = 0; s < (strandedShips || []).length; s++) strandedMassTotal += strandedShips[s].mass;
  for (var g = 0; g < groups.length; g++) {
    totalPasses += groups[g].enters.length + groups[g].scoutReturns.length + groups[g].returns.length;
  }
  var totalMass = config.total + finalShip.coldMass + scoutMassTotal + strandedMassTotal + finalShip.hotMass;

  return { groups: groups, totalMass: totalMass, totalPasses: totalPasses, totalGroups: groups.length };
}

self.onmessage = function(e) {
  var d = e.data;
  self.postMessage({
    bestCasePlan:  buildMultiPilotPlan(d.mpOptions, d.numPilots, d.scoutShips, d.strandedShips, d.massToColMin),
    worstCasePlan: buildMultiPilotPlan(d.mpOptions, d.numPilots, d.scoutShips, d.strandedShips, d.massToColMax),
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
    const activeTab     = ref(localStorage.getItem(STORAGE_ACTIVE_TAB) || 'setup');
    const selectedTheme = ref(localStorage.getItem(STORAGE_THEME) || 'caldari');
    const massUnit      = ref(localStorage.getItem(STORAGE_UNIT)  || 'kg'); // 'kg' | 't'

    const savedWh = JSON.parse(localStorage.getItem(STORAGE_WH) || 'null');
    const wormhole = reactive({
      name:      savedWh?.name      ?? '',
      totalMass: savedWh?.totalMass ?? 0,  // always stored in kg
      status:    savedWh?.status    ?? 'stable',
      size:      savedWh?.size      ?? '', // '' = unknown / not set
      typeName:  savedWh?.typeName  ?? '', // '' = no type selected (e.g. "Z971")
    });

    const ships      = ref(JSON.parse(localStorage.getItem(STORAGE_SHIPS)    || '[]'));
    const passes     = ref(JSON.parse(localStorage.getItem(STORAGE_PASSES)   || '[]'));
    const farSideShips = ref(JSON.parse(localStorage.getItem(STORAGE_FAR_SIDE) || '[]'));
    const rollingTarget = ref(localStorage.getItem(STORAGE_ROLLING_TARGET) || 'collapse'); // 'collapse' | 'critical'
    const numPilots  = ref(Number(localStorage.getItem(STORAGE_PILOTS)) || 2);
    const showPlan   = ref(localStorage.getItem(STORAGE_SHOW_PLAN) !== 'false');

    const passForm = reactive({
      mode:       'ship',    // 'ship' | 'custom'
      shipId:     '',
      passType:   'cold',    // 'hot' | 'cold'
      customMass: null,      // stored in kg
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
    watch(showPlan,      val => localStorage.setItem(STORAGE_SHOW_PLAN, String(val)));
    watch(activeTab,     val => localStorage.setItem(STORAGE_ACTIVE_TAB, val));

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

    // ── Wormhole Type (ESI typeahead) ─────────────────────────────────────────
    // whTypeData: array of {name, typeId} loaded from window.WH_TYPE_DATA or data/wormhole-types.json
    const whTypeData = ref(Array.isArray(window.WH_TYPE_DATA) ? window.WH_TYPE_DATA : []);

    // If the data wasn't embedded (GitHub Pages), wait for the fetch to complete
    if (!Array.isArray(window.WH_TYPE_DATA) || whTypeData.value.length === 0) {
      const poll = setInterval(() => {
        if (Array.isArray(window.WH_TYPE_DATA) && window.WH_TYPE_DATA.length > 0) {
          whTypeData.value = window.WH_TYPE_DATA;
          clearInterval(poll);
        }
      }, 200);
    }

    // The matched type entry (null if no match or no value)
    const whTypeEntry    = computed(() => whTypeData.value.find(t => t.name === wormhole.typeName) ?? null);
    const whTypeId       = computed(() => whTypeEntry.value?.typeId ?? null);
    // True if user has typed something that doesn't match any known type
    const whTypeIsCustom = computed(() => !!wormhole.typeName && !whTypeEntry.value);

    const whTypeFetching = ref(false);

    // Combined display name shown in header and plan: "{typeName} — {name}" or just one of them
    const whDisplayName = computed(() => {
      const type = wormhole.typeName.trim();
      const name = wormhole.name.trim();
      if (type && name) return `${type} — ${name}`;
      return type || name || null;
    });

    // ESI dogma attribute IDs for wormhole types
    const ESI_ATTR_MAX_STABLE_MASS = 1383; // total mass limit in kg
    const ESI_ATTR_MAX_JUMP_MASS   = 1385; // max single-jump mass in kg

    async function onWhTypeChange() {
      const typeId = whTypeId.value;
      if (!typeId) return; // custom or empty — don't fetch
      whTypeFetching.value = true;
      try {
        const resp = await fetch(`https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility`);
        if (!resp.ok) return;
        const data = await resp.json();
        const attrs = data.dogma_attributes || [];
        const getAttr = id => attrs.find(a => a.attribute_id === id)?.value ?? null;

        const totalMass  = getAttr(ESI_ATTR_MAX_STABLE_MASS);
        const maxJumpMass = getAttr(ESI_ATTR_MAX_JUMP_MASS);

        if (totalMass  != null) wormhole.totalMass = totalMass;
        if (maxJumpMass != null) {
          // Map maxJumpMass to the closest WH_SIZES entry
          const matched = WH_SIZES.reduce((best, sz) =>
            Math.abs(sz.maxShipMass - maxJumpMass) < Math.abs(best.maxShipMass - maxJumpMass) ? sz : best
          );
          if (Math.abs(matched.maxShipMass - maxJumpMass) < maxJumpMass * 0.5) {
            wormhole.size = matched.id;
          }
        }
      } catch (_) {
        // Network error — leave fields unchanged
      } finally {
        whTypeFetching.value = false;
      }
    }

    // Also trigger ESI fetch when typeName changes to a known type via keyboard (datalist selection)
    watch(() => wormhole.typeName, (newVal) => {
      if (whTypeEntry.value) onWhTypeChange();
    });

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

    // Stranded ships: ALL passes with 'enter' direction that haven't been matched by a 'return' yet.
    // Manual (ship/custom) passes are always enters. Returns only happen via plan passes.
    // These ships are physically on the far side and must return before the WH collapses.
    const strandedManualShips = computed(() => {
      const stack = [];
      for (const p of passes.value) {
        if (p.mode === 'state') continue;
        if (!p.direction) continue;
        if (p.direction === 'enter') {
          let name = 'Custom';
          let shipId = null, coldMass = null, hotMass = null;
          if (p.mode === 'plan') {
            name = p.label ? p.label.split(' —')[0].trim() : 'Pilot';
          } else if (p.mode === 'ship') {
            const ship = ships.value.find(s => s.id === p.shipId);
            name = ship ? ship.name : 'Unknown Ship';
            shipId = p.shipId || null;
            coldMass = ship?.coldMass || null;
            hotMass  = ship?.hotMass  || null;
          }
          stack.push({ name, mass: p.mass, passId: p.id, shipId, coldMass, hotMass });
        } else if (p.direction === 'return' && stack.length > 0) {
          stack.pop();
        }
      }
      return stack;
    });
    const strandedManualMassTotal = computed(() => strandedManualShips.value.reduce((s, sh) => s + sh.mass, 0));

    // Per-ship exit pass type selection (passId → 'cold'|'hot') for the history view exit UI
    const strandedExitPassTypes = ref({});

    function toggleStrandedExitType(passId) {
      const current = strandedExitPassTypes.value[passId] || 'cold';
      strandedExitPassTypes.value = { ...strandedExitPassTypes.value, [passId]: current === 'cold' ? 'hot' : 'cold' };
    }

    // Enriched list: each stranded ship combined with selected exit type, exit mass, and projected remaining mass
    const strandedShipsWithExitOpts = computed(() => {
      return strandedManualShips.value.map(ship => {
        const canToggle = ship.coldMass != null && ship.hotMass != null && ship.coldMass > 0 && ship.hotMass > 0;
        const passType = strandedExitPassTypes.value[ship.passId] || 'cold';
        const exitMass = canToggle
          ? (passType === 'hot' ? ship.hotMass : ship.coldMass)
          : ship.mass;
        const remainingAfterExit = Math.max(0, wormhole.totalMass - effectiveUsedMass.value - exitMass);
        return { ...ship, canToggle, passType, exitMass, remainingAfterExit };
      });
    });

    // Mass remaining for rolling passes after far-side ships (pre-configured + stranded manual) return
    const effectiveMassToColMin = computed(() => Math.max(0, massToColMin.value - farSideMass.value - strandedManualMassTotal.value));
    const effectiveMassToColMax = computed(() => Math.max(0, massToColMax.value - farSideMass.value - strandedManualMassTotal.value));
    // True when far-side ships alone will bring the WH into its collapse window
    const farSideAloneCollapses  = computed(() => farSideMass.value > 0 && farSideMass.value >= massToColMin.value);
    const farSideOverCollapses   = computed(() => farSideMass.value > massToColMax.value);

    // Mass from non-plan passes only (ship/custom/state modes).
    // Used as the recalc trigger so that recording a plan pass does NOT restart the plan.
    const nonPlanUsedMass = computed(() =>
      passes.value.filter(p => p.mode !== 'plan').reduce((s, p) => s + (p.mass || 0), 0)
    );
    // Remaining-mass computeds for recalc trigger (excludes plan-pass mass, includes status floor).
    const nonPlanMassToColMin = computed(() =>
      Math.max(0, wormhole.totalMass * (rollingTarget.value === 'critical' ? 0.9 : 1.0)
        - Math.max(nonPlanUsedMass.value, statusMinUsed.value) - farSideMass.value)
    );
    const nonPlanMassToColMax = computed(() =>
      Math.max(0, wormhole.totalMass * (rollingTarget.value === 'critical' ? 1.0 : 1.1)
        - Math.max(nonPlanUsedMass.value, statusMinUsed.value) - farSideMass.value)
    );

    const farSideSelectedShip = computed(() => ships.value.find(s => s.id === farSideForm.shipId) ?? null);
    const farSideShipMass     = computed(() => {
      if (!farSideSelectedShip.value) return 0;
      // Return is always cold — scouts don't need MWD to come back.
      return farSideSelectedShip.value.coldMass || 0;
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
      if (pass.mode === 'custom') return pass.label || 'Custom Pass';
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

    const worstCasePlan   = ref(null);
    const bestCasePlan    = ref(null);
    const calcBusy        = ref(false);
    const calcDirty       = ref(false);
    // How many plan passes have been recorded against the current (stable) plan.
    // Resets to 0 whenever the worker produces a new plan.
    const plannedPassCount = ref(0);

    // Per-pass hot/cold overrides for the plan view. Key = globalIdx (absolute pass position in plan).
    // Cleared whenever a new plan is computed so stale overrides don't bleed into a different plan structure.
    const planPassOverrides = ref({});

    function togglePlanPassType(globalIdx) {
      const current = planPassOverrides.value[globalIdx];
      // Determine the plan pass's base passType from the display (we'll cycle: unset→opposite of default, etc.)
      // Simplest: toggle between explicitly 'hot' and 'cold'; use null to mean "use plan default"
      planPassOverrides.value = { ...planPassOverrides.value, [globalIdx]: current === 'hot' ? 'cold' : 'hot' };
    }

    // Receive results back from the worker
    _calcWorker.onmessage = (e) => {
      worstCasePlan.value  = e.data.worstCasePlan;
      bestCasePlan.value   = e.data.bestCasePlan;
      calcBusy.value       = false;
      plannedPassCount.value = 0; // new plan — NEXT starts from the first pass
      planPassOverrides.value = {}; // clear overrides — new plan structure may differ
      if (calcDirty.value) triggerCalc();
    };

    function triggerCalc() {
      if (calcBusy.value) { calcDirty.value = true; return; }
      // Don't run with an invalid pilot count — the worker would loop infinitely on division by zero.
      const pilots = Math.floor(numPilots.value);
      if (!pilots || pilots < 1) return;
      calcBusy.value      = true;
      worstCasePlan.value = null;
      bestCasePlan.value  = null;
      calcDirty.value     = false;
      _calcWorker.postMessage({
        mpOptions:     mpShipOptions.value,
        numPilots:     pilots,
        scoutShips:    farSideShips.value.map(f => ({ name: f.label || 'Scout', mass: f.mass })),
        strandedShips: strandedManualShips.value,
        massToColMin:  effectiveMassToColMin.value,
        massToColMax:  effectiveMassToColMax.value,
      });
    }

    // Only trigger recalculation on config/manual-pass changes — NOT on plan pass recording.
    // nonPlanMassToColMin/Max exclude plan-pass mass so plan passes don't restart the plan.
    watch([mpShipOptions, nonPlanMassToColMin, nonPlanMassToColMax, numPilots], () => triggerCalc());
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
        entry = { id: genId(), mode: 'ship', shipId: passForm.shipId, passType: passForm.passType, mass: shipPassMass.value, direction: 'enter' };
      } else {
        entry = { id: genId(), mode: 'custom', mass: Number(passForm.customMass), direction: 'enter' };
        passForm.customMass = null;
      }
      passes.value.push(entry);
    }

    function removePass(id) {
      const idx = passes.value.findIndex(p => p.id === id);
      if (idx >= 0) {
        const removed = passes.value[idx];
        passes.value.splice(idx, 1);
        // If a recorded plan pass was removed, unwind the count so the plan re-anchors correctly
        if (removed.mode === 'plan') {
          plannedPassCount.value = Math.max(0, plannedPassCount.value - 1);
        }
      }
      // Keep wormhole.status in sync with the most recent remaining state entry
      const lastState = [...passes.value].reverse().find(p => p.mode === 'state');
      wormhole.status = lastState?.newStatus ?? 'stable';
      // Always recalculate after any removal — pass removal is a config change
      triggerCalc();
    }

    function clearPasses() {
      if (confirm('Clear all recorded passes for this session?')) {
        passes.value = [];
        plannedPassCount.value = 0;
        triggerCalc();
      }
    }

    // Record an exit (return) pass for a stranded ship — used in simple (no-plan) mode
    function recordExitPass(ship) {
      const { exitMass, passType, shipId, name, passId } = ship;
      if (shipId) {
        // Known fleet ship: store as ship mode so passLabel generates the correct "Name (Hot/Cold)" label
        passes.value.push({ id: genId(), mode: 'ship', shipId, passType, direction: 'return', mass: exitMass });
      } else {
        // Plan pass or custom entry: store explicit label since there's no fleet profile
        const typeStr = passType === 'hot' ? ' (♨ Hot)' : ' (❄ Cold)';
        passes.value.push({ id: genId(), mode: 'custom', direction: 'return', mass: exitMass, label: name + typeStr });
      }
      // Clear the exit type selection for this ship's passId
      const updated = { ...strandedExitPassTypes.value };
      delete updated[passId];
      strandedExitPassTypes.value = updated;
    }

    // Record a pass directly from a plan row (stores group context for history display)
    function recordPlanPass(row) {
      passes.value.push({
        id: genId(), mode: 'plan', label: row.label, mass: row.mass,
        groupNum: row.groupNum, groupType: row.groupType, pilotCount: row.pilotCount,
        direction: row.direction, isScout: !!row.isScout, isFinal: !!row.isFinal,
      });
      plannedPassCount.value++;
      // Clear any override for this pass so the next plan starts clean
      if (row.globalIdx != null) {
        const updated = { ...planPassOverrides.value };
        delete updated[row.globalIdx];
        planPassOverrides.value = updated;
      }
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
        wormhole.typeName = '';
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
          label: `${farSideSelectedShip.value.name} — ${farSideForm.passType === 'hot' ? '♨ Hot' : '❄ Cold'}`,
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

    // Build flat display rows from the remaining (not-yet-recorded) passes of a plan.
    // skipCount = plannedPassCount: passes already recorded, skipped from display (shown in history).
    // Returns rows of types: group-header, phase-header, rolling, threshold.
    function buildGroupedDisplayPlan(plan, skipCount) {
      if (!plan || plan.impossible || plan.alreadyCollapsed) return [];
      if (!plan.groups || !plan.groups.length) return [];

      const skip  = Math.max(0, skipCount || 0);
      const b     = effectiveUsedMass.value;
      const total = wormhole.totalMass;
      const thresholds = [
        { key: 'reduced',   label: 'Reduced (50%)',    mass: total * 0.5 },
        { key: 'critical',  label: 'Critical (90%)',   mass: total * 0.9 },
        { key: 'collapsed', label: 'Collapsed (100%)', mass: total * 1.0 },
      ].filter(t => t.mass > b);

      const rows = [];
      let running     = 0;
      let prevRunning = 0;
      let globalIdx   = 0; // index across every rolling pass in the whole plan

      for (let gi = 0; gi < plan.groups.length; gi++) {
        const group    = plan.groups[gi];
        // Stranded groups don't count toward the group number
        const groupNum = gi + 1 - plan.groups.slice(0, gi + 1).filter(g => g.type === 'stranded').length;

        // Ordered list of phases for this group
        const phases = [
          { dir: 'enter',        passes: group.enters },
          ...(group.scoutReturns && group.scoutReturns.length
                ? [{ dir: 'scout-return', passes: group.scoutReturns }] : []),
          { dir: 'return',       passes: group.returns },
        ];
        const groupPassCount = phases.reduce((s, ph) => s + ph.passes.length, 0);

        // Skip groups that are entirely done
        if (globalIdx + groupPassCount <= skip) {
          globalIdx += groupPassCount;
          continue;
        }

        rows.push({
          rowType: 'group-header', groupNum, groupType: group.type,
          pilotCount: group.pilotCount, totalGroups: plan.groups.length,
        });

        for (const phase of phases) {
          // How many passes in this phase are already done?
          const phaseDone    = Math.max(0, Math.min(phase.passes.length, skip - globalIdx));
          const pendingPasses = phase.passes.slice(phaseDone);
          globalIdx += phaseDone;

          if (pendingPasses.length === 0) continue;

          rows.push({ rowType: 'phase-header', direction: phase.dir, count: pendingPasses.length, isStranded: group.type === 'stranded' });

          for (const pass of pendingPasses) {
            const isNext = globalIdx === skip;
            // Apply any user override for this pass position
            const overrideType = planPassOverrides.value[globalIdx];
            const canToggle = !!(pass.hotMass && pass.coldMass && pass.hotMass > 0 && pass.coldMass > 0 && pass.hotMass !== pass.coldMass);
            const passType  = canToggle && overrideType ? overrideType : pass.passType;
            const passMass  = canToggle && overrideType
              ? (overrideType === 'hot' ? pass.hotMass : pass.coldMass)
              : pass.mass;
            running += passMass;
            const totalThrough = b + running;
            const pct = total > 0 ? (totalThrough / total) * 100 : 0;
            // Scouts can't toggle — their name already describes the ship; don't append hot/cold
            const label = pass.isScout ? pass.name : `${pass.name} — ${passType === 'hot' ? '♨ Hot' : '❄ Cold'}`;
            rows.push({
              rowType: 'rolling', groupNum, groupType: group.type, pilotCount: group.pilotCount,
              direction: pass.direction, isScout: !!pass.isScout, isFinal: !!pass.isFinal,
              label,
              mass: passMass, passType,
              hotMass: pass.hotMass, coldMass: pass.coldMass, canToggle,
              globalIdx,
              running, totalThrough, pct, stateAfter: _whStateAfter(pct), isNext,
              remainingMass: Math.max(0, total - totalThrough),
            });
            // Only insert the "Collapsed" threshold marker on the isFinal pass (the hot return).
            // Intermediate passes (e.g. scout return) can push cumulative mass past 100% but the
            // WH stays open until the collapse pass actually transits; showing it earlier is confusing.
            _insertThresholds(rows, pass.isFinal ? thresholds : thresholds.filter(t => t.key !== 'collapsed'), b, prevRunning, running);
            prevRunning = running;
            globalIdx++;
          }
        }
      }

      return rows;
    }

    // ── Unified Plan (done passes + planned groups merged) ────────────────────
    const activePlanView = ref(localStorage.getItem(STORAGE_PLAN_VIEW) || 'best');
    watch(activePlanView, val => localStorage.setItem(STORAGE_PLAN_VIEW, val));

    function buildFullDisplayPlan(plan) {
      const result = [];
      let prevDoneGroupNum = null;
      let prevDoneDirection = null;

      for (const p of passesWithRunning.value) {
        if (p.mode === 'state') {
          prevDoneGroupNum = null;
          prevDoneDirection = null;
          result.push({ rowType: 'state-marker', id: p.id, label: passLabel(p), newStatus: p.newStatus });
        } else {
          if (p.mode === 'plan' && p.groupNum != null) {
            // New group — insert a done group-header
            if (p.groupNum !== prevDoneGroupNum) {
              result.push({
                rowType:    'group-header',
                groupNum:   p.groupNum,
                groupType:  p.groupType,
                pilotCount: p.pilotCount,
                isDone:     true,
              });
              prevDoneGroupNum = p.groupNum;
              prevDoneDirection = null; // reset so phase header is emitted below
            }
            // New phase within group — insert a done phase-header
            if (p.direction && p.direction !== prevDoneDirection) {
              result.push({ rowType: 'phase-header', direction: p.direction, count: null, isDone: true });
              prevDoneDirection = p.direction;
            }
          } else {
            // Non-plan pass: break group context but still emit a direction header if direction changes
            prevDoneGroupNum = null;
            if (p.direction && p.direction !== prevDoneDirection) {
              result.push({ rowType: 'phase-header', direction: p.direction, count: null, isDone: true, isManual: true });
              prevDoneDirection = p.direction;
            }
          }
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
            direction: (['plan', 'ship', 'custom'].includes(p.mode)) ? (p.direction || null) : null,
            isScout: p.isScout || false,
            isFinal: p.isFinal || false,
            remainingMass: Math.max(0, wormhole.totalMass - p.running),
          });
        }
      }

      const plannedRows = buildGroupedDisplayPlan(plan, plannedPassCount.value);

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

    // History-only display: everything recorded so far, no planned rows.
    // History is identical between best/worst case so we use the worst-case build.
    const historyDisplay = computed(() => {
      const rows = displayFullWorstCase.value;
      const dividerIdx = rows.findIndex(r => r.rowType === 'divider');
      return dividerIdx >= 0 ? rows.slice(0, dividerIdx) : rows.filter(r => r.rowType !== 'rolling');
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
      whTypeData, whTypeId, whTypeIsCustom, whTypeFetching, whDisplayName, onWhTypeChange,
      applyTheme, fmtMass, massFits,
      addPass, removePass, clearPasses, resetSession, recordPlanPass, advanceWhState, nextWhState,
      addFarSideShip, removeFarSideShip,
      passLabel,
      openAddShip, openEditShip, closeShipModal, saveShip, deleteShip, cloneShip,
      exportYAML, triggerImport, handleYAMLFile,
      showPlan, strandedManualShips, recordExitPass, historyDisplay,
      strandedShipsWithExitOpts, toggleStrandedExitType,
      planPassOverrides, togglePlanPassType,
    };
  },
}).mount('#app');

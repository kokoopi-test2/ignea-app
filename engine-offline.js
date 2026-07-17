/* ÍGNEA — in-webview offline fire engine (pure JavaScript, zero dependencies).
 *
 * A faithful port of the tested Python offline engine (engine/offline/rothermel.py + spread.py +
 * sectorizer/sectorize.py + command/safety.py) so a prediction runs entirely inside the webview —
 * no Python, no WSL, no GDAL, no server. This is what makes the standalone Tauri .exe (and, later,
 * the Capacitor Android build) work on a machine that has none of the backend stack installed.
 *
 * Data: weather from Open-Meteo (free, no key, CORS) with a sane fallback; terrain slope/aspect from
 * Open-Meteo's elevation grid with a flat fallback; fuel is a single honest default model (no global
 * land-cover reads in the browser). Confidence is deliberately low (0.3) and surfaced in the UI.
 *
 * The result object matches the server's predict_full/predict_offline contract exactly, so the rest
 * of ui/index.html renders it unchanged. Numerically cross-checked against the Python engine.
 */
(function () {
  "use strict";

  // ── Fuel models (Scott & Burgan subset from engine/data/fuel_models.csv) ─────────────────────
  // [number, code, dynamic, w_1h, w_10h, w_100h, w_live_herb, w_live_woody,
  //  sav_1h, sav_live_herb, sav_live_woody, depth_ft, mx_dead_pct, heat]
  // Full Scott & Burgan 40 set (grass/grass-shrub/shrub/timber-understory/timber-litter families)
  // + FBFM01, generated from engine/data/fuel_models.csv. The complete set is needed so the offline
  // per-cell land-cover crosswalk (buildFbfm) can select any climate-appropriate model.
  const FUEL_ROWS = [
    [  1, "FBFM01", false,   0.034,       0,       0,       0,       0, 3500, 9999, 9999,    1, 12, 8000],
    [ 10, "FBFM10", false,   0.138,   0.092,    0.23,       0,   0.092, 2000, 9999, 1500,    1, 25, 8000],
    [101, "GR1   ", true , 0.00459,       0,       0, 0.01377,       0, 2200, 2000, 9999,  0.4, 15, 8000],
    [102, "GR2   ", true , 0.00459,       0,       0, 0.04591,       0, 2000, 1800, 9999,    1, 15, 8000],
    [103, "GR3   ", true , 0.00459, 0.01837,       0, 0.06887,       0, 1500, 1300, 9999,    2, 30, 8000],
    [104, "GR4   ", true , 0.01148,       0,       0, 0.08724,       0, 2000, 1800, 9999,    2, 15, 8000],
    [105, "GR5   ", true , 0.01837,       0,       0, 0.11478,       0, 1800, 1600, 9999,  1.5, 40, 8000],
    [106, "GR6   ", true , 0.00459,       0,       0, 0.15611,       0, 2200, 2000, 9999,  1.5, 40, 9000],
    [107, "GR7   ", true , 0.04591,       0,       0, 0.24793,       0, 2000, 1800, 9999,    3, 15, 8000],
    [108, "GR8   ", true , 0.02296, 0.04591,       0, 0.33517,       0, 1500, 1300, 9999,    4, 30, 8000],
    [109, "GR9   ", true , 0.04591, 0.04591,       0, 0.41322,       0, 1800, 1600, 9999,    5, 40, 8000],
    [121, "GS1   ", true , 0.00918,       0,       0, 0.02296, 0.02984, 2000, 1800, 1800,  0.9, 15, 8000],
    [122, "GS2   ", true , 0.02296, 0.02296,       0, 0.02755, 0.04591, 2000, 1800, 1800,  1.5, 15, 8000],
    [123, "GS3   ", true , 0.01377, 0.01148,       0, 0.06657, 0.05739, 1800, 1600, 1600,  1.8, 40, 8000],
    [124, "GS4   ", true , 0.08724, 0.01377, 0.00459, 0.15611, 0.32599, 1800, 1600, 1600,  2.1, 40, 8000],
    [141, "SH1   ", true , 0.01148, 0.01148,       0, 0.00689, 0.05969, 2000, 1800, 1600,    1, 15, 8000],
    [142, "SH2   ", false, 0.06198, 0.11019, 0.03444,       0, 0.17677, 2000, 9999, 1600,    1, 15, 8000],
    [143, "SH3   ", false, 0.02066, 0.13774,       0,       0, 0.28466, 1600, 9999, 1400,  2.4, 40, 8000],
    [144, "SH4   ", false, 0.03903,  0.0528, 0.00918,       0, 0.11708, 2000, 1800, 1600,    3, 30, 8000],
    [145, "SH5   ", false, 0.16529, 0.09642,       0,       0, 0.13315,  750, 9999, 1600,    6, 15, 8000],
    [146, "SH6   ", false, 0.13315, 0.06657,       0,       0, 0.06428,  750, 9999, 1600,    2, 30, 8000],
    [147, "SH7   ", false,  0.1607, 0.24334, 0.10101,       0, 0.15611,  750, 9999, 1600,    6, 15, 8000],
    [148, "SH8   ", false, 0.09412, 0.15611, 0.03903,       0, 0.19972,  750, 9999, 1600,    3, 40, 8000],
    [149, "SH9   ", true , 0.20661, 0.11249,       0, 0.07117,  0.3214,  750, 1800, 1500,  4.4, 40, 8000],
    [161, "TU1   ", true , 0.00918, 0.04132, 0.06887, 0.00918, 0.04132, 2000, 1800, 1600,  0.6, 20, 8000],
    [162, "TU2   ", false, 0.04362, 0.08264, 0.05739,       0, 0.00918, 2000, 9999, 1600,    1, 30, 8000],
    [163, "TU3   ", true , 0.05051, 0.00689, 0.01148, 0.02984, 0.05051, 1800, 1600, 1400,  1.3, 30, 8000],
    [164, "TU4   ", false, 0.20661,       0,       0,       0, 0.09183, 2300, 9999, 2000,  0.5, 12, 8000],
    [165, "TU5   ", false, 0.18365, 0.18365, 0.13774,       0, 0.13774, 1500, 9999,  750,    1, 25, 8000],
    [181, "TL1   ", false, 0.04591, 0.10101, 0.16529,       0,       0, 2000, 9999, 9999,  0.2, 30, 8000],
    [182, "TL2   ", false, 0.06428,  0.1056, 0.10101,       0,       0, 2000, 9999, 9999,  0.2, 25, 8000],
    [183, "TL3   ", false, 0.02296, 0.10101, 0.12856,       0,       0, 2000, 9999, 9999,  0.3, 20, 8000],
    [184, "TL4   ", false, 0.02296, 0.06887, 0.19284,       0,       0, 2000, 9999, 9999,  0.4, 25, 8000],
    [185, "TL5   ", false,  0.0528, 0.11478, 0.20202,       0,       0, 2000, 9999, 1600,  0.6, 25, 8000],
    [186, "TL6   ", false, 0.11019,  0.0551,  0.0551,       0,       0, 2000, 9999, 9999,  0.3, 25, 8000],
    [187, "TL7   ", false, 0.01377, 0.06428,  0.3719,       0,       0, 2000, 9999, 9999,  0.4, 25, 8000],
    [188, "TL8   ", false,  0.2663, 0.06428, 0.05051,       0,       0, 1800, 9999, 9999,  0.3, 35, 8000],
    [189, "TL9   ", false, 0.30533, 0.15152, 0.19054,       0,       0, 1800, 9999, 1600,  0.6, 35, 8000],
  ];

  function buildFuelModels() {
    const out = {};
    for (const r of FUEL_ROWS) {
      out[r[0]] = {
        number: r[0], code: r[1].trim(), dynamic: r[2],
        w_1h: r[3], w_10h: r[4], w_100h: r[5], w_live_herb: r[6], w_live_woody: r[7],
        sav_1h: r[8], sav_live_herb: r[9], sav_live_woody: r[10],
        depth_ft: r[11], mx_dead: r[12] / 100.0, heat: r[13],
      };
    }
    return out;
  }
  const FUEL_MODELS = buildFuelModels();
  const DEFAULT_FUEL = 122; // GS2 grass-shrub: a lively, defensible global default for the demo

  function burnable(fm) {
    return [91, 92, 93, 98, 99].indexOf(fm.number) === -1 && (fm.w_1h + fm.w_live_herb) > 0;
  }

  // ── Offline land-cover → fuel crosswalk: ESA WorldCover (11-class) → Scott & Burgan fbfm40 ───────
  // Direct port of the tested online pipeline (fuel/crosswalk.py + providers/climate.py), so the
  // offline path reuses the SAME validated table. The bundled global WorldCover baseline
  // (ui/data/worldcover_biome.png, built by scripts/build_offline_fuel.py) supplies the class per
  // cell; the De Martonne aridity index (I=P/(T+10), from NASA POWER climatology) picks the climate
  // variant so the same cover burns differently dry vs wet. NB codes (91 urban, 92 snow, 98 water,
  // 99 bare) are absent from FUEL_MODELS → computeArrival treats them as fire breaks. This is what
  // makes offline fuel per-cell + real, instead of one global default.
  //   WorldCover: 10 tree, 20 shrub, 30 grass, 40 crop, 50 built, 60 bare, 70 snow, 80 water,
  //   90 herb-wetland, 95 mangrove, 100 moss; 0 = no data.
  const LC_XWALK = { 10: 162, 20: 142, 30: 101, 40: 101, 50: 91, 60: 99, 70: 92, 80: 98, 90: 101, 95: 142, 100: 101, 0: 99 };
  const LC_CLIMATE_XWALK = {
    10: { arid: 122, semiarid: 162, mediterranean: 183, humid: 186 },  // tree
    20: { arid: 145, semiarid: 142, mediterranean: 145, humid: 143 },  // shrub
    30: { arid: 102, semiarid: 101, mediterranean: 101, humid: 101 },  // grass
  };
  const LC_AMBIGUITY = { 10: 0.20, 20: 0.15, 30: 0.15, 40: 0.30, 50: 0, 60: 0, 70: 0, 80: 0, 90: 0.35, 95: 0.25, 100: 0.30, 0: 0 };
  const LC_BURNABLE = new Set([10, 20, 30, 40, 90, 95, 100]);

  function aridityClass(idx) {   // De Martonne class from index I = P/(T+10)
    if (idx == null || !isFinite(idx)) return null;
    if (idx < 10) return "arid";
    if (idx < 20) return "semiarid";
    if (idx < 30) return "mediterranean";
    return "humid";
  }

  function fuelForLandcover(lc, aridIdx) {
    const cls = aridityClass(aridIdx);
    const byClim = LC_CLIMATE_XWALK[lc];
    if (cls && byClim && byClim[cls] != null) return byClim[cls];
    return LC_XWALK[lc] != null ? LC_XWALK[lc] : 99;   // unknown class → barren/non-burnable
  }

  // Mean land-cover confidence weight (1.0 = unambiguous) — mirrors landcover_confidence_weight.
  function landcoverConfidence(lcGrid) {
    let burnable = 0, ambig = 0, total = 0;
    for (const row of lcGrid) {
      for (const lc of row) {
        total++;
        if (LC_BURNABLE.has(lc)) burnable++;
        if (LC_AMBIGUITY[lc] != null) ambig += LC_AMBIGUITY[lc];
      }
    }
    if (burnable === 0 || total === 0) return 1.0;
    return 1.0 - ambig / total;
  }

  // ── Rothermel (1972) surface ROS — port of engine/offline/rothermel.py ───────────────────────
  const RHO_P = 32.0, S_T = 0.0555, ETA_S = 0.4174;
  const SAV_10H = 109.0, SAV_100H = 30.0;
  const MS_TO_FTMIN = 196.850393700787, FT_TO_M = 0.3048;

  function moistureDamping(mf, mx) {
    if (mx <= 0) return 0.0;
    const r = Math.min(mf / mx, 1.0);
    return 1.0 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r;
  }

  // Returns {ros_m_min, eff_wind_ms, phi_w, phi_s}
  function spreadRate(fm, m, windMs, slopeFrac) {
    if (!burnable(fm) || fm.depth_ft <= 0) return { ros_m_min: 0, eff_wind_ms: 0, phi_w: 0, phi_s: 0 };

    let w_1h = fm.w_1h, w_live_herb = fm.w_live_herb;
    if (fm.dynamic && fm.w_live_herb > 0) {
      const cured = Math.min(Math.max(1.333 - 1.11 * m.m_live_herb, 0.0), 1.0);
      w_1h = fm.w_1h + cured * fm.w_live_herb;
      w_live_herb = fm.w_live_herb * (1.0 - cured);
    }

    // (load, sav, moisture, category) — 0 dead, 1 live
    let parts = [
      [w_1h, fm.sav_1h, m.m_1h, 0],
      [fm.w_10h, SAV_10H, m.m_10h, 0],
      [fm.w_100h, SAV_100H, m.m_100h, 0],
      [w_live_herb, fm.sav_live_herb, m.m_live_herb, 1],
      [fm.w_live_woody, fm.sav_live_woody, m.m_live_woody, 1],
    ].filter((p) => p[0] > 0 && p[1] > 0);

    const a = parts.map((p) => (p[1] * p[0]) / RHO_P);
    let a_dead = 0, a_live = 0;
    parts.forEach((p, i) => { if (p[3] === 0) a_dead += a[i]; else a_live += a[i]; });
    const a_t = a_dead + a_live;
    if (a_t <= 0) return { ros_m_min: 0, eff_wind_ms: 0, phi_w: 0, phi_s: 0 };
    const f_dead = a_dead / a_t, f_live = a_live / a_t;

    const fij = (i) => {
      const catA = parts[i][3] === 0 ? a_dead : a_live;
      return catA > 0 ? a[i] / catA : 0.0;
    };

    let sigma = 0.0;
    parts.forEach((p, i) => { sigma += (p[3] === 0 ? f_dead : f_live) * fij(i) * p[1]; });
    if (sigma <= 0) return { ros_m_min: 0, eff_wind_ms: 0, phi_w: 0, phi_s: 0 };

    let wn_dead = 0, wn_live = 0, mf_dead = 0, mf_live = 0;
    parts.forEach((p, i) => {
      if (p[3] === 0) { wn_dead += fij(i) * p[0]; mf_dead += fij(i) * p[2]; }
      else { wn_live += fij(i) * p[0]; mf_live += fij(i) * p[2]; }
    });
    wn_dead *= (1 - S_T); wn_live *= (1 - S_T);

    let mx_live = fm.mx_dead;
    if (a_live > 0 && wn_live > 0) {
      let dead_fine = 0, live_fine = 0, mf_dead_fine_num = 0;
      parts.forEach((p) => {
        if (p[3] === 0) { const e = Math.exp(-138.0 / p[1]); dead_fine += p[0] * e; mf_dead_fine_num += p[0] * p[2] * e; }
        else { live_fine += p[0] * Math.exp(-500.0 / p[1]); }
      });
      const w_ratio = live_fine > 0 ? dead_fine / live_fine : 0.0;
      const mf_dead_fine = dead_fine > 0 ? mf_dead_fine_num / dead_fine : 0.0;
      mx_live = Math.max(2.9 * w_ratio * (1.0 - mf_dead_fine / fm.mx_dead) - 0.226, fm.mx_dead);
    }

    let loadSum = 0; parts.forEach((p) => { loadSum += p[0]; });
    const beta = (loadSum / fm.depth_ft) / RHO_P;
    const beta_op = 3.348 * Math.pow(sigma, -0.8189);
    const a_exp = 133.0 * Math.pow(sigma, -0.7913);
    const gamma_max = Math.pow(sigma, 1.5) / (495.0 + 0.0594 * Math.pow(sigma, 1.5));
    const gamma = gamma_max * Math.pow(beta / beta_op, a_exp) * Math.exp(a_exp * (1.0 - beta / beta_op));
    const eta_m = wn_dead * moistureDamping(mf_dead, fm.mx_dead) + wn_live * moistureDamping(mf_live, mx_live);
    const i_r = gamma * fm.heat * eta_m * ETA_S;

    const xi = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192.0 + 0.2595 * sigma);

    let q_ig = 0.0;
    parts.forEach((p, i) => {
      q_ig += (p[3] === 0 ? f_dead : f_live) * fij(i) * Math.exp(-138.0 / p[1]) * (250.0 + 1116.0 * p[2]);
    });
    const rho_b = loadSum / fm.depth_ft;
    const heat_sink = rho_b * q_ig;
    if (heat_sink <= 0) return { ros_m_min: 0, eff_wind_ms: 0, phi_w: 0, phi_s: 0 };

    const r0 = (i_r * xi) / heat_sink; // ft/min, no wind/slope

    const u_ftmin = Math.max(windMs, 0.0) * MS_TO_FTMIN;
    const c = 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55));
    const b = 0.02526 * Math.pow(sigma, 0.54);
    const e = 0.715 * Math.exp(-3.59e-4 * sigma);
    const phi_w = u_ftmin > 0 ? c * Math.pow(u_ftmin, b) * Math.pow(beta / beta_op, -e) : 0.0;
    const phi_s = 5.275 * Math.pow(beta, -0.3) * Math.pow(Math.max(slopeFrac, 0.0), 2);

    const ros_ftmin = r0 * (1.0 + phi_w + phi_s);

    const phi_e = phi_w + phi_s;
    let eff_ms = 0.0;
    if (phi_e > 0 && c > 0) {
      const eff_ftmin = Math.pow(phi_e / (c * Math.pow(beta / beta_op, -e)), 1.0 / b);
      eff_ms = eff_ftmin / MS_TO_FTMIN;
    }
    // Byram fireline intensity + flame length (head): t_r = 384/σ; I_B[BTU/ft/s] = I_R·R·t_r/60;
    // ×3.4613 → kW/m; flame length = 0.0775·I^0.46 (Byram 1959). Matches engine/offline/rothermel.py.
    const residence = sigma > 0 ? 384.0 / sigma : 0.0;
    const ibKwm = (i_r * ros_ftmin * residence / 60.0) * 3.4613;
    const flameM = ibKwm > 0 ? 0.0775 * Math.pow(ibKwm, 0.46) : 0.0;
    return { ros_m_min: ros_ftmin * FT_TO_M, eff_wind_ms: eff_ms, phi_w: phi_w, phi_s: phi_s,
             fireline_intensity_kwm: ibKwm, flame_length_m: flameM };
  }

  // ── Dead-fuel moisture from weather — port of engine/moisture.py ─────────────────────────────
  function emc(tempC, rh) {
    rh = Math.max(0.0, Math.min(100.0, rh));
    const tF = (tempC * 9.0) / 5.0 + 32.0;
    if (rh < 10.0) return 0.03229 + 0.281073 * rh - 0.000578 * rh * tF;
    if (rh < 50.0) return 2.22749 + 0.160107 * rh - 0.014784 * tF;
    return 21.0606 + 0.005565 * rh * rh - 0.00035 * rh * tF - 0.483199 * rh;
  }
  const clampM = (v) => Math.max(1.0, Math.min(40.0, v));
  function deadFuelMoisture(tempC, rh) {
    const e = emc(tempC, rh);
    return [clampM(e), clampM(e + 1.0), clampM(e + 2.0)]; // percent
  }
  const LIVE_HERB_M = 0.70, LIVE_WOODY_M = 0.90;

  // ── First-order crown fire — mirror of engine/offline/spread.py (dual-source) ────────────────
  // Canopied (timber) codes; Van Wagner (1977) crowning threshold with stated defaults (canopy
  // base 3 m, foliar moisture 100 %); Rothermel (1991) crown ROS = 3.34 × R(FM10) at midflame.
  const TIMBER_CODES = new Set([161, 162, 163, 164, 165, 181, 182, 183, 184, 185, 186, 187, 188, 189]);
  const CROWN_CBH_M = 3.0, CROWN_FMC_PCT = 100.0;
  const CROWN_I0_KWM = Math.pow(0.010 * CROWN_CBH_M * (460.0 + 25.9 * CROWN_FMC_PCT), 1.5);
  const CROWN_ROS_FACTOR = 3.34;

  function crownRosMMin(fuelModels, moist, wind20Ms, slopeFrac) {
    const fm10 = fuelModels[10];
    if (!fm10) return 0.0;
    const windMid = wind20Ms * midflameWaf(fm10.depth_ft);
    const res = spreadRate(fm10, moist, windMid, slopeFrac);
    return CROWN_ROS_FACTOR * res.ros_m_min;
  }

  // ── Ellipse + directional spread — port of engine/offline/spread.py ──────────────────────────
  const NEIGHBORS = [
    [-1, 0, 1.0], [1, 0, 1.0], [0, -1, 1.0], [0, 1, 1.0],
    [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
  ];

  function lengthWidthRatio(effWindMs) {
    const uMph = Math.max(effWindMs, 0.0) * 2.2369362920544;
    const lw = 0.936 * Math.exp(0.2566 * uMph) + 0.461 * Math.exp(-0.1548 * uMph) - 0.397;
    return Math.min(Math.max(lw, 1.0), 8.0);
  }
  function midflameWaf(depthFt) {
    if (depthFt <= 0) return 0.4;
    return Math.min(Math.max(1.83 / Math.log((20.0 + 0.36 * depthFt) / (0.13 * depthFt)), 0.1), 1.0);
  }

  // Head ROS (m/min), heading bearing (deg), eccentricity, crowned flag for one cell.
  function cellHead(fm, slopeFrac, aspectDeg, wind20ftMs, windToBearing, moist, fuelModels) {
    const windMs = wind20ftMs * midflameWaf(fm.depth_ft);
    const res = spreadRate(fm, moist, windMs, slopeFrac);
    if (res.ros_m_min <= 0) return [0.0, 0.0, 0.0, false];
    let ros = res.ros_m_min;
    let crowned = false;
    if (fuelModels && TIMBER_CODES.has(fm.number) && (res.fireline_intensity_kwm || 0) >= CROWN_I0_KWM) {
      ros = Math.max(ros, crownRosMMin(fuelModels, moist, wind20ftMs, slopeFrac));
      crowned = true;
    }
    const upslope = (aspectDeg + 180.0) % 360.0;
    const wx = res.phi_w * Math.sin(rad(windToBearing));
    const wy = res.phi_w * Math.cos(rad(windToBearing));
    const sx = res.phi_s * Math.sin(rad(upslope));
    const sy = res.phi_s * Math.cos(rad(upslope));
    let heading;
    if (Math.abs(wx + sx) < 1e-9 && Math.abs(wy + sy) < 1e-9) heading = windToBearing;
    else heading = (deg(Math.atan2(wx + sx, wy + sy)) + 360.0) % 360.0;
    const lw = lengthWidthRatio(res.eff_wind_ms);
    const ecc = lw > 1.0 ? Math.sqrt(lw * lw - 1.0) / lw : 0.0;
    return [ros, heading, ecc, crowned];
  }

  const rad = (d) => (d * Math.PI) / 180.0;
  const deg = (r) => (r * 180.0) / Math.PI;

  // Minimal binary min-heap over [time, row, col].
  function Heap() { this.a = []; }
  Heap.prototype.push = function (x) {
    const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  };
  Heap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; const n = a.length;
      for (;;) { let l = 2 * i + 1, r = l + 1, s = i;
        if (l < n && a[l][0] < a[s][0]) s = l; if (r < n && a[r][0] < a[s][0]) s = r;
        if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } }
    return top;
  };
  Heap.prototype.size = function () { return this.a.length; };

  // Returns Float64Array arrival (seconds; Infinity where unreached). crownOut, when given,
  // receives {cells: N} — crowned cells the fire actually reached (mirrors compute_arrival).
  function computeArrival(fbfm, slopeDeg, aspectDeg, fuelModels, ignRC, cellM, windMs, windDirDeg, moisture, tstopS, rosMult, crownOut) {
    rosMult = rosMult == null ? 1.0 : rosMult;
    const rows = fbfm.length, cols = fbfm[0].length;
    const windTo = (windDirDeg + 180.0) % 360.0;

    const ros = new Float64Array(rows * cols);
    const head = new Float64Array(rows * cols);
    const ecc = new Float64Array(rows * cols);
    const crowned = new Uint8Array(rows * cols);
    const cache = new Map();
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const code = fbfm[r][cc] | 0;
        const fm = fuelModels[code];
        if (!fm) continue;
        const slopeFrac = Math.tan(rad(slopeDeg[r][cc]));
        const key = code + "|" + slopeFrac.toFixed(3) + "|" + (Math.floor(aspectDeg[r][cc] / 5));
        let v = cache.get(key);
        if (!v) { v = cellHead(fm, slopeFrac, aspectDeg[r][cc], windMs, windTo, moisture, fuelModels); cache.set(key, v); }
        const idx = r * cols + cc;
        ros[idx] = (v[0] * rosMult) / 60.0; // m/min -> m/s
        head[idx] = v[1];
        ecc[idx] = v[2];
        crowned[idx] = v[3] ? 1 : 0;
      }
    }

    const arrival = new Float64Array(rows * cols).fill(Infinity);
    const [r0, c0] = ignRC;
    if (!(r0 >= 0 && r0 < rows && c0 >= 0 && c0 < cols)) return arrival.fill(NaN);
    arrival[r0 * cols + c0] = 0.0;
    const pq = new Heap(); pq.push([0.0, r0, c0]);

    while (pq.size()) {
      const [t, r, cc] = pq.pop();
      const here = r * cols + cc;
      if (t > arrival[here] || t > tstopS) continue;
      const rate = ros[here], heading = head[here], e = ecc[here];
      if (rate <= 0) continue;
      for (const [dr, dc, distCells] of NEIGHBORS) {
        const nr = r + dr, nc = cc + dc;
        if (!(nr >= 0 && nr < rows && nc >= 0 && nc < cols)) continue;
        const ni = nr * cols + nc;
        if (ros[ni] <= 0) continue;   // non-burnable target (water/urban/bare) = firebreak; fire can't enter
        const bearing = (deg(Math.atan2(dc, -dr)) + 360.0) % 360.0;
        const cosA = Math.cos(rad(bearing - heading));
        const dirRate = e > 0 ? (rate * (1.0 - e)) / (1.0 - e * cosA) : rate;
        if (dirRate <= 0) continue;
        const nt = t + (distCells * cellM) / dirRate;
        if (nt < arrival[ni] && nt <= tstopS) { arrival[ni] = nt; pq.push([nt, nr, nc]); }
      }
    }
    if (crownOut) {
      let n = 0;
      for (let i = 0; i < arrival.length; i++) if (crowned[i] && isFinite(arrival[i])) n++;
      crownOut.cells = n;
    }
    return arrival;
  }

  // ── Sectorization — port of sectorizer/sectorize.py ──────────────────────────────────────────
  const SECTOR_NAMES = { 1: "head", 2: "right_flank", 3: "left_flank", 4: "rear" };

  function circularMeanDeg(bearings) {
    let sx = 0, sy = 0;
    for (const b of bearings) { sx += Math.sin(rad(b)); sy += Math.cos(rad(b)); }
    return (deg(Math.atan2(sx / bearings.length, sy / bearings.length)) + 360.0) % 360.0;
  }

  // Sector areas/bearings are computed on the LIKELY footprint (burn probability >= minProb) so they
  // stay consistent with the reported fire size (a per-member median), not the much larger union of
  // every member's fringe. Returns {labels, sectors, head_bearing_deg}.
  function sectorize(arrival, prob, rows, cols, ignRC, cellM, windFromDeg, minProb) {
    minProb = minProb == null ? 0.5 : minProb;
    const headBearing = (windFromDeg + 180.0) % 360.0;
    const labels = new Int8Array(rows * cols);
    const cellBearing = new Float64Array(rows * cols);
    const [r0, c0] = ignRC;
    const buckets = { 1: [], 2: [], 3: [], 4: [] };
    let anyBurned = false;
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const idx = r * cols + cc;
        const t = arrival[idx];
        if (!(t > 0.0) || !isFinite(t) || prob[idx] < minProb) continue; // likely-burned cells only
        anyBurned = true;
        const dx = (cc - c0) * cellM;     // east (+) in metres
        const dy = (r0 - r) * cellM;      // north (+) in metres (row grows south)
        const cb = (deg(Math.atan2(dx, dy)) + 360.0) % 360.0;
        cellBearing[idx] = cb;
        let rel = ((cb - headBearing + 180.0) % 360.0) - 180.0;
        let code;
        if (Math.abs(rel) <= 45.0) code = 1;
        else if (rel > 45.0 && rel <= 135.0) code = 2;
        else if (rel < -45.0 && rel >= -135.0) code = 3;
        else code = 4;
        labels[idx] = code;
        buckets[code].push({ t: t, b: cb });
      }
    }
    if (!anyBurned) return { labels: labels, sectors: [], head_bearing_deg: null };
    const cellHa = (cellM * cellM) / 10000.0;
    const sectors = [];
    for (const code of [1, 2, 3, 4]) {
      const arr = buckets[code];
      if (!arr.length) continue;
      const times = arr.map((o) => o.t).sort((a, b) => a - b);
      const bearings = arr.map((o) => o.b);
      sectors.push({
        name: SECTOR_NAMES[code], code: code, cells: arr.length,
        area_ha: round(arr.length * cellHa, 3),
        bearing_deg: round(circularMeanDeg(bearings), 1),
        arrival_p50_s: round(median(times), 1),
        max_intensity_kwm: null, critical_cells: 0,
      });
    }
    const dominant = sectors.length ? sectors.reduce((a, b) => (b.area_ha > a.area_ha ? b : a)).name : null;
    return { labels: labels, sectors: sectors, head_bearing_deg: round(headBearing, 1), dominant: dominant };
  }

  // ── Command safety — port of command/safety.py ───────────────────────────────────────────────
  // Returns [alert, reasonEnglish, reasonKey, reasonMin]. The English prose keeps the API/back-compat
  // contract; reasonKey + reasonMin let the UI render the reason in the user's language (i18n), so a
  // Spanish user no longer sees an English reason under a Spanish grade.
  function alertFor(arrivalS, sector, warnS) {
    if (arrivalS != null && arrivalS <= warnS) {
      const m = Math.round(arrivalS / 60);
      return m <= 0 ? ["danger", "at the fire origin — the fire is here", "atOrigin", 0]
                    : ["danger", "fire arrives in ~" + m + " min", "arrivesIn", m];
    }
    if (sector === "head") return ["danger", "sits in the head — where the fire runs", "inHead", null];
    if (arrivalS != null && arrivalS <= 2 * warnS) { const m = Math.round(arrivalS / 60); return ["watch", "fire arrives in ~" + m + " min", "arrivesIn", m]; }
    if (sector === "right_flank" || sector === "left_flank") return ["watch", "sits on a " + sector.replace("_", " ") + " — the fire widens here", sector === "right_flank" ? "onFlankRight" : "onFlankLeft", null];
    if (sector === "rear") return ["safe", "behind the fire (backing, low intensity)", "rear", null];
    // In the predicted burn path, beyond the watch window and outside the sector wedges. A wildland
    // crew the fire is projected to reach is never "safe" (LCES doctrine) — grade watch with the
    // honest ETA. Only genuinely-outside resources and the low-intensity rear stay safe.
    if (arrivalS != null) { const m = Math.round(arrivalS / 60); return ["watch", "in the predicted path — fire reaches here in ~" + m + " min", "inPath", m]; }
    return ["safe", "outside the predicted footprint", "outside", null];
  }
  const SEVERITY = { safe: 0, watch: 1, danger: 2 };

  function assess(result, resources, warnS) {
    warnS = warnS || 1800.0;
    const g = result._grid;
    if (!g) return { worst_alert: "safe", resources: [] };
    const statuses = resources.map((res) => {
      // Locate the resource cell from its lat/lon via the same local frame the grid was built on.
      const dEast = (res.lon - g.lon) * g.mPerDegLon;
      const dNorth = (res.lat - g.lat) * g.mPerDegLat;
      const col = Math.round(g.c0 + dEast / g.cellM);
      const row = Math.round(g.r0 - dNorth / g.cellM);
      const inside = row >= 0 && row < g.rows && col >= 0 && col < g.cols;
      const idx = inside ? row * g.cols + col : -1;
      let arrivalS = null, sector = null;
      if (inside) {
        const t = g.arrival[idx];
        const atIgnition = row === g.r0 && col === g.c0;   // fire originates here → arrival 0
        arrivalS = atIgnition ? 0 : ((isFinite(t) && t > 0) ? t : null);
        const code = g.labels[idx];
        sector = code ? SECTOR_NAMES[code] : (atIgnition ? "head" : null);
      }
      const [alert, reason, reasonKey, reasonMin] = alertFor(arrivalS, sector, warnS);
      return { id: String(res.id || ""), lat: res.lat, lon: res.lon, in_footprint: arrivalS != null, arrival_s: arrivalS, sector: sector, alert: alert, reason: reason, reason_key: reasonKey, reason_min: reasonMin };
    });
    const worst = statuses.reduce((w, s) => (SEVERITY[s.alert] > SEVERITY[w] ? s.alert : w), "safe");
    return { worst_alert: worst, resources: statuses };
  }

  // ── Small helpers ────────────────────────────────────────────────────────────────────────────
  function round(v, n) { const f = Math.pow(10, n || 0); return Math.round(v * f) / f; }
  function median(sortedAsc) {
    const n = sortedAsc.length; if (!n) return NaN;
    const mid = n >> 1; return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
  }
  function percentile(values, q) {
    if (!values.length) return NaN;
    const a = values.slice().sort((x, y) => x - y);
    const rank = (q / 100) * (a.length - 1);
    const lo = Math.floor(rank), hi = Math.ceil(rank);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (rank - lo); // linear interpolation, matches numpy.percentile
  }
  function utmZoneEpsg(lat, lon) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    return (lat >= 0 ? 32600 : 32700) + zone;
  }

  // ── Data providers (best-effort, always degrade gracefully) ──────────────────────────────────
  async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? await r.json() : null; }
    catch (_) { return null; }
    finally { clearTimeout(to); }
  }

  const _MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  async function getWeather(lat, lon) {
    // 1) Live forecast (best — real current conditions).
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
      "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms";
    const j = await fetchWithTimeout(url, 3500);
    const c = j && j.current;
    if (c && c.wind_speed_10m != null) {
      return { windMs: c.wind_speed_10m, windDirDeg: c.wind_direction_10m, tempC: c.temperature_2m, rhPct: c.relative_humidity_2m, source: "open-meteo" };
    }
    // 2) NASA POWER 30-yr monthly climatology for this location + month (real, location-specific;
    // cached so a prepared region works with no network). Far better than one fixed global guess.
    try {
      const clim = await getClimate(lat, lon);
      const mon = _MONTHS[new Date().getUTCMonth()];
      const m = clim && clim.monthly;
      if (m && m.WS10M && m.WS10M[mon] != null) {
        return {
          windMs: m.WS10M[mon],
          windDirDeg: (m.WD10M && m.WD10M[mon] != null) ? m.WD10M[mon] : 270.0,
          tempC: m.T2M[mon], rhPct: m.RH2M[mon], source: "climatology",
        };
      }
    } catch (_) { /* fall through */ }
    // 3) Last resort: a moderate dry-season wind so the engine still runs with zero data.
    return { windMs: 5.0, windDirDeg: 270.0, tempC: 25.0, rhPct: 30.0, source: "fallback" };
  }

  // Coarse elevation grid -> per-cell slope/aspect. Flat fallback on any failure.
  async function getTerrain(lat, lon, rows, cols, cellM, mPerDegLat, mPerDegLon, r0, c0) {
    const slope = mkGrid(rows, cols, 0), aspect = mkGrid(rows, cols, 0);
    const N = 10; // 10x10 = 100 sample points (Open-Meteo elevation cap)
    const lats = [], lons = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const gr = (i / (N - 1)) * (rows - 1), gc = (j / (N - 1)) * (cols - 1);
        lats.push(lat + ((r0 - gr) * cellM) / mPerDegLat);
        lons.push(lon + ((gc - c0) * cellM) / mPerDegLon);
      }
    }
    // Cache the elevation samples so a region visited online keeps real slope offline (no network).
    const key = "ignea_elev_" + lat.toFixed(3) + "_" + lon.toFixed(3) + "_" + Math.round(cellM) + "_" + N;
    let elev = null, source = "open-meteo";
    try { const s = localStorage.getItem(key); if (s) { elev = JSON.parse(s); source = "cached"; } } catch (_) { /* no storage */ }
    if (!elev) {
      const url = "https://api.open-meteo.com/v1/elevation?latitude=" + lats.map((v) => v.toFixed(4)).join(",") +
        "&longitude=" + lons.map((v) => v.toFixed(4)).join(",");
      const j = await fetchWithTimeout(url, 3500);
      if (j && j.elevation && j.elevation.length === N * N) {
        elev = j.elevation;
        try { localStorage.setItem(key, JSON.stringify(elev)); } catch (_) { /* quota/none */ }
      }
    }
    if (!elev) return { slope, aspect, source: "flat", isWater: false };
    // Every sample at/below sea level → open water (Open-Meteo's DEM returns 0 over sea). Avoids
    // drawing a fire on the ocean when someone taps the sea.
    const isWater = elev.every((e) => e <= 0);
    const coarseM = ((rows - 1) * cellM) / (N - 1); // metres between coarse samples
    // Slope/aspect on the coarse grid, then nearest-sample to the fine grid.
    const cs = mkGrid(N, N, 0), ca = mkGrid(N, N, 0);
    for (let i = 0; i < N; i++) {
      for (let jx = 0; jx < N; jx++) {
        const up = elev[Math.max(i - 1, 0) * N + jx], dn = elev[Math.min(i + 1, N - 1) * N + jx];
        const lf = elev[i * N + Math.max(jx - 1, 0)], rt = elev[i * N + Math.min(jx + 1, N - 1)];
        const dzdy = (up - dn) / (2 * coarseM); // north gradient (i grows south → up is north)
        const dzdx = (rt - lf) / (2 * coarseM); // east gradient
        cs[i][jx] = deg(Math.atan(Math.hypot(dzdx, dzdy)));
        ca[i][jx] = (deg(Math.atan2(-dzdx, -dzdy)) + 360.0) % 360.0; // downslope azimuth
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const i = Math.min(N - 1, Math.round((r / (rows - 1)) * (N - 1)));
        const jx = Math.min(N - 1, Math.round((cc / (cols - 1)) * (N - 1)));
        slope[r][cc] = cs[i][jx]; aspect[r][cc] = ca[i][jx];
      }
    }
    return { slope, aspect, source: source, isWater };
  }

  // Per-cell fuel data source (land cover + aridity). Returns an object with a geographic
  // `sample(lat, lon) → ESA WorldCover class` plus `aridity`, `source`, `confidence`, `resolution_m`,
  // or null when no data is available (→ honest uniform default). Tiers, best available first:
  //   1. a cached/prepared-region WorldCover tile (per-cell, highest confidence), then
  //   2. the bundled coarse global biome + aridity baseline (works fully offline, biome-correct).
  // opts.fuelData can inject a source directly (prepared-region pack / tests).
  // Never blocks on the network. If OSM fine fuel for this region is already cached (memory or
  // localStorage), use it (instant, per-cell mosaic). Otherwise return the bundled baseline NOW and
  // prefetch OSM in the background so the NEXT tap in this region is high-res — keeps the app "avión"
  // fast while still reaching per-cell fuel once a region is prepared (online). opts.fuelData injects
  // a source directly (tests / a prepared pack); opts.awaitOsm forces the blocking OSM path (tests).
  async function getFuelData(lat, lon, opts) {
    opts = opts || {};
    if (!opts.noOsm) {
      const key = _osmKey(lat, lon);
      let reg = _osmCache[key];
      if (reg === undefined) {
        try { const s = localStorage.getItem(key); if (s) { reg = _decodeOSMRegion(s); _osmCache[key] = reg; } } catch (_) { /* none */ }
      }
      if (reg && reg.grid) return await _osmProvider(reg, lat, lon);
      if (reg === undefined) {
        if (opts.awaitOsm) { const built = await _prefetchOSM(lat, lon); if (built && built.grid) return await _osmProvider(built, lat, lon); }
        else if (!_osmAttempt[key] || Date.now() - _osmAttempt[key] > 30000) _prefetchOSM(lat, lon);  // fire-and-forget; cooldown-throttled retry
      }
    }
    return await fuelFromGlobalBaseline(lat, lon, opts);
  }

  function _osmKey(lat, lon) { return "ignea_osm_" + lat.toFixed(1) + "_" + lon.toFixed(1); }

  async function _osmProvider(reg, lat, lon) {
    await loadBiome();                                 // baseline fills cells with no OSM feature
    const clim = await getClimate(lat, lon);
    return {
      sample: (la, lo) => {
        const c = Math.floor((lo - reg.xmin) / reg.res), r = Math.floor((reg.ymax - la) / reg.res);
        const v = (c >= 0 && c < reg.W && r >= 0 && r < reg.H) ? reg.grid[r * reg.W + c] : 0;
        return v || (_biomePix ? sampleBiome(la, lo) : 0);
      },
      aridity: clim ? clim.aridity : null,
      source: "osm", confidence: 0.78, resolution_m: Math.round(_OSM_RES * 111320),
    };
  }

  const _osmInflight = {}, _osmAttempt = {};
  async function _prefetchOSM(lat, lon) {
    const key = _osmKey(lat, lon);
    if (_osmInflight[key]) return _osmInflight[key];
    _osmAttempt[key] = Date.now();
    const p = (async () => {
      let reg = null;
      try { reg = await _fetchOSMRegion(lat, lon); } catch (_) { reg = null; }  // fetch/rasterise error
      if (reg && reg.grid) {
        _osmCache[key] = reg;
        try { localStorage.setItem(key, _encodeOSMRegion(reg)); } catch (_) { /* quota */ }
      } else if (reg && reg.empty) {
        _osmCache[key] = false;                        // genuinely no OSM here → don't refetch
      }                                                // else (network fail) → leave undefined; retry after cooldown
      delete _osmInflight[key];
      return reg;
    })();
    _osmInflight[key] = p;
    return p;
  }

  // Tier 1 — OpenStreetMap landuse/natural (real vector land use at parcel resolution, CORS-enabled,
  // cacheable → offline). It is rasterised ONCE per region to a fine grid (fast O(1) sampling after),
  // and cells with no OSM feature fall back to the bundled WorldCover baseline. This is the per-cell
  // fuel mosaic the coarse baseline lacks — best exactly where crews deploy (the wildland-urban
  // interface, which OSM maps well). OSM tag → ESA WorldCover class, then the same crosswalk.
  const OSM_TO_WC = {
    forest: 10, wood: 10, scrub: 20, heath: 20, shrubbery: 20, meadow: 30, grass: 30, grassland: 30,
    village_green: 30, farmland: 40, orchard: 40, vineyard: 40, plant_nursery: 40, greenhouse_horticulture: 40,
    residential: 50, industrial: 50, commercial: 50, retail: 50, quarry: 60, bare_rock: 60, scree: 60,
    sand: 60, shingle: 60, glacier: 70, water: 80, reservoir: 80, basin: 80, wetland: 90,
  };
  const _osmCache = {};    // regionKey → { grid:Uint8Array, W,H, xmin,ymax,res } or false (none)
  const _OSM_HALF = 0.085; // half-extent of the fetched region (deg, ~9 km) — covers a typical fire
  const _OSM_RES = 0.0015; // rasterisation cell (~165 m) — the effective offline fuel resolution here
  const _OSM_MAX_NODES = 80; // subsample big rings so rasterisation never blocks the main thread

  function _pip(la, lo, ring) {   // ray-cast point-in-polygon; ring = [[lat,lon],…]
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  async function _fetchOSMRegion(lat, lon) {
    const s = lat - _OSM_HALF, n = lat + _OSM_HALF, w = lon - _OSM_HALF, e = lon + _OSM_HALF;
    const q = "[out:json][timeout:20];("
      + `way["landuse"~"^(forest|farmland|meadow|orchard|vineyard|grass|village_green|plant_nursery|greenhouse_horticulture|residential|industrial|commercial|retail|reservoir|basin|quarry)$"](${s},${w},${n},${e});`
      + `way["natural"~"^(wood|scrub|heath|grassland|shrubbery|water|wetland|bare_rock|scree|sand|shingle|glacier)$"](${s},${w},${n},${e});`
      + ");out geom 1200;";
    let data = null;
    for (const ep of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
      const j = await fetchWithTimeout2(ep, q, 9000);
      if (j) { data = j; break; }
    }
    if (!data) return null;                       // fetch failed (network/timeout) → caller may retry
    if (!data.elements || !data.elements.length) return { empty: true };  // no OSM here → don't retry
    // Build polygons (class + ring + bbox + area) and sort large→small so small/specific features
    // are rasterised last and win on overlap.
    const polys = [];
    for (const el of data.elements) {
      if (!el.geometry || el.geometry.length < 3) continue;
      const tg = el.tags || {};
      const key = tg.landuse || tg.natural;
      const cls = OSM_TO_WC[key];
      if (cls == null) continue;
      let ring = el.geometry.map((p) => [p.lat, p.lon]);
      if (ring.length > _OSM_MAX_NODES) {   // subsample huge rings — keeps PIP off the main-thread budget
        const step = ring.length / _OSM_MAX_NODES, simp = [];
        for (let i = 0; i < ring.length; i += step) simp.push(ring[Math.floor(i)]);
        ring = simp;
      }
      let mnLa = 90, mxLa = -90, mnLo = 180, mxLo = -180;
      for (const [la, lo] of ring) { if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la; if (lo < mnLo) mnLo = lo; if (lo > mxLo) mxLo = lo; }
      polys.push({ cls, ring, bbox: [mnLa, mnLo, mxLa, mxLo], area: (mxLa - mnLa) * (mxLo - mnLo) });
    }
    if (!polys.length) return { empty: true };   // fetched OK but no fuel-relevant features here
    polys.sort((a, b) => b.area - a.area);
    // Rasterise to a fixed regional grid: for each polygon, fill only the cells inside its bbox.
    const xmin = w, ymax = n, res = _OSM_RES;
    const W = Math.ceil((e - w) / res), H = Math.ceil((n - s) / res);
    const grid = new Uint8Array(W * H);   // 0 = no OSM feature (→ baseline fallback)
    for (const p of polys) {
      const c0 = Math.max(0, Math.floor((p.bbox[1] - xmin) / res));
      const c1 = Math.min(W - 1, Math.ceil((p.bbox[3] - xmin) / res));
      const r0 = Math.max(0, Math.floor((ymax - p.bbox[2]) / res));
      const r1 = Math.min(H - 1, Math.ceil((ymax - p.bbox[0]) / res));
      for (let r = r0; r <= r1; r++) {
        const la = ymax - (r + 0.5) * res;
        for (let c = c0; c <= c1; c++) {
          const lo = xmin + (c + 0.5) * res;
          if (_pip(la, lo, p.ring)) grid[r * W + c] = p.cls;
        }
      }
    }
    return { grid, W, H, xmin, ymax, res };
  }

  // Compact localStorage codec for a rasterised region (run-length on the class grid).
  function _encodeOSMRegion(reg) {
    const rle = [];
    let prev = reg.grid[0], run = 0;
    for (let i = 0; i < reg.grid.length; i++) { if (reg.grid[i] === prev && run < 65535) run++; else { rle.push(prev, run); prev = reg.grid[i]; run = 1; } }
    rle.push(prev, run);
    return JSON.stringify({ W: reg.W, H: reg.H, xmin: reg.xmin, ymax: reg.ymax, res: reg.res, rle });
  }
  function _decodeOSMRegion(s) {
    const o = JSON.parse(s);
    const grid = new Uint8Array(o.W * o.H);
    let i = 0;
    for (let k = 0; k < o.rle.length; k += 2) { const val = o.rle[k], run = o.rle[k + 1]; for (let j = 0; j < run; j++) grid[i++] = val; }
    return { grid, W: o.W, H: o.H, xmin: o.xmin, ymax: o.ymax, res: o.res };
  }
  // POST-body fetch with timeout (Overpass) — returns parsed JSON or null. All Overpass traffic
  // (this OSM fuel prefetch AND the UI's exposure query) is SERIALISED through one shared gate:
  // the public API allows ~2 concurrent slots per IP, so our own parallel requests queued each
  // other server-side until the client aborted (self-inflicted timeout, found live 2026-07-17).
  async function fetchWithTimeout2(url, body, ms) {
    const run = async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), ms);
      try { const r = await fetch(url, { method: "POST", body: body, signal: ctrl.signal }); return r.ok ? await r.json() : null; }
      catch (_) { return null; }
      finally { clearTimeout(to); }
    };
    const next = (window._ovpGate || Promise.resolve()).catch(() => null).then(run);
    window._ovpGate = next;
    return next;
  }

  // Tier 2 — the bundled global WorldCover baseline (ui/data/worldcover_biome.png). Works fully
  // offline: decode the PNG once via canvas, sample the WorldCover class per lat/lon. Aridity comes
  // from NASA POWER climatology (cached) so the crosswalk picks the right climate variant.
  let _biomePix = null, _biomeMeta = null;   // null = untried; false = unavailable
  // Decode the grayscale PNG WITHOUT a canvas: browser canvases apply colour management that mangles
  // the raw byte values (a class 60 was read back as 180), so we parse the PNG (IDAT → native
  // DecompressionStream inflate → un-filter) to recover the exact WorldCover class per pixel.
  async function _inflate(bytes) {
    const ds = new DecompressionStream("deflate");   // PNG IDAT is zlib (RFC 1950) = "deflate"
    const ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(ab);
  }
  function _unfilterGray(inf, W, H) {
    const out = new Uint8Array(W * H);
    let ip = 0;
    for (let r = 0; r < H; r++) {
      const ft = inf[ip++];
      for (let c = 0; c < W; c++) {
        const x = inf[ip++];
        const a = c > 0 ? out[r * W + c - 1] : 0;                 // left
        const b = r > 0 ? out[(r - 1) * W + c] : 0;               // up
        const cc = (r > 0 && c > 0) ? out[(r - 1) * W + c - 1] : 0; // up-left
        let v;
        if (ft === 1) v = x + a;
        else if (ft === 2) v = x + b;
        else if (ft === 3) v = x + ((a + b) >> 1);
        else if (ft === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); }
        else v = x;   // filter 0 (None) — what our build script writes
        out[r * W + c] = v & 0xff;
      }
    }
    return out;
  }
  async function loadBiome() {
    if (_biomePix === false) return false;
    if (_biomePix) return true;
    try {
      _biomeMeta = await (await fetch("data/worldcover_biome.json")).json();
      const buf = new Uint8Array(await (await fetch("data/worldcover_biome.png")).arrayBuffer());
      const dv = new DataView(buf.buffer);
      let pos = 8;                                   // skip the 8-byte PNG signature
      const idat = [];
      while (pos < buf.length) {
        const len = dv.getUint32(pos);
        const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
        if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
        pos += 12 + len;                             // length + type + data + CRC
      }
      let total = 0; for (const c of idat) total += c.length;
      const merged = new Uint8Array(total); let off = 0;
      for (const c of idat) { merged.set(c, off); off += c.length; }
      _biomePix = _unfilterGray(await _inflate(merged), _biomeMeta.width, _biomeMeta.height);
      return true;
    } catch (_) { _biomePix = false; return false; }
  }
  function sampleBiome(lat, lon) {
    const m = _biomeMeta;
    const col = Math.floor((lon - m.xmin) / m.xres);
    const row = Math.floor((lat - m.ymax) / m.yres);   // yres is negative
    if (col < 0 || col >= m.width || row < 0 || row >= m.height) return 0;
    return _biomePix[row * m.width + col];              // exact WorldCover class
  }
  async function fuelFromGlobalBaseline(lat, lon /* , opts */) {
    if (!(await loadBiome())) return null;
    const clim = await getClimate(lat, lon);
    return {
      sample: (la, lo) => sampleBiome(la, lo),
      aridity: clim ? clim.aridity : null,
      source: "worldcover-global",
      confidence: 0.6,   // biome-correct but coarse (~11 km) + unresolved intra-cell variation
      resolution_m: Math.round((_biomeMeta.res_deg || 0.1) * 111320),
    };
  }

  // NASA POWER 30-yr monthly climatology (CORS-enabled, free) → De Martonne aridity index + a
  // per-month weather fallback. Cached in localStorage so a region prepared online works offline.
  const _climCache = {};
  async function getClimate(lat, lon) {
    const key = "ignea_clim_" + lat.toFixed(1) + "_" + lon.toFixed(1);
    if (_climCache[key]) return _climCache[key];
    try { const s = localStorage.getItem(key); if (s) { _climCache[key] = JSON.parse(s); return _climCache[key]; } } catch (_) { /* no localStorage */ }
    try {
      const u = "https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M,PRECTOTCORR,WS10M,WD10M,RH2M&community=RE&longitude=" +
        lon.toFixed(3) + "&latitude=" + lat.toFixed(3) + "&format=JSON";
      const j = await fetchWithTimeout(u, 4000);
      const p = j && j.properties && j.properties.parameter;
      if (!p || !p.T2M) return null;
      const tAnn = p.T2M.ANN;                         // mean annual temp °C
      const pAnn = (p.PRECTOTCORR.ANN || 0) * 365.0;  // mm/day → annual total (approx)
      const clim = { aridity: pAnn / (tAnn + 10.0), monthly: { WS10M: p.WS10M, WD10M: p.WD10M, T2M: p.T2M, RH2M: p.RH2M } };
      _climCache[key] = clim;
      try { localStorage.setItem(key, JSON.stringify(clim)); } catch (_) { /* quota/none */ }
      return clim;
    } catch (_) { return null; }
  }

  function mkGrid(rows, cols, v) {
    const g = new Array(rows);
    for (let r = 0; r < rows; r++) { g[r] = new Array(cols).fill(v); }
    return g;
  }

  // ── Overlay rendering: grid -> canvas data URL ───────────────────────────────────────────────
  const BURN_STOPS = [ // probability -> rgba, matches the UI legend gradient
    [0.0, [255, 245, 160]], [0.25, [255, 214, 74]], [0.5, [255, 141, 41]],
    [0.75, [232, 63, 26]], [1.0, [152, 12, 12]],
  ];
  function burnColor(p) {
    for (let i = 1; i < BURN_STOPS.length; i++) {
      if (p <= BURN_STOPS[i][0]) {
        const [p0, c0] = BURN_STOPS[i - 1], [p1, c1] = BURN_STOPS[i];
        const f = (p - p0) / (p1 - p0 || 1);
        return [Math.round(c0[0] + (c1[0] - c0[0]) * f), Math.round(c0[1] + (c1[1] - c0[1]) * f), Math.round(c0[2] + (c1[2] - c0[2]) * f)];
      }
    }
    return BURN_STOPS[BURN_STOPS.length - 1][1];
  }
  const SECTOR_RGB = { 1: [255, 90, 43], 2: [255, 181, 71], 3: [255, 181, 71], 4: [63, 178, 127] };
  const SUPERSAMPLE = 8; // render each 120 m cell as an 8x8 block, then interpolate → smooth output

  // Light box blur of a scalar grid — rounds off the 8-neighbour Dijkstra "cross" artifact so the
  // rendered footprint reads as a smooth ellipse. Numeric outputs (maxP, sizes) use the RAW field.
  function blurField(field, rows, cols, passes) {
    let cur = field;
    for (let p = 0; p < passes; p++) {
      const out = new Float64Array(rows * cols);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        let sum = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) { sum += cur[nr * cols + nc]; n++; }
        }
        out[r * cols + c] = sum / n;
      }
      cur = out;
    }
    return cur;
  }

  // Alpha fade over the outer ~2 grid cells so a faint fringe that reaches the image boundary
  // dissolves instead of ending in a hard straight edge (the raw grid is a rectangle; without this
  // the alpha floor makes that rectangle's rim visible on a big fire).
  function edgeFeather(gx, gy, rows, cols) {
    const d = Math.min(gx + 0.5, gy + 0.5, cols - 0.5 - gx, rows - 0.5 - gy);
    return Math.max(0, Math.min(1, d / 2));
  }

  // Smooth heatmap from a scalar field via bilinear supersampling. colorFn(v) -> [r,g,b,a].
  function smoothScalarToDataUrl(rows, cols, field, colorFn) {
    const s = SUPERSAMPLE, W = cols * s, H = rows * s;
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const at = (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols) ? field[r * cols + c] : 0;
    for (let py = 0; py < H; py++) {
      const gy = (py + 0.5) / s - 0.5, ry = Math.floor(gy), fy = gy - ry;
      for (let px = 0; px < W; px++) {
        const gx = (px + 0.5) / s - 0.5, rx = Math.floor(gx), fx = gx - rx;
        const v = at(ry, rx) * (1 - fy) * (1 - fx) + at(ry + 1, rx) * fy * (1 - fx)
                + at(ry, rx + 1) * (1 - fy) * fx + at(ry + 1, rx + 1) * fy * fx;
        const rgba = colorFn(v), o = (py * W + px) * 4;
        img.data[o] = rgba[0]; img.data[o + 1] = rgba[1]; img.data[o + 2] = rgba[2];
        img.data[o + 3] = Math.round(rgba[3] * edgeFeather(gx, gy, rows, cols));
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  // Arrival-time isochrone bands — the "when does it get there" layer crews plan evacuations and
  // resource moves with. Time is bilinearly interpolated (smooth shapes), then DISCRETISED into
  // 1-hour bands (crisp boundaries); early arrival = hot colour (urgency), late = pale. Only the
  // likely footprint (burn probability >= minProb) is painted, so the bands match the reported
  // fire size, exactly like the sector wedges. Presentation-only (no physics → no Python mirror).
  const ISO_COLORS = [ // band index 0 = first hour … 5 = sixth hour
    [152, 12, 12], [219, 51, 26], [255, 141, 41], [255, 197, 66], [255, 232, 141], [255, 248, 205],
  ];
  function arrivalBandsToDataUrl(rows, cols, tField, pField, r0, c0, tstopS) {
    const s = SUPERSAMPLE, W = cols * s, H = rows * s;
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const atT = (r, c) => {
      if (!(r >= 0 && r < rows && c >= 0 && c < cols)) return Infinity;
      const v = tField[r * cols + c];
      return isFinite(v) ? v : Infinity;
    };
    const atP = (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols) ? pField[r * cols + c] : 0;
    const bandS = 3600.0;
    for (let py = 0; py < H; py++) {
      const gy = (py + 0.5) / s - 0.5, ry = Math.floor(gy), fy = gy - ry;
      for (let px = 0; px < W; px++) {
        const gx = (px + 0.5) / s - 0.5, rx = Math.floor(gx), fx = gx - rx;
        const o = (py * W + px) * 4;
        const p = atP(ry, rx) * (1 - fy) * (1 - fx) + atP(ry + 1, rx) * fy * (1 - fx)
                + atP(ry, rx + 1) * (1 - fy) * fx + atP(ry + 1, rx + 1) * fy * fx;
        if (p < 0.5) { img.data[o + 3] = 0; continue; }   // likely footprint only
        // Interpolate time over the reached corners only (Infinity poisons the bilinear mix).
        let tSum = 0, wSum = 0;
        const corners = [[ry, rx, (1 - fy) * (1 - fx)], [ry + 1, rx, fy * (1 - fx)],
                         [ry, rx + 1, (1 - fy) * fx], [ry + 1, rx + 1, fy * fx]];
        for (const [rr, cc, w] of corners) { const tv = atT(rr, cc); if (isFinite(tv) && w > 0) { tSum += tv * w; wSum += w; } }
        if (wSum <= 0) { img.data[o + 3] = 0; continue; }
        const t = tSum / wSum;
        const band = Math.max(0, Math.min(ISO_COLORS.length - 1, Math.floor(t / bandS)));
        const rgb = ISO_COLORS[band];
        // Thin bright separator at band boundaries → readable contour lines on any basemap.
        const frac = (t % bandS) / bandS;
        const isEdge = frac < 0.045 && band > 0;
        img.data[o] = isEdge ? 255 : rgb[0]; img.data[o + 1] = isEdge ? 255 : rgb[1]; img.data[o + 2] = isEdge ? 255 : rgb[2];
        img.data[o + 3] = Math.round((isEdge ? 235 : 190) * edgeFeather(gx, gy, rows, cols));
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  // Sector overlay — smooth. Shape/alpha come from the bilinear burn footprint; colour comes from
  // the pixel's bearing from the ignition relative to the head (continuous → clean radial wedge
  // boundaries at ±45°/±135°, anti-aliased). No blocky per-cell categories.
  function smoothSectorToDataUrl(rows, cols, field, r0, c0, headBearingDeg) {
    const s = SUPERSAMPLE, W = cols * s, H = rows * s;
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const at = (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols) ? field[r * cols + c] : 0;
    const band = 5.0; // degrees over which adjacent sector colours cross-fade (soft radial edges)
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let py = 0; py < H; py++) {
      const gy = (py + 0.5) / s - 0.5, ry = Math.floor(gy), fy = gy - ry;
      for (let px = 0; px < W; px++) {
        const gx = (px + 0.5) / s - 0.5, rx = Math.floor(gx), fx = gx - rx;
        const p = at(ry, rx) * (1 - fy) * (1 - fx) + at(ry + 1, rx) * fy * (1 - fx)
                + at(ry, rx + 1) * (1 - fy) * fx + at(ry + 1, rx + 1) * fy * fx;
        const o = (py * W + px) * 4;
        if (p < 0.015) { img.data[o + 3] = 0; continue; }
        const dx = gx - c0, dy = r0 - gy;
        let rgb;
        if (dx === 0 && dy === 0) { rgb = SECTOR_RGB[1]; }
        else {
          const bearing = (deg(Math.atan2(dx, dy)) + 360) % 360;
          const rel = ((bearing - headBearingDeg + 180) % 360 + 360) % 360 - 180; // -180..180
          const ar = Math.abs(rel);
          // base sector by angle; cross-fade within `band` degrees of each boundary (45,135)
          let code = ar <= 45 ? 1 : ar <= 135 ? (rel > 0 ? 2 : 3) : 4;
          rgb = SECTOR_RGB[code];
          const near = (bnd) => Math.abs(ar - bnd) < band;
          if (near(45)) { const t = (ar - (45 - band)) / (2 * band); rgb = mix(SECTOR_RGB[1], SECTOR_RGB[rel > 0 ? 2 : 3], Math.min(Math.max(t, 0), 1)); }
          else if (near(135)) { const t = (ar - (135 - band)) / (2 * band); rgb = mix(SECTOR_RGB[rel > 0 ? 2 : 3], SECTOR_RGB[4], Math.min(Math.max(t, 0), 1)); }
        }
        // Same visibility floor as the burn overlay: readable wedges on the light basemap.
        const a = Math.round(225 * Math.min(1, 0.30 + 0.70 * Math.pow(p, 0.6)) * edgeFeather(gx, gy, rows, cols));
        img.data[o] = rgb[0] | 0; img.data[o + 1] = rgb[1] | 0; img.data[o + 2] = rgb[2] | 0; img.data[o + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  // ── Main entry ───────────────────────────────────────────────────────────────────────────────
  async function predict(lat, lon, opts) {
    opts = opts || {};
    const members = Math.min(Math.max(opts.members || 20, 1), 60);
    const half = opts.halfCells || 30;    // grid is (2*half+1) square
    const rows = 2 * half + 1, cols = rows;
    const r0 = half, c0 = half;
    const tstopS = opts.tstopS || 19800.0; // 5.5 h, matches the offline default
    const fuelCode = opts.fuel || DEFAULT_FUEL;

    const mPerDegLat = 111320.0;
    const mPerDegLon = 111320.0 * Math.cos(rad(lat));

    // opts.weather lets a caller inject a fixed weather state (offline manual-wind fallback per
    // OFFLINE-STRATEGY, and deterministic testing); otherwise fetch it from Open-Meteo.
    // opts.scenario is a "what-if" partial override merged over the real weather ({windMs, rhPct,
    // tempC, windDirDeg}) — a pre-deployment tool must let crews explore adverse conditions, not just
    // the current calm. When set, source is flagged "scenario" so the UI never presents it as real.
    let weather = opts.weather ? opts.weather : await getWeather(lat, lon);
    if (opts.scenario && typeof opts.scenario === "object") {
      weather = Object.assign({}, weather, opts.scenario, { source: "scenario", real_wind_ms: weather.windMs });
    }

    // Adaptive resolution: stronger wind drives a much longer run, so start with wider cells; the
    // grow-if-clipped loop below then guarantees the whole fire fits on-grid. Low wind keeps 120 m.
    let cellM = opts.cellM || Math.round(120 * Math.min(Math.max(weather.windMs / 7, 1), 2.5));

    const terrain = await getTerrain(lat, lon, rows, cols, cellM, mPerDegLat, mPerDegLon, r0, c0);

    // Open water → no wildland fuel; return an honest notice instead of a fire on the sea.
    const waterResult = () => ({
      engine: "offline-rothermel-js", ignition: { lat: lat, lon: lon }, epsg: utmZoneEpsg(lat, lon),
      wind_ms: round(weather.windMs, 1), wind_dir_deg: round(weather.windDirDeg, 0),
      weather_source: weather.source, terrain_source: terrain.source, num_members: members,
      max_burn_probability: 0, arrival_time_s: { p10: null, p50: null, p90: null },
      fire_size_ha: { p10: 0, p50: 0, p90: 0 }, flame_length_m: 0, fireline_intensity_kwm: 0, confidence: 0.3,
      fuel: { source: "generated", system: "scott_burgan", confidence: 0.3, code: "—" },
      sectors: { head_bearing_deg: null, dominant: null, crown_capable: false, sectors: [] },
      overlay: null, sector_overlay: null, notice: "water",
      run_id: "offline-" + Date.now().toString(36), _grid: null,
    });
    if (terrain.isWater) return waterResult();

    // Per-cell offline fuel: sample a land-cover source (bundled global biome + aridity, or a cached
    // WorldCover tile) at each cell's centre → real, heterogeneous fuel instead of one global default.
    // opts.fuelData injects a source (tests / a prepared-region pack); null → honest uniform default.
    const fuelData = opts.fuelData !== undefined ? opts.fuelData : await getFuelData(lat, lon, opts);
    function buildFbfm(cellM_) {
      const grid = mkGrid(rows, cols, fuelCode);
      if (!fuelData || typeof fuelData.sample !== "function") return { grid: grid, lc: null };
      const lc = mkGrid(rows, cols, 0);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellLat = lat + ((r0 - r) * cellM_) / mPerDegLat;
          const cellLon = lon + ((c - c0) * cellM_) / mPerDegLon;
          const klass = fuelData.sample(cellLat, cellLon);
          lc[r][c] = klass == null ? 0 : klass;
          grid[r][c] = klass == null ? fuelCode : fuelForLandcover(klass, fuelData.aridity);
        }
      }
      // The user tapped here intending an ignition: if the ignition cell sampled non-burnable
      // (inland bare/urban — open sea already returned above), model it with the default fuel so the
      // tap still yields a prediction. Spread still stops at surrounding non-burnable cells.
      if (!FUEL_MODELS[grid[r0][c0]]) grid[r0][c0] = fuelCode;
      return { grid: grid, lc: lc };
    }
    let fb = buildFbfm(cellM);
    // Landcover-based water detection — works with NO network: the terrain isWater check above
    // needs the elevation API (rate-limit/offline → silently unavailable), but the bundled biome
    // map samples open water as WorldCover class 80 (nodata 0 over deep ocean). If the tap itself
    // is water — or nodata in an essentially all-water/nodata frame — return the honest notice
    // instead of a "no spread" that pretends the sea was a fuel bed.
    if (fb.lc) {
      let waterish = 0, total = 0;
      for (const rowArr of fb.lc) for (const v of rowArr) { total++; if (v === 80 || v === 0) waterish++; }
      const ign = fb.lc[r0][c0];
      if (ign === 80 || (ign === 0 && total > 0 && waterish / total >= 0.9)) return waterResult();
    }
    let fbfm = fb.grid;
    const [m1, m10, m100] = deadFuelMoisture(weather.tempC, weather.rhPct);
    const baseMoist = { m_1h: m1 / 100, m_10h: m10 / 100, m_100h: m100 / 100, m_live_herb: LIVE_HERB_M, m_live_woody: LIVE_WOODY_M };

    // Monte Carlo ensemble — perturb wind + fine moisture + spread rate (mirrors runner.py). Reads
    // the outer `cellM`; the grow-if-clipped loop re-runs it with bigger cells if the fire runs off.
    const adj = 0.5 * (1.0 - 0.45);
    function runEnsemble() {
      let seed = 2024;
      const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const uni = (a, b) => a + (b - a) * rng();
      const counts = new Float64Array(rows * cols);
      const memberArrivals = [], memberSizes = [];
      const sumArrival = new Float64Array(rows * cols), burnedCount = new Int32Array(rows * cols);
      const cellHa = (cellM * cellM) / 10000.0;
      let crownMembers = 0;   // members in which the fire actually reached crowned (torching) cells
      for (let mi = 0; mi < members; mi++) {
        const wind = Math.max(weather.windMs + uni(-1.3, 1.3), 0.0);
        const wdir = ((weather.windDirDeg + uni(-25.0, 25.0)) % 360.0 + 360.0) % 360.0;
        const moist = Object.assign({}, baseMoist);
        moist.m_1h = Math.max(moist.m_1h + uni(-0.02, 0.02), 0.005);
        const rosMult = 1.0 + uni(-adj, adj);
        const crownOut = { cells: 0 };
        const arrival = computeArrival(fbfm, terrain.slope, terrain.aspect, FUEL_MODELS, [r0, c0], cellM, wind, wdir, moist, tstopS, rosMult, crownOut);
        if (crownOut.cells > 0) crownMembers++;
        let burned = 0;
        for (let i = 0; i < arrival.length; i++) {
          const t = arrival[i];
          if (isFinite(t) && t > 0.0) { counts[i] += 1; burned++; memberArrivals.push(t); sumArrival[i] += t; burnedCount[i] += 1; }
        }
        memberSizes.push(burned * cellHa);
      }
      const prob = new Float64Array(rows * cols); let maxP = 0;
      for (let i = 0; i < prob.length; i++) { prob[i] = counts[i] / members; if (prob[i] > maxP) maxP = prob[i]; }
      const p50cell = new Float64Array(rows * cols);
      for (let i = 0; i < p50cell.length; i++) { p50cell[i] = burnedCount[i] ? sumArrival[i] / burnedCount[i] : Infinity; }
      return { prob, p50cell, maxP, memberArrivals, memberSizes, crownProb: crownMembers / members };
    }
    const touchesEdge = (prob) => {
      for (let c = 0; c < cols; c++) if (prob[c] > 0 || prob[(rows - 1) * cols + c] > 0) return true;
      for (let r = 0; r < rows; r++) if (prob[r * cols] > 0 || prob[r * cols + cols - 1] > 0) return true;
      return false;
    };
    let run = runEnsemble();
    // Grow the grid (coarser cells, wider extent) and re-run if the fire reaches the boundary, so a
    // fast fire is never clipped. Bounded to 3 growths (each 1.8×) — plenty for hurricane-force wind.
    for (let grow = 0; grow < 3 && touchesEdge(run.prob); grow++) { cellM = Math.round(cellM * 1.8); fb = buildFbfm(cellM); fbfm = fb.grid; run = runEnsemble(); }
    const prob = run.prob, p50cell = run.p50cell, maxP = run.maxP;

    const a10 = percentile(run.memberArrivals, 10), a50 = percentile(run.memberArrivals, 50), a90 = percentile(run.memberArrivals, 90);
    const fs10 = percentile(run.memberSizes, 10), fs50 = percentile(run.memberSizes, 50), fs90 = percentile(run.memberSizes, 90);

    // Sectorize on the likely footprint (prob >= 0.5) so sector areas match the reported fire size.
    const sect = sectorize(p50cell, prob, rows, cols, [r0, c0], cellM, weather.windDirDeg, 0.5);

    // Fire-behaviour severity: Byram fireline intensity + flame length. Peak in the head; each sector
    // is scaled by its directional rate of spread on the ellipse (I_B ∝ R for a uniform fuel bed).
    // Head intensity/flame use the ignition cell's actual fuel (per-cell offline), not the default.
    const headCode = FUEL_MODELS[fbfm[r0][c0]] ? fbfm[r0][c0] : fuelCode;
    const fmHead = FUEL_MODELS[headCode];
    const headSR = spreadRate(fmHead, baseMoist, weather.windMs * midflameWaf(fmHead.depth_ft), 0.0);
    const eLw = lengthWidthRatio(headSR.eff_wind_ms);
    const eEcc = eLw > 1 ? Math.sqrt(eLw * eLw - 1) / eLw : 0;
    for (const s of sect.sectors) {
      const relA = rad(((s.bearing_deg - (sect.head_bearing_deg || 0) + 180) % 360 + 360) % 360 - 180);
      const dirF = eEcc > 0 ? (1 - eEcc) / (1 - eEcc * Math.cos(relA)) : 1;
      s.max_intensity_kwm = round(headSR.fireline_intensity_kwm * dirF, 0);
    }
    const flameLengthM = round(headSR.flame_length_m, 1);
    const firelineKwm = round(headSR.fireline_intensity_kwm, 0);

    // Geographic corners of the grid (local equirectangular frame around the ignition).
    const halfH = (rows / 2) * cellM, halfW = (cols / 2) * cellM;
    const north = lat + halfH / mPerDegLat, south = lat - halfH / mPerDegLat;
    const west = lon - halfW / mPerDegLon, east = lon + halfW / mPerDegLon;
    const coordinates = [[west, north], [east, north], [east, south], [west, south]];
    const bounds = [west, south, east, north];

    // Tight bounds around the burned area (+ padding) so the map zooms to the fire, not the whole
    // grid — otherwise a small (light-wind) footprint is lost in a 7 km frame.
    let bMinR = rows, bMaxR = -1, bMinC = cols, bMaxC = -1;
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
      if (prob[r * cols + cc] > 0) { if (r < bMinR) bMinR = r; if (r > bMaxR) bMaxR = r; if (cc < bMinC) bMinC = cc; if (cc > bMaxC) bMaxC = cc; }
    }
    let fitBounds = bounds;
    if (bMaxR >= 0) {
      const pad = 4;
      const rTop = Math.max(bMinR - pad, 0), rBot = Math.min(bMaxR + pad, rows - 1);
      const cLef = Math.max(bMinC - pad, 0), cRig = Math.min(bMaxC + pad, cols - 1);
      fitBounds = [
        lon + ((cLef - c0 - 0.5) * cellM) / mPerDegLon,   // west
        lat + ((r0 - rBot - 0.5) * cellM) / mPerDegLat,   // south
        lon + ((cRig - c0 + 0.5) * cellM) / mPerDegLon,   // east
        lat + ((r0 - rTop + 0.5) * cellM) / mPerDegLat,   // north
      ];
    }

    // Burn probability → smooth heatmap. A light blur rounds the Dijkstra "cross" artifact; the
    // alpha ramp feathers the boundary so there is no hard pixel edge (numbers use the raw field).
    const probSmooth = blurField(prob, rows, cols, 1);
    const burnUrl = smoothScalarToDataUrl(rows, cols, probSmooth, (p) => {
      const pc = Math.min(Math.max(p, 0), 1);
      if (pc < 0.015) return [0, 0, 0, 0];
      const rgb = burnColor(pc);
      // Alpha floor: on the light Esri topo basemap a pale-yellow low-probability fringe with
      // alpha∝p was nearly invisible (a maxP≈0.3 fire didn't read at all). Keep the feathered
      // edge but never drop a burnable pixel below ~30% opacity — legibility, not confidence.
      return [rgb[0], rgb[1], rgb[2], Math.round(255 * (0.30 + 0.70 * Math.pow(pc, 0.75)))];
    });
    const headBrg = sect.head_bearing_deg != null ? sect.head_bearing_deg : (weather.windDirDeg + 180) % 360;
    const sectorUrl = smoothSectorToDataUrl(rows, cols, probSmooth, r0, c0, headBrg);
    // Hour-band arrival isochrones on the likely footprint (only when something likely burns).
    const arrivalUrl = maxP >= 0.5 ? arrivalBandsToDataUrl(rows, cols, p50cell, prob, r0, c0, tstopS) : null;

    const overlay = { url: burnUrl, coordinates: coordinates, bounds: bounds, fit_bounds: fitBounds };
    const sectorOverlay = { url: sectorUrl, coordinates: coordinates, bounds: bounds, fit_bounds: fitBounds };
    const arrivalOverlay = arrivalUrl ? { url: arrivalUrl, coordinates: coordinates, bounds: bounds, fit_bounds: fitBounds } : null;

    // Confidence + fuel provenance reflect the actual offline data used. With a per-cell land-cover
    // source the fuel is genuinely local, so confidence rises from the 0.30 single-model floor toward
    // the source's ceiling, scaled by land-cover mapping ambiguity and the weather source (a fixed
    // fallback pulls it down — garbage weather → garbage prediction). No source → honest 0.30.
    let overallConf = 0.3, fuelSource = "generated", fuelConf = 0.3, fuelResolutionM = null, fuelMix = 1;
    if (fuelData) {
      const lcConf = fb.lc ? landcoverConfidence(fb.lc) : 1.0;
      fuelConf = round(Math.max(0.3, Math.min((fuelData.confidence || 0.6) * lcConf, 0.85)), 2);
      fuelSource = fuelData.source || "landcover";
      fuelResolutionM = fuelData.resolution_m || null;
      const wxW = weather.source === "open-meteo" ? 1.0 : (weather.source === "climatology" ? 0.8 : 0.6);
      overallConf = round(Math.max(0.3, fuelConf * wxW), 2);
      // Distinct burnable fuel models across the grid — the per-cell heterogeneity the biome map adds.
      const seen = new Set();
      for (const rowArr of fbfm) for (const code of rowArr) if (FUEL_MODELS[code]) seen.add(code);
      fuelMix = seen.size;
    }

    return {
      engine: "offline-rothermel-js",
      ignition: { lat: lat, lon: lon },
      epsg: utmZoneEpsg(lat, lon),
      wind_ms: round(weather.windMs, 1),
      wind_dir_deg: round(weather.windDirDeg, 0),
      weather_source: weather.source,
      terrain_source: terrain.source,
      num_members: members,
      max_burn_probability: round(maxP, 3),
      arrival_time_s: { p10: nanNull(a10), p50: nanNull(a50), p90: nanNull(a90) },
      fire_size_ha: { p10: roundNull(fs10, 1), p50: roundNull(fs50, 1), p90: roundNull(fs90, 1) },
      flame_length_m: flameLengthM,
      fireline_intensity_kwm: firelineKwm,
      confidence: overallConf,
      fuel: { source: fuelSource, system: "scott_burgan", confidence: fuelConf, code: FUEL_MODELS[headCode].code, resolution_m: fuelResolutionM, mix: fuelMix },
      // First-order crown fire (Van Wagner initiation + Rothermel-1991 crown ROS, default canopy
      // parameters): the share of ensemble members whose fire reached torching timber cells.
      crown: { probability: round(run.crownProb, 2), model: "van-wagner-1977/rothermel-1991", defaults: { cbh_m: CROWN_CBH_M, fmc_pct: CROWN_FMC_PCT } },
      sectors: { head_bearing_deg: sect.head_bearing_deg, dominant: sect.dominant || null, crown_capable: run.crownProb > 0, sectors: sect.sectors },
      overlay: overlay,
      sector_overlay: sectorOverlay,
      arrival_overlay: arrivalOverlay,
      run_id: "offline-" + Date.now().toString(36),
      // Kept for in-browser command-mode assessment (assess() reads this; not shown to the user).
      _grid: { arrival: p50cell, labels: sect.labels, rows: rows, cols: cols, r0: r0, c0: c0, cellM: cellM, lat: lat, lon: lon, mPerDegLat: mPerDegLat, mPerDegLon: mPerDegLon },
    };
  }

  function nanNull(v) { return v === v && isFinite(v) ? round(v, 1) : null; }
  function roundNull(v, n) { return v === v && isFinite(v) ? round(v, n) : null; }

  window.IgneaOffline = { predict: predict, assess: assess, _spreadRate: spreadRate, _computeArrival: computeArrival, _fuelForLandcover: fuelForLandcover, _deadFuelMoisture: deadFuelMoisture, FUEL_MODELS: FUEL_MODELS };
})();

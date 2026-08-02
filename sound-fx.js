'use strict';

// The effect catalogue, shared by the SFX workbench and the Voice tab (see voice.js).
// One module on purpose: two tabs each growing their own effect code drift apart.
//
// Names are short because they are read on a mixer strip, not in prose — the label
// sits above a 24 px fader and the parameter name under it. The longer explanation
// lives in `description` and reaches the operator as a tooltip.
const EFFECTS = [
  {
    id: 'gate',
    label: 'Gate',
    group: 'clean up',
    description: 'Silence below a threshold is attenuated or shortened.',
    parameter: [
      { name: 'threshold_db', min: -60, max: -20, default: -40, unit: 'dB' },
      { name: 'min_ms', min: 50, max: 2000, default: 300, unit: 'ms' },
    ],
  },
  {
    id: 'denoise',
    label: 'Denoise',
    group: 'clean up',
    description: 'Broadband noise floor is damped.',
    parameter: [
      { name: 'amount_db', min: 0, max: 40, default: 15, unit: 'dB' },
    ],
  },
  {
    id: 'trim',
    label: 'Trim',
    group: 'clean up',
    description: 'Silence at the head and tail is removed.',
    parameter: [
      { name: 'threshold_db', min: -60, max: -20, default: -40, unit: 'dB' },
    ],
  },
  {
    id: 'level',
    label: 'Level',
    group: 'clean up',
    description: 'Normalises to a target peak so the chain never writes unlimited.',
    parameter: [
      { name: 'peak_dbfs', min: -24, max: -1, default: -6, unit: 'dBFS' },
    ],
  },
  {
    id: 'highpass',
    label: 'Highpass',
    group: 'shape',
    description: 'Attenuates frequencies below the cutoff.',
    parameter: [
      { name: 'hz', min: 20, max: 2000, default: 80, unit: 'Hz' },
    ],
  },
  {
    id: 'lowpass',
    label: 'Lowpass',
    group: 'shape',
    description: 'Attenuates frequencies above the cutoff.',
    parameter: [
      { name: 'hz', min: 500, max: 20000, default: 12000, unit: 'Hz' },
    ],
  },
  {
    id: 'pitch',
    label: 'Pitch',
    group: 'shape',
    description: 'Shifts the pitch; the tempo stays unchanged.',
    parameter: [
      { name: 'semitones', min: -24, max: 24, default: 0, unit: 'semitones' },
      { name: 'keep_formants', min: 0, max: 1, default: 1, unit: 'bool' },
    ],
  },
  {
    id: 'saturate',
    label: 'Saturate',
    group: 'shape',
    description: 'Soft clipping.',
    parameter: [
      { name: 'amount', min: 0, max: 1, default: 0.3, unit: '0..1' },
    ],
  },
  {
    id: 'radio',
    label: 'Radio',
    group: 'character',
    description: 'Band limiting, saturation and a little noise for a walkie-talkie sound.',
    parameter: [
      { name: 'amount', min: 0, max: 1, default: 0.5, unit: '0..1' },
    ],
  },
  {
    id: 'creature',
    label: 'Creature',
    group: 'character',
    description: 'Drops the pitch with formants kept and saturates slightly — sounds like a larger being.',
    parameter: [
      { name: 'amount', min: 0, max: 1, default: 0.5, unit: '0..1' },
      { name: 'keep_formants', min: 0, max: 1, default: 1, unit: 'bool' },
    ],
  },
];

function findDef(id) {
  return EFFECTS.find((e) => e.id === id);
}

function listEffects() {
  return EFFECTS.map((e) => ({
    id: e.id,
    label: e.label,
    group: e.group,
    description: e.description,
    parameter: e.parameter.map((p) => ({ ...p })),
  }));
}

function resolveSimple(effectId, strength) {
  const def = findDef(effectId);
  if (!def) {
    throw new Error(`Unknown effect id: ${effectId}`);
  }
  if (typeof strength !== 'number' || Number.isNaN(strength) || strength < 0 || strength > 1) {
    throw new Error(`strength must be a number between 0 and 1, got: ${strength}`);
  }
  switch (effectId) {
    case 'gate':
      return { threshold_db: -50 + 20 * strength, min_ms: Math.round(600 - 500 * strength) };
    case 'denoise':
      return { amount_db: 30 * strength };
    case 'trim':
      return { threshold_db: -50 + 20 * strength };
    case 'level':
      return { peak_dbfs: -6 };
    case 'highpass':
      return { hz: Math.round(60 + 440 * strength) };
    case 'lowpass':
      return { hz: Math.round(12000 - 8000 * strength) };
    case 'pitch':
      return { semitones: -12 * strength, keep_formants: true };
    case 'saturate':
      return { amount: strength };
    case 'radio':
      return { amount: strength };
    case 'creature':
      return { amount: strength, keep_formants: true };
    default:
      throw new Error(`Unknown effect id: ${effectId}`);
  }
}

function buildStepFragment(id, params) {
  switch (id) {
    case 'gate': {
      const dur = Number(params.min_ms) / 1000;
      return {
        frag: `silenceremove=stop_periods=-1:stop_duration=${dur}:stop_threshold=${params.threshold_db}dB`,
        description: `pauses below ${params.threshold_db} dB lasting ${params.min_ms} ms or more are gated/shortened`,
      };
    }
    case 'denoise':
      return {
        frag: `afftdn=nr=${params.amount_db}`,
        description: `broadband noise floor damped by ${params.amount_db} dB`,
      };
    case 'trim':
      return {
        frag: `silenceremove=start_periods=1:start_threshold=${params.threshold_db}dB:stop_periods=1:stop_threshold=${params.threshold_db}dB`,
        description: `silence at head and tail below ${params.threshold_db} dB removed`,
      };
    case 'level': {
      const linear = Math.pow(10, Number(params.peak_dbfs) / 20);
      return {
        frag: `alimiter=limit=${linear.toFixed(6)}`,
        description: `level limited to a ${params.peak_dbfs} dBFS target peak`,
      };
    }
    case 'highpass':
      return { frag: `highpass=f=${params.hz}`, description: `frequencies below ${params.hz} Hz attenuated` };
    case 'lowpass':
      return { frag: `lowpass=f=${params.hz}`, description: `frequencies above ${params.hz} Hz attenuated` };
    case 'pitch': {
      const ratio = Math.pow(2, Number(params.semitones) / 12);
      const formant = params.keep_formants ? 'preserved' : 'shifted';
      return {
        frag: `rubberband=pitch=${ratio.toFixed(6)}:formant=${formant}`,
        description: `pitch shifted by ${params.semitones} semitones, tempo unchanged; formants ${
          params.keep_formants
            ? 'kept (sounds like a larger being)'
            : 'shifted along (sounds like slower/faster playback)'
        }`,
      };
    }
    case 'saturate':
      return { frag: `asoftclip=type=tanh:param=${params.amount}`, description: `soft clipping at amount ${params.amount}` };
    case 'radio': {
      const s = Number(params.amount);
      const noiseAmp = (s * 0.02).toFixed(4);
      return {
        frag: `highpass=f=300,lowpass=f=3400,asoftclip=type=tanh:param=${s},aeval=val(0)+(random(0)-0.5)*${noiseAmp}:c=same`,
        description: `band limited to 300–3400 Hz, soft saturation at amount ${s} and a little noise for a walkie-talkie sound`,
      };
    }
    case 'creature': {
      const s = Number(params.amount);
      const semitones = -(6 + s * 18);
      const ratio = Math.pow(2, semitones / 12);
      const formant = params.keep_formants ? 'preserved' : 'shifted';
      return {
        frag: `rubberband=pitch=${ratio.toFixed(6)}:formant=${formant},asoftclip=type=tanh:param=${s}`,
        description: `pitch dropped by about ${semitones.toFixed(1)} semitones with ${
          params.keep_formants
            ? 'formants kept (sounds like a larger being)'
            : 'formants shifted (sounds like slower playback)'
        } and saturation at amount ${s}`,
      };
    }
    default:
      throw new Error(`Unknown effect id: ${id}`);
  }
}

function buildChain(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('spec must be an object: { effect, strength } or { advanced, order }');
  }

  let advanced;
  let order;

  if (Object.prototype.hasOwnProperty.call(spec, 'effect')) {
    const params = resolveSimple(spec.effect, spec.strength);
    advanced = { [spec.effect]: params };
    order = [spec.effect];
  } else if (Object.prototype.hasOwnProperty.call(spec, 'advanced')) {
    advanced = spec.advanced;
    order = spec.order;
  } else {
    throw new Error('spec must contain either { effect, strength } or { advanced, order }');
  }

  if (!Array.isArray(order) || order.length === 0) {
    throw new Error('order must not be empty');
  }

  if (!advanced || typeof advanced !== 'object') {
    throw new Error('advanced must be an object');
  }

  const advancedKeys = Object.keys(advanced);
  const orderSet = new Set(order);
  const advancedKeySet = new Set(advancedKeys);
  const setsMatch =
    advancedKeys.length === order.length &&
    advancedKeys.every((k) => orderSet.has(k)) &&
    order.every((id) => advancedKeySet.has(id));
  if (!setsMatch) {
    throw new Error('advanced block does not match order — both must hold the same set of effect ids');
  }

  for (const id of order) {
    if (!findDef(id)) {
      throw new Error(`Unknown effect id: ${id}`);
    }
  }

  for (const id of order) {
    const def = findDef(id);
    const params = advanced[id];
    if (!params || typeof params !== 'object') {
      throw new Error(`Missing parameters for effect '${id}'`);
    }
    for (const p of def.parameter) {
      if (params[p.name] === undefined) {
        throw new Error(`Missing parameter '${p.name}' for effect '${id}'`);
      }
    }
  }

  const nonLevelIds = order.filter((id) => id !== 'level');
  const levelParams = advanced.level || { peak_dbfs: -6 };

  const steps = [];
  const fragments = [];

  for (const id of nonLevelIds) {
    const { frag, description } = buildStepFragment(id, advanced[id]);
    fragments.push(frag);
    const schritt = { id, params: advanced[id], description };
    if (advanced[id].keep_formants !== undefined) {
      schritt.keep_formants = advanced[id].keep_formants;
    }
    steps.push(schritt);
  }

  {
    const { frag, description } = buildStepFragment('level', levelParams);
    fragments.push(frag);
    steps.push({ id: 'level', params: levelParams, description });
  }

  const warnings = [];
  const hp = advanced.highpass;
  const lp = advanced.lowpass;
  if (hp && lp && Number(hp.hz) > Number(lp.hz)) {
    warnings.push(
      `highpass (${hp.hz} Hz) sits above lowpass (${lp.hz} Hz) — the two partly cancel each other out`
    );
  }

  const filter = `[0:a]${fragments.join(',')}[out]`;
  const args = ['-filter_complex', filter, '-map', '[out]'];

  return { filter, args, steps, warnings };
}

module.exports = { buildChain, listEffects, resolveSimple };

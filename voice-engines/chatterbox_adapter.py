# -*- coding: utf-8 -*-
# Chatterbox adapter for Phoenix's local voice dispatcher (voice-dispatcher.js).
# Reads a spec JSON {text, reference, language, out, params}, generates ONE wav to `out`.
# Contract with the dispatcher: success = the output FILE (not the exit code); prints "SEED <n>"
# and "OK <out>" on stdout; errors go to stderr with a non-zero exit.
#
# There is NO default reference voice on purpose: the caller must always name a WAV (Phoenix passes
# one from sounds/refs/). A missing reference is an error, never a silent fallback to someone's voice.
#
# Watermark (VO1b): ON by default. chatterbox itself builds `perth.PerthImplicitWatermarker()` and applies it inside generate();
# we only put a guard in front of it. params.watermark === false -> the watermarker is never constructed or called.
# If Perth cannot be imported / constructed / applied (the old "incompatible resemble-perth" case = a venv without
# pkg_resources, see the pins in workflows.js), the take is STILL written and we print `WATERMARK_FAILED <short reason>`
# on stdout - the dispatcher turns that into `X-Voice-Watermark: failed`. Never a silent no-op.
import sys, os, json, random, types

_WM = {"on": True, "failures": []}


def _wm_fail(exc):
    why = (type(exc).__name__ + ": " + str(exc)).replace("\r", " ").replace("\n", " ").strip()
    _WM["failures"].append(why[:160])


def _install_perth_guard(enabled):
    """Wrap perth.PerthImplicitWatermarker so a failing watermark never costs the take."""
    _WM["on"] = bool(enabled)
    real_cls = None
    try:
        import perth
        real_cls = getattr(perth, "PerthImplicitWatermarker", None)
        if real_cls is None and enabled:
            # resemble-perth swallows an ImportError of its own net (no pkg_resources / torch) and leaves this attribute None
            _wm_fail(RuntimeError("resemble-perth has no PerthImplicitWatermarker (its net failed to import - check setuptools<81)"))
    except Exception as e:   # includes ImportError from a missing pkg_resources
        if enabled:
            _wm_fail(e)
        perth = types.ModuleType("perth")
        sys.modules["perth"] = perth   # chatterbox does `import perth` at load time: give it something that cannot crash

    class _Guard:
        def __init__(self, *a, **kw):
            self._real = None
            if enabled and real_cls is not None:
                try:
                    self._real = real_cls(*a, **kw)
                except Exception as e:
                    _wm_fail(e)

        def apply_watermark(self, wav, sample_rate=None, **kw):
            if self._real is None:
                return wav
            try:
                return self._real.apply_watermark(wav, sample_rate=sample_rate, **kw)
            except Exception as e:
                _wm_fail(e)
                return wav

    perth.PerthImplicitWatermarker = _Guard


def fail(msg, code):
    line = "chatterbox_adapter: " + msg + "\n"
    try:
        sys.stderr.write(line)
    except UnicodeEncodeError:   # legacy Windows console codepage
        sys.stderr.buffer.write(line.encode("utf-8"))
    sys.exit(code)


def main():
    if len(sys.argv) < 2:
        fail("usage: chatterbox_adapter.py <spec.json>", 2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        spec = json.load(f)
    text = (spec.get("text") or "").strip()
    if not text:
        fail("empty text", 2)
    out = spec.get("out")
    if not out:
        fail("no out path in spec", 2)
    ref = spec.get("reference")
    if not ref or not os.path.isfile(ref):
        fail("reference wav required", 2)
    lang = spec.get("language") or "en"
    params = spec.get("params") or {}
    cfg_weight = float(params.get("cfg_weight", 0.3))
    exaggeration = float(params.get("exaggeration", 0.6))
    # Seed: same seed + same text + same reference = identical wav. Without one a seed is rolled and
    # reported, so a good take can be repeated.
    seed = params.get("seed")
    try:
        seed = int(seed) if seed is not None and str(seed).strip() != "" else random.randint(0, 2**31 - 1)
    except (TypeError, ValueError):
        fail("seed must be an integer", 2)
    if not (0 <= seed <= 2**31 - 1):
        fail("seed out of range (0..2147483647)", 2)

    # Heavy imports only after the cheap argument checks above.
    import torch
    if not torch.cuda.is_available():
        fail("no CUDA device — Chatterbox needs an NVIDIA GPU", 2)
    import numpy as np
    _install_perth_guard(params.get("watermark") is not False)
    import torchaudio
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    d = os.path.dirname(out)
    if d:
        os.makedirs(d, exist_ok=True)

    def _seed_all():
        random.seed(seed); np.random.seed(seed); torch.manual_seed(seed); torch.cuda.manual_seed_all(seed)
    _seed_all()
    m = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
    _seed_all()   # again after loading: loading consumes random numbers
    wav = m.generate(text, language_id=lang, audio_prompt_path=ref,
                     cfg_weight=cfg_weight, exaggeration=exaggeration)
    torchaudio.save(out, wav.detach().cpu(), m.sr)
    if _WM["on"] and _WM["failures"]:
        print("WATERMARK_FAILED " + _WM["failures"][0], flush=True)
    print("SEED " + str(seed), flush=True)
    print("OK " + out, flush=True)


if __name__ == "__main__":
    main()

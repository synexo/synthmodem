#!/usr/bin/env python3
"""
compare-audio-dumps.py — diagnose audio pipeline integrity between
                        Node host and slmodemd inside the VM.

Usage
-----
    python3 scripts/compare-audio-dumps.py <captures/PREFIX>

Where PREFIX is the shared timestamp prefix of a call's capture files.
For example, if captures/ contains:

    captures/2026-04-22T04-12-33-000Z_abc-def-host_rx.wav
    captures/2026-04-22T04-12-33-000Z_abc-def-host_tx.wav
    captures/2026-04-22T04-12-33-000Z_abc-def-host_modem_rx_8k.raw
    captures/2026-04-22T04-12-33-000Z_abc-def-host_modem_rx.raw
    captures/2026-04-22T04-12-33-000Z_abc-def-host_modem_tx.raw

…run it as:

    python3 scripts/compare-audio-dumps.py \
        captures/2026-04-22T04-12-33-000Z_abc-def-host

This requires config.modem.dumpModemPipeline = true and the slmodemd
backend.

Comparisons performed
---------------------
1. Node RX WAV vs modem_rx_8k.raw (both 8 kHz int16 mono):
     proves Node → TCP → QEMU → virtio → shim → slmodemd RX pipeline
     integrity. This is THE KEY TEST for the "too many transforms"
     hypothesis.
2. modem_rx_8k.raw vs modem_rx.raw (8 kHz vs 9.6 kHz, resampled):
     measures slmodemd's 8→9.6 resampler fidelity.
3. Node TX WAV vs modem_tx.raw (8 kHz vs 9.6 kHz, reverse resample):
     measures the complete TX pipeline.

Each comparison reports:
  - length match (is the sample count consistent with real-time cadence?)
  - amplitude fidelity (peak and RMS errors between the two)
  - frequency fidelity (FFT-based comparison)
  - cross-correlation (latency and amplitude deviation at peak lag)

Dependencies: numpy, scipy (standard scientific Python).
No Anthropic-specific or VM-specific deps.
"""

import sys
import os
import wave
import array
import numpy as np
from scipy import signal as sp


# ─── File loaders ───────────────────────────────────────────────────────────

def load_wav_mono16(path):
    """Load a mono 16-bit WAV and return (samples_float32, sample_rate)."""
    with wave.open(path, 'rb') as w:
        if w.getnchannels() != 1:
            raise ValueError(f'{path}: expected mono, got {w.getnchannels()}')
        if w.getsampwidth() != 2:
            raise ValueError(f'{path}: expected 16-bit, got {w.getsampwidth() * 8}')
        sr = w.getframerate()
        n = w.getnframes()
        data = w.readframes(n)
    a = array.array('h')
    a.frombytes(data)
    samples = np.array(a, dtype=np.float32) / 32768.0
    return samples, sr


def load_raw_int16(path, sample_rate):
    """Load a raw int16 LE mono file; caller declares the sample rate."""
    with open(path, 'rb') as f:
        raw = f.read()
    a = array.array('h')
    a.frombytes(raw)
    samples = np.array(a, dtype=np.float32) / 32768.0
    return samples, sample_rate


def resample_to(samples, src_sr, dst_sr):
    """Resample using scipy.signal.resample_poly with integer ratios
    where possible (8000→9600 is 6:5)."""
    if src_sr == dst_sr:
        return samples
    from math import gcd
    g = gcd(src_sr, dst_sr)
    up = dst_sr // g
    down = src_sr // g
    return sp.resample_poly(samples, up, down).astype(np.float32)


# ─── Metrics ────────────────────────────────────────────────────────────────

def metric_length(a, b):
    """Return difference in samples and what that means in time."""
    diff = len(a) - len(b)
    return diff


def metric_amplitude(a, b):
    """Peak amplitude and RMS of the error a - b (after length-trim)."""
    n = min(len(a), len(b))
    err = a[:n] - b[:n]
    peak = float(np.max(np.abs(err)))
    rms = float(np.sqrt(np.mean(err * err)))
    ra = float(np.sqrt(np.mean(a[:n] * a[:n])))
    rb = float(np.sqrt(np.mean(b[:n] * b[:n])))
    return {
        'peak_abs_error': peak,
        'rms_error': rms,
        'rms_a': ra,
        'rms_b': rb,
        'rms_ratio_b_over_a': (rb / ra) if ra > 1e-9 else 0.0,
    }


def metric_frequency(a, b, sr):
    """Compare long-window FFT power spectra.

    Returns max relative difference between normalised spectra (in the
    300-3500 Hz band, which covers the modem band).
    """
    n = min(len(a), len(b))
    # Use a single window across the whole signal
    nperseg = min(8192, n)
    fa, Pa = sp.welch(a[:n], sr, nperseg=nperseg)
    fb, Pb = sp.welch(b[:n], sr, nperseg=nperseg)
    mask = (fa >= 300) & (fa <= 3500)
    Pa_m = Pa[mask]
    Pb_m = Pb[mask]
    # Normalise each so they integrate to 1
    Pa_n = Pa_m / (Pa_m.sum() + 1e-12)
    Pb_n = Pb_m / (Pb_m.sum() + 1e-12)
    # L1 difference across bins (0 = identical spectrum shape,
    # 2 = completely disjoint spectra)
    l1 = float(np.sum(np.abs(Pa_n - Pb_n)))
    return {
        'spectrum_l1_difference': l1,
        'spectrum_correlation': float(np.corrcoef(Pa_m, Pb_m)[0, 1]),
    }


def metric_cross_correlation(a, b, sr):
    """Cross-correlate a with b to find lag and amplitude of best match.

    Lag > 0 means b is delayed relative to a.
    """
    n = min(len(a), len(b), sr * 3)  # up to first 3 s (enough for RTP-to-slmodemd)
    if n < 1024:
        return {'peak_lag_samples': 0, 'peak_lag_ms': 0.0, 'peak_corr_normalised': 0.0}
    a_n = (a[:n] - a[:n].mean())
    b_n = (b[:n] - b[:n].mean())
    sa = a_n.std()
    sb = b_n.std()
    if sa < 1e-9 or sb < 1e-9:
        return {'peak_lag_samples': 0, 'peak_lag_ms': 0.0, 'peak_corr_normalised': 0.0}
    a_n /= sa
    b_n /= sb
    # Full correlation; peak location is the lag
    xc = sp.correlate(b_n, a_n, mode='full') / n
    mid = len(xc) // 2
    # Only look at sensible positive lags up to 500 ms — anything
    # larger isn't "latency" any more, it's a different signal.
    half_lag = int(0.5 * sr)
    window_lo = max(mid - half_lag, 0)
    window_hi = min(mid + half_lag, len(xc))
    idx = window_lo + int(np.argmax(xc[window_lo:window_hi]))
    lag = idx - mid
    return {
        'peak_lag_samples': int(lag),
        'peak_lag_ms': lag * 1000.0 / sr,
        'peak_corr_normalised': float(xc[idx]),
    }


# ─── Per-comparison runner ──────────────────────────────────────────────────

def compare(label, a, b, sr, rationale):
    """Run all metrics over a,b at sample rate sr, pretty-print results."""
    print(f'\n━━━ {label} ━━━')
    print(f'    {rationale}')
    print(f'    sample rate: {sr} Hz')
    print(f'    samples: {len(a)} vs {len(b)}  ({len(a)/sr:.3f}s vs {len(b)/sr:.3f}s)')

    diff = metric_length(a, b)
    diff_ms = diff * 1000.0 / sr
    print(f'    length   Δ:  {diff:+d} samples ({diff_ms:+.1f} ms)')

    amp = metric_amplitude(a, b)
    print('    amplitude:')
    print(f'      RMS a:                 {amp["rms_a"]:.5f}')
    print(f'      RMS b:                 {amp["rms_b"]:.5f}')
    print(f'      RMS ratio (b/a):       {amp["rms_ratio_b_over_a"]:.4f}  (1.0 = identical gain)')
    print(f'      peak |error|:          {amp["peak_abs_error"]:.5f}')
    print(f'      RMS of error:          {amp["rms_error"]:.5f}')

    freq = metric_frequency(a, b, sr)
    print('    frequency:')
    print(f'      spectral correlation:  {freq["spectrum_correlation"]:.4f}  (1.0 = same shape)')
    print(f'      spectrum L1 diff:      {freq["spectrum_l1_difference"]:.4f}  (0 = identical, 2 = disjoint)')

    xc = metric_cross_correlation(a, b, sr)
    print('    cross-correlation (b vs a):')
    print(f'      peak lag:              {xc["peak_lag_samples"]} samples ({xc["peak_lag_ms"]:+.2f} ms)')
    print(f'      peak correlation:      {xc["peak_corr_normalised"]:.4f}  (1.0 = perfect match)')


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    prefix = sys.argv[1]

    rx_wav = prefix + '_rx.wav'
    tx_wav = prefix + '_tx.wav'
    rx_8k  = prefix + '_modem_rx_8k.raw'
    rx_9k6 = prefix + '_modem_rx.raw'
    tx_9k6 = prefix + '_modem_tx.raw'

    for p in (rx_wav, tx_wav, rx_8k, rx_9k6, tx_9k6):
        if not os.path.exists(p):
            print(f'[warn] missing: {p}')

    print('=' * 72)
    print('Audio pipeline integrity report')
    print('=' * 72)
    print(f'Capture prefix: {prefix}')

    # 1. Node RX WAV vs modem_rx_8k.raw  (THE money test)
    if os.path.exists(rx_wav) and os.path.exists(rx_8k):
        a, sr = load_wav_mono16(rx_wav)
        b, _  = load_raw_int16(rx_8k, sr)
        compare(
            'Node RX  ↔  slmodemd RX input (8 kHz)',
            a, b, sr,
            rationale=(
                'Proves Node-side audio (after RTP decode, Float32→Int16, '
                'wire encode, TCP loopback) is delivered losslessly to '
                'slmodemd. Any significant difference = pipeline bug.'
            ),
        )

    # 2. modem_rx_8k.raw vs modem_rx.raw  (resampler inside slmodemd)
    if os.path.exists(rx_8k) and os.path.exists(rx_9k6):
        a, _ = load_raw_int16(rx_8k, 8000)
        b, _ = load_raw_int16(rx_9k6, 9600)
        # Bring both to the same rate for comparison. 8k→9k6 via
        # scipy polyphase is close to what slmodemd does via its
        # RcFixed_Resample call.
        a_9k6 = resample_to(a, 8000, 9600)
        compare(
            'slmodemd 8 kHz input  ↔  9.6 kHz post-resample',
            a_9k6, b, 9600,
            rationale=(
                "Measures slmodemd's 8 → 9.6 kHz resampler fidelity. "
                'If our reference polyphase resampler and slmodemd\'s '
                'output diverge, resampling is a suspect.'
            ),
        )

    # 3. Node TX WAV vs modem_tx.raw  (reverse direction)
    if os.path.exists(tx_wav) and os.path.exists(tx_9k6):
        a, sr_tx = load_wav_mono16(tx_wav)  # 8 kHz
        b_9k6, _ = load_raw_int16(tx_9k6, 9600)
        # Bring slmodemd's 9.6 output down to 8k so we can compare
        # it to what Node captured post-wire.
        b_8k = resample_to(b_9k6, 9600, sr_tx)
        compare(
            'slmodemd TX output  ↔  Node TX capture (8 kHz)',
            b_8k, a, sr_tx,
            rationale=(
                'Measures the TX reverse path: 9.6 kHz DSP → 8 kHz resample '
                'by slmodemd → shim → virtio → QEMU → TCP → Node → wire decode '
                '→ WAV capture. Any significant difference = TX pipeline bug.'
            ),
        )

    print()
    print('=' * 72)
    print('How to read this:')
    print('  - RMS ratio close to 1.0 and peak correlation close to 1.0 ')
    print('    = clean pipeline, "too many transforms" hypothesis disproved.')
    print('  - Big peak correlation (>0.95) but small RMS ratio = attenuation')
    print('    (signal is right, gain drifted).')
    print('  - Small peak correlation (<0.9) or big L1 spectrum diff = signal')
    print('    corruption or missing samples — pipeline needs investigation.')
    print('=' * 72)


if __name__ == '__main__':
    main()

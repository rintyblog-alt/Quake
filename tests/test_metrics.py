"""波形指標の検証。"""

import numpy as np
import pytest

from sim.metrics import (final_intensity_batch, integrate, peak_ground_motion,
                         realtime_intensity, realtime_intensity_batch)


def sine_acc(freq=1.0, amp=100.0, dt=0.01, n=6000):
    t = np.arange(n) * dt
    a = np.zeros((3, n))
    a[0] = amp * np.sin(2 * np.pi * freq * t)
    return a, dt


def test_integration_of_sine_gives_expected_amplitude():
    """加速度 A sin(wt) の速度振幅は A / w になる。"""
    acc, dt = sine_acc(freq=1.0, amp=100.0)
    vel = integrate(acc, dt)
    expected = 100.0 / (2 * np.pi * 1.0)
    assert np.abs(vel[0]).max() == pytest.approx(expected, rel=0.1)


def test_peak_ground_motion_keys_and_order():
    acc, dt = sine_acc()
    m = peak_ground_motion(acc, dt)
    assert set(m) == {"pga", "pgv", "pgd", "pga_ud"}
    assert m["pga"] == pytest.approx(100.0, rel=0.05)
    assert m["pgv"] > 0 and m["pgd"] > 0


def test_realtime_intensity_rises_then_falls():
    dt, n = 0.01, 4000
    t = np.arange(n) * dt
    env = np.exp(-((t - 20.0) ** 2) / 25.0)
    acc = np.tile(200.0 * env * np.sin(2 * np.pi * 1.0 * t), (3, 1))
    times, inten = realtime_intensity(acc, dt)
    peak = int(np.argmax(inten))
    assert 15.0 < times[peak] < 25.0
    assert inten[peak] > inten[0]
    assert inten[peak] > inten[-1]


def test_batch_matches_single_station():
    acc, dt = sine_acc()
    batch = acc[None, :, :]
    _, one = realtime_intensity(acc, dt)
    _, many = realtime_intensity_batch(batch, dt)
    assert many[0] == pytest.approx(one, abs=1e-9)


def test_final_intensity_batch_is_rounded():
    acc, dt = sine_acc()
    v = final_intensity_batch(acc[None, :, :], dt)
    assert v.shape == (1,)
    assert v[0] == pytest.approx(round(v[0], 1))

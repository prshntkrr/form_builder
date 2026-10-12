"""Turning a recording of somebody speaking into a voiceprint.

A voiceprint is 256 numbers. The same person's recordings land close together in
that space and other people's land far away, so "is this the same voice" is a
distance, not a comparison of audio. That is the whole idea, and it is why
**the recordings are never stored**: once the vector exists the audio has
nothing left to contribute, and keeping it would be keeping the one asset that
lets somebody replay a login.

Pure except for loading the model file — no database, no HTTP.

The audio arrives already decoded: 16 kHz mono float32 in [-1, 1]. The browser
does that part, because every browser already has an audio decoder and a
resampler and the alternative is ffmpeg on the server for every codec a phone
might record in. **Only the audio crosses the wire, never the vector** — a
client that could post its own vector could post somebody else's.

Two layers, and the model is the replaceable one:

    samples ──> 80-bin log-mel fbank ──> ResNet34 (ONNX) ──> 256 floats
                (kaldi-native-fbank)     (WeSpeaker, VoxCeleb)

`MODEL` names that pipeline and is stored beside every voiceprint, because
vectors from two different models are not merely incomparable — they are
meaningless against each other, and without the name a model upgrade would
silently turn every enrolled voiceprint into noise that fails forever with no
way to tell which accounts need re-enrolling.
"""
from __future__ import annotations

import logging
import math
import threading
from pathlib import Path
from typing import List, Optional, Sequence

import numpy as np

logger = logging.getLogger(__name__)


class VoiceError(Exception):
    """A recording that cannot become a voiceprint, with a sentence saying why."""


# --------------------------------------------------------------------------- #
# the pipeline's identity
# --------------------------------------------------------------------------- #
MODEL = "wespeaker-resnet34-lm-1"
MODEL_FILE = Path(__file__).resolve().parents[2] / "models" / "voxceleb_resnet34_LM.onnx"

SAMPLE_RATE = 16000
DIMS = 256

# Below this there is not enough voice to characterise, and a voiceprint built
# from a syllable matches everybody a little. Above it, more audio adds nothing
# measurable, so the tail is dropped rather than paid for.
MIN_SECONDS = 1.2
MAX_SECONDS = 20.0

# A microphone that was never spoken into still produces a signal. Enrolling
# that would store the voiceprint of a room, which is both useless and, because
# every quiet room sounds alike, a key that opens more than one account.
MIN_RMS = 0.004

# A hard ceiling on one uploaded recording, checked before it is decoded: at
# MAX_SECONDS of 16-bit audio a clip is about 640 KB, which is under 900 KB of
# base64. Anything far larger is not a recording.
MAX_UPLOAD_CHARS = 1_200_000

# How many recordings make an enrolment, and how much they must agree. Averaging
# several is a real accuracy gain over one — it cancels the particular noise of
# each take. The agreement check is what stops two different people, or one
# person and a lorry, being averaged into a voiceprint resembling neither.
SAMPLES_WANTED = 3
MIN_AGREEMENT = 0.55

_session = None
_lock = threading.Lock()


def available() -> bool:
    """Whether a voiceprint can be computed at all on this installation.

    Called before offering voice enrolment, so the screen can say the feature is
    not set up here instead of a button failing when it is pressed.
    """
    return MODEL_FILE.exists()


def _model():
    """The ONNX session, loaded once.

    Lazily, and never at import: the model is 26 MB and most requests to this
    application have nothing to do with voice.
    """
    global _session
    if _session is None:
        with _lock:
            if _session is None:
                if not MODEL_FILE.exists():
                    raise VoiceError(
                        "Voice sign-in is not set up on this server — the speaker "
                        "model is missing.")
                import onnxruntime as ort

                opts = ort.SessionOptions()
                # One request, one core's worth of work. The default spawns a
                # thread per core per session, which on a web server competes
                # with the requests it is trying to serve.
                opts.intra_op_num_threads = 1
                _session = ort.InferenceSession(
                    str(MODEL_FILE), opts, providers=["CPUExecutionProvider"])
                logger.info("Loaded speaker model %s", MODEL)
    return _session


# --------------------------------------------------------------------------- #
# audio in
# --------------------------------------------------------------------------- #
def _check_audio(samples: np.ndarray) -> np.ndarray:
    seconds = len(samples) / SAMPLE_RATE
    if seconds < MIN_SECONDS:
        raise VoiceError(
            f"That recording is only {seconds:.1f} seconds long. "
            f"Speak for at least {MIN_SECONDS:.0f} seconds.")

    if not np.all(np.isfinite(samples)):
        raise VoiceError("That recording is damaged.")

    samples = samples[: int(MAX_SECONDS * SAMPLE_RATE)]

    rms = float(np.sqrt(np.mean(np.square(samples))))
    if rms < MIN_RMS:
        raise VoiceError(
            "That recording is almost silent. Check the microphone is allowed "
            "and speak a little closer to it.")
    return samples


def from_pcm16(encoded: str) -> np.ndarray:
    """One recording off the wire: base64 of 16 kHz mono signed 16-bit PCM.

    16-bit rather than the float32 the browser holds, which halves what a phone
    on a field connection has to upload and loses nothing — the feature
    extractor reads audio at this precision anyway.
    """
    import base64
    import binascii

    if not isinstance(encoded, str) or not encoded:
        raise VoiceError("That recording is missing.")
    if len(encoded) > MAX_UPLOAD_CHARS:
        raise VoiceError("That recording is too long.")

    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise VoiceError("That recording could not be read.")

    if len(raw) < 2 or len(raw) % 2:
        raise VoiceError("That recording could not be read.")

    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def _fbank(samples: np.ndarray) -> np.ndarray:
    """80-bin log-mel filterbank, exactly as the model was trained on.

    Kaldi's own implementation rather than a hand-rolled mel bank: the window
    shape, pre-emphasis and edge handling all have to match what the model saw
    in training, and getting one of them subtly wrong does not fail — it
    quietly makes every voice resemble every other.
    """
    import kaldi_native_fbank as knf

    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = float(SAMPLE_RATE)
    opts.frame_opts.dither = 0.0           # reproducible: the same clip, the same vector
    opts.frame_opts.snip_edges = True
    opts.mel_opts.num_bins = 80

    fbank = knf.OnlineFbank(opts)
    # Kaldi reads audio at int16 scale, so [-1, 1] has to be opened out to it.
    fbank.accept_waveform(float(SAMPLE_RATE), (samples * 32768.0).tolist())
    fbank.input_finished()

    frames = [fbank.get_frame(i) for i in range(fbank.num_frames_ready)]
    if not frames:
        raise VoiceError("That recording is too short to measure.")

    feats = np.asarray(frames, dtype=np.float32)
    # Mean normalisation over time, which is what makes the result about the
    # speaker rather than about the microphone and the room they sat in.
    return feats - feats.mean(axis=0, keepdims=True)


def embed(samples: Sequence[float]) -> np.ndarray:
    """One recording -> one unit-length voiceprint.

    Unit length so that comparing two of them is a dot product, and so that
    averaging several and renormalising is the ordinary thing it looks like.
    """
    audio = _check_audio(np.asarray(samples, dtype=np.float32).reshape(-1))
    feats = _fbank(audio)[None, :, :]        # the model takes a batch

    session = _model()
    vector = session.run(["embs"], {"feats": feats})[0][0]
    return _unit(np.asarray(vector, dtype=np.float32))


def _unit(vector: np.ndarray) -> np.ndarray:
    size = float(np.linalg.norm(vector))
    if not math.isfinite(size) or size < 1e-6:
        raise VoiceError("That recording did not produce a usable voiceprint.")
    return vector / size


# --------------------------------------------------------------------------- #
# comparing and combining
# --------------------------------------------------------------------------- #
def similarity(left: np.ndarray, right: np.ndarray) -> float:
    """How alike two voiceprints are, from -1 to 1.

    Both are unit length, so this is their dot product. What counts as "the same
    person" is a threshold, and a threshold cannot be guessed from here — it
    belongs with whoever can measure it on real recordings from real phones.
    """
    return float(np.clip(np.dot(_unit(left), _unit(right)), -1.0, 1.0))


def enrol(recordings: Sequence[Sequence[float]]) -> np.ndarray:
    """Several recordings of one person -> the voiceprint stored for them.

    The recordings must agree with each other. Without that check the three
    takes are assumed to be one person, and an enrolment where somebody else
    spoke into take two produces an average resembling neither of them — which
    reads as a successful enrolment and fails every sign-in afterwards.
    """
    if len(recordings) < SAMPLES_WANTED:
        raise VoiceError(
            f"Voice enrolment needs {SAMPLES_WANTED} recordings; "
            f"{len(recordings)} were given.")

    prints = [embed(one) for one in recordings]

    worst = min(similarity(a, b)
                for i, a in enumerate(prints) for b in prints[i + 1:])
    if worst < MIN_AGREEMENT:
        raise VoiceError(
            "Those recordings do not sound like the same person. Record all "
            "three in the same quiet place, with the same person speaking.")

    return _unit(np.mean(prints, axis=0))


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #
def pack(vector: np.ndarray) -> bytes:
    """A voiceprint as the bytes that go in the column — 1 KB of float32."""
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    if vector.shape[0] != DIMS:
        raise VoiceError(f"A voiceprint is {DIMS} numbers, not {vector.shape[0]}.")
    return vector.tobytes()


def unpack(blob: Optional[bytes]) -> Optional[np.ndarray]:
    """The bytes back, or None when there is nothing enrolled.

    Returns None rather than raising for a blob of the wrong size too: a
    voiceprint that cannot be read is an account without one, which falls back
    to the password, and raising here would lock somebody out of a door that is
    still open.
    """
    if not blob:
        return None
    raw = bytes(blob)
    if len(raw) != DIMS * 4:
        logger.warning("Ignoring a voiceprint of %d bytes", len(raw))
        return None
    return np.frombuffer(raw, dtype=np.float32)

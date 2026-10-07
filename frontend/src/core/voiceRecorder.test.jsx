/**
 * The audio conversion, which is the part that fails silently.
 *
 * A recording that arrives corrupted does not raise anything — it produces a
 * voiceprint, stores it, and then never matches the person it was taken from,
 * with nothing anywhere saying why. So the check here is the whole round trip:
 * samples in, base64 out, decoded back, compared.
 *
 * jsdom has no Web Audio, so `AudioContext` is stubbed. What is being tested is
 * this module's own arithmetic — the downmix, the resample, the 16-bit scaling
 * and the chunked base64 — not the browser's decoder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { toPcm16, SAMPLE_RATE } from './voiceRecorder.js'

/** An AudioBuffer, as much of one as this module touches. */
function fakeBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (i) => channels[i],
  }
}

/** Installs a stub decoder that hands back `buffer` whatever it is given. */
function stubAudio(buffer) {
  const close = vi.fn()
  window.AudioContext = vi.fn(() => ({
    decodeAudioData: vi.fn(async () => buffer),
    close,
  }))
  return close
}

/** base64 of 16-bit PCM, back to the samples it stands for. */
function decode(encoded) {
  const text = atob(encoded)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  const ints = new Int16Array(bytes.buffer)
  return Array.from(ints, (v) => v / 32768)
}

const blob = { arrayBuffer: async () => new ArrayBuffer(8) }

beforeEach(() => {
  // Absent, so the straight-line fallback is what the resample tests exercise.
  // The browser path is the OfflineAudioContext one and cannot run in jsdom.
  delete window.OfflineAudioContext
  delete window.webkitOfflineAudioContext
})

afterEach(() => {
  delete window.AudioContext
  vi.restoreAllMocks()
})

describe('getting a recording onto the wire', () => {
  it('a sample survives the round trip to within half a step', async () => {
    const samples = Float32Array.from(
      { length: SAMPLE_RATE }, (_, i) => Math.sin(i / 20) * 0.8)
    stubAudio(fakeBuffer([samples], SAMPLE_RATE))

    const back = decode(await toPcm16(blob))

    expect(back).toHaveLength(samples.length)
    back.forEach((value, i) => expect(value).toBeCloseTo(samples[i], 4))
  })

  it('scales by 32768, so nothing comes back quieter than it went in', async () => {
    // The near-miss is scaling by 32767: it looks equivalent and loses a hair
    // of amplitude, by an amount that grows with how loud the sample is.
    const samples = Float32Array.from([0.5, -0.5, 0.25, -0.25])
    stubAudio(fakeBuffer([samples], SAMPLE_RATE))

    expect(decode(await toPcm16(blob))).toEqual([0.5, -0.5, 0.25, -0.25])
  })

  it('clamps instead of wrapping round', async () => {
    // Overflowing an Int16 turns the loudest moment of a recording into the
    // quietest, which a microphone that was spoken into closely can produce.
    const samples = Float32Array.from([1, -1, 1.4, -1.4])
    stubAudio(fakeBuffer([samples], SAMPLE_RATE))

    decode(await toPcm16(blob)).forEach((v) => expect(Math.abs(v)).toBeLessThanOrEqual(1))
  })

  it('mixes a stereo recording down to one channel', async () => {
    // The model takes one channel. Dropping the second instead of averaging
    // throws away half of a recording made on a two-microphone handset.
    const left = Float32Array.from([0.4, 0.4, 0.4, 0.4])
    const right = Float32Array.from([0.2, 0.2, 0.2, 0.2])
    stubAudio(fakeBuffer([left, right], SAMPLE_RATE))

    decode(await toPcm16(blob)).forEach((v) => expect(v).toBeCloseTo(0.3, 4))
  })

  it('resamples to the rate the model was trained on', async () => {
    // A browser records at 48 kHz. Sending that unchanged would stretch every
    // voice to a third of its pitch as far as the model is concerned.
    const samples = new Float32Array(48000).fill(0.5)
    stubAudio(fakeBuffer([samples], 48000))

    const back = decode(await toPcm16(blob))

    expect(back.length).toBe(SAMPLE_RATE)
    expect(back[800]).toBeCloseTo(0.5, 3)
  })

  it('handles a recording long enough to overflow the stack', async () => {
    // `String.fromCharCode(...bytes)` on a real recording's worth of arguments
    // throws, and does not on the one-second clip a test is tempted to use.
    const samples = new Float32Array(SAMPLE_RATE * 15).fill(0.1)
    stubAudio(fakeBuffer([samples], SAMPLE_RATE))

    const encoded = await toPcm16(blob)

    expect(decode(encoded)).toHaveLength(samples.length)
  })

  it('lets go of the audio context even when decoding fails', async () => {
    // A context per failed take, never closed, is a handle leak on a screen
    // whose whole purpose is retrying the recording.
    const close = vi.fn()
    window.AudioContext = vi.fn(() => ({
      decodeAudioData: vi.fn(async () => { throw new Error('not audio') }),
      close,
    }))

    await expect(toPcm16(blob)).rejects.toThrow()
    expect(close).toHaveBeenCalled()
  })
})

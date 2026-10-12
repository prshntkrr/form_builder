/**
 * Recording a voice in the browser and getting it to the server as plain audio.
 *
 * The browser's job is the part it is already good at: capture, decode and
 * resample. Every browser ships an audio decoder and a resampler, and the
 * alternative is the server growing an ffmpeg for each codec a phone might
 * choose to record in.
 *
 * What it deliberately does *not* do is compute the voiceprint. That happens on
 * the server, because a client trusted to send a vector could send somebody
 * else's and enrol their voice onto this account. Only audio crosses the wire.
 */

// What the speaker model was trained on. The server reports the same number;
// this is the default so the first render has something to work with.
export const SAMPLE_RATE = 16000

export const supported = () =>
  !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

/**
 * Start recording. Resolves to a `stop()` that gives back the audio.
 *
 * The microphone is released in `stop`, including when the recording is
 * abandoned — a tab left holding the mic shows a recording indicator the person
 * cannot explain and cannot switch off.
 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Browser-side cleanup. The model copes with a noisy field recording far
      // better than with a clipped one, and these are free.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  const recorder = new MediaRecorder(stream)
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.start()

  return () =>
    new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        resolve(new Blob(chunks, { type: recorder.mimeType }))
      }
      // `stop()` on an already-stopped recorder throws; abandoning the take
      // still has to free the microphone.
      if (recorder.state === 'inactive') recorder.onstop()
      else recorder.stop()
    })
}

/**
 * Recorded audio -> base64 of 16 kHz mono signed 16-bit PCM.
 *
 * 16-bit rather than the float32 the browser holds: it halves the upload and
 * loses nothing the feature extractor would have read anyway.
 */
export async function toPcm16(blob, rate = SAMPLE_RATE) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    ctx.close()
  }

  const mono = downmix(decoded)
  const samples = decoded.sampleRate === rate
    ? mono
    : await resample(mono, decoded.sampleRate, rate)

  return base64(toInt16(samples))
}

export const seconds = (encodedLength, rate = SAMPLE_RATE) =>
  // base64 is 4 characters per 3 bytes, and a sample is 2 bytes.
  (encodedLength * 3) / 4 / 2 / rate

function downmix(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)

  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / buffer.numberOfChannels
  }
  return out
}

async function resample(samples, from, to) {
  const length = Math.max(1, Math.round((samples.length * to) / from))
  try {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
    const ctx = new Offline(1, length, to)
    const buffer = ctx.createBuffer(1, samples.length, from)
    buffer.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
    return (await ctx.startRendering()).getChannelData(0)
  } catch {
    // Some browsers refuse an OfflineAudioContext at 16 kHz. Straight-line
    // interpolation is poorer — it lets some aliasing through — but a slightly
    // rougher recording beats no voice enrolment at all on that browser.
    const out = new Float32Array(length)
    const step = (samples.length - 1) / Math.max(1, length - 1)
    for (let i = 0; i < length; i += 1) {
      const at = i * step
      const low = Math.floor(at)
      const high = Math.min(samples.length - 1, low + 1)
      out[i] = samples[low] + (samples[high] - samples[low]) * (at - low)
    }
    return out
  }
}

function toInt16(samples) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    // 32768 and then clamped, matching the server's divide by 32768. Scaling by
    // 32767 instead — which looks equivalent and is the commoner habit — makes
    // every sample come back a hair quieter than it went in, and the error
    // grows with amplitude rather than staying at half a step.
    const scaled = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32768)
    out[i] = Math.max(-32768, Math.min(32767, scaled))
  }
  return out
}

function base64(ints) {
  const bytes = new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength)
  // In blocks: `String.fromCharCode(...bytes)` on a few hundred thousand
  // arguments overflows the call stack, which it does not do in testing with a
  // one-second clip and does on a real recording.
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(text)
}

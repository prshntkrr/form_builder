import React, { useCallback, useEffect, useRef } from 'react'

/**
 * QR code rendered to a canvas — no dependencies.
 *
 * Uses a minimal implementation of QR version 6 (41×41 modules, up to ~134
 * bytes in alphanumeric mode). Enough for a URL. Error correction level M.
 */

// -- Galois field arithmetic over GF(256) with polynomial 0x11d ---------------
const EXP = new Uint8Array(256)
const LOG = new Uint8Array(256)
;(function () {
  let v = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = v
    LOG[v] = i
    v = (v << 1) ^ (v >= 128 ? 0x11d : 0)
  }
  EXP[255] = EXP[0]
})()

function gfMul(a, b) {
  return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0
}

function polyMul(a, b) {
  const r = new Uint8Array(a.length + b.length - 1)
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      r[i + j] ^= gfMul(a[i], b[j])
  return r
}

function ecBytes(data, ecLen) {
  let gen = Uint8Array.of(1)
  for (let i = 0; i < ecLen; i++)
    gen = polyMul(gen, Uint8Array.of(1, EXP[i]))

  const msg = new Uint8Array(data.length + ecLen)
  msg.set(data)
  for (let i = 0; i < data.length; i++) {
    const coeff = msg[i]
    if (coeff)
      for (let j = 0; j < gen.length; j++)
        msg[i + j] ^= gfMul(gen[j], coeff)
  }
  return msg.slice(data.length)
}

// -- QR matrix ----------------------------------------------------------------
function encode(text) {
  const bytes = new TextEncoder().encode(text)
  const len = bytes.length

  // Pick smallest version that fits byte-mode data with EC level M
  const CAPS = [0,16,28,44,64,86,108,124,154,182,216,254,290,334,365,412,450,493,557,601,669,714,782,860,914,1000]
  let version = 1
  while (version <= 25 && CAPS[version] < len) version++
  if (version > 25) throw new Error('Data too long for QR')

  const size = version * 4 + 17
  const matrix = Array.from({ length: size }, () => new Uint8Array(size))
  const reserved = Array.from({ length: size }, () => new Uint8Array(size))

  function set(r, c, v) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = v ? 1 : 0
      reserved[r][c] = 1
    }
  }

  // Finder patterns
  function finder(row, col) {
    for (let dr = -1; dr <= 7; dr++)
      for (let dc = -1; dc <= 7; dc++) {
        const v = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
           (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
        set(row + dr, col + dc, v)
      }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  // Alignment patterns
  const ALIGN_POS = [
    [],[], [6,18], [6,22], [6,26], [6,30], [6,34],
    [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58],
    [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78],
    [6,30,56,82], [6,30,58,86], [6,34,62,90], [6,28,50,72,94],
    [6,26,50,74,98], [6,30,54,78,102], [6,28,54,80,106], [6,32,58,84,110],
  ]
  const alignPos = ALIGN_POS[version] || []
  for (const r of alignPos)
    for (const c of alignPos) {
      if (reserved[r]?.[c]) continue
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++)
          set(r + dr, c + dc,
            Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0))
    }

  // Reserve format info + dark module
  for (let i = 0; i < 8; i++) {
    set(8, i, 0); set(8, size - 1 - i, 0)
    set(i, 8, 0); set(size - 1 - i, 8, 0)
  }
  set(8, 8, 0)
  set(size - 8, 8, 1) // dark module

  // Reserve version info for version >= 7
  if (version >= 7) {
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        set(i, size - 11 + j, 0)
        set(size - 11 + j, i, 0)
      }
  }

  // EC table for level M: [total codewords, ec per block, blocks group1, data group1, blocks group2, data group2]
  const EC_M = [
    null,
    [26,10,1,16,0,0],[44,16,1,28,0,0],[70,26,1,44,0,0],[100,18,2,32,0,0],
    [134,24,2,43,0,0],[172,16,4,27,0,0],[196,18,4,31,0,0],[242,20,2,38,2,39],
    [292,24,3,36,2,37],[346,28,4,43,1,44],[404,26,1,50,4,51],[466,28,6,36,2,37],
    [532,22,8,37,1,38],[581,24,4,40,5,41],[655,20,5,41,5,42],[733,30,7,45,3,46],
    [815,24,10,46,1,47],[901,28,9,43,4,44],[991,32,3,44,11,45],[1085,28,3,41,13,42],
    [1156,28,17,42,0,0],[1258,28,17,46,0,0],[1364,26,4,47,14,48],[1474,30,6,45,14,46],
    [1588,28,8,47,13,48],
  ]
  const [totalCW, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = EC_M[version]

  // Build data bitstream: byte mode
  const totalData = g1Blocks * g1Data + g2Blocks * g2Data
  const bits = []
  function push(val, count) { for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1) }

  push(0b0100, 4) // byte mode indicator
  push(len, version <= 9 ? 8 : 16) // character count
  for (const b of bytes) push(b, 8)
  push(0, 4) // terminator (up to 4 bits)
  while (bits.length % 8) bits.push(0)
  const pads = [0xEC, 0x11]
  let pi = 0
  while (bits.length < totalData * 8) {
    push(pads[pi], 8)
    pi = 1 - pi
  }

  const dataBytes = new Uint8Array(totalData)
  for (let i = 0; i < totalData; i++) {
    let v = 0
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] || 0)
    dataBytes[i] = v
  }

  // Split into blocks and compute EC
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let g = 0; g < 2; g++) {
    const [cnt, dLen] = g === 0 ? [g1Blocks, g1Data] : [g2Blocks, g2Data]
    for (let b = 0; b < cnt; b++) {
      const block = dataBytes.slice(offset, offset + dLen)
      dataBlocks.push(block)
      ecBlocks.push(ecBytes(block, ecPerBlock))
      offset += dLen
    }
  }

  // Interleave
  const interleaved = []
  const maxData = Math.max(g1Data, g2Data || 0)
  for (let i = 0; i < maxData; i++)
    for (const b of dataBlocks) if (i < b.length) interleaved.push(b[i])
  for (let i = 0; i < ecPerBlock; i++)
    for (const b of ecBlocks) if (i < b.length) interleaved.push(b[i])

  // Place data bits
  const allBits = []
  for (const byte of interleaved)
    for (let b = 7; b >= 0; b--) allBits.push((byte >> b) & 1)
  // Remainder bits
  const remainder = [0,0,7,7,7,7,7,0,0,0,0,0,0,0,3,3,3,3,3,3,3,4,4,4,4,4,4]
  for (let i = 0; i < (remainder[version] || 0); i++) allBits.push(0)

  let bitIdx = 0
  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5
    for (let row = 0; row < size; row++) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c
        const rr = ((Math.floor((size - 1 - col + (col <= 6 ? 1 : 0)) / 2)) % 2 === 0)
          ? size - 1 - row : row
        if (!reserved[rr][cc] && bitIdx < allBits.length) {
          matrix[rr][cc] = allBits[bitIdx++]
        }
      }
    }
  }

  // Apply mask 0 (checkerboard) and write format info
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (!reserved[r][c])
        matrix[r][c] ^= ((r + c) % 2 === 0) ? 1 : 0

  // Format info for mask 0, EC level M: pre-computed with BCH
  const FORMAT = 0b101010000010010
  function setFormat(bits15) {
    for (let i = 0; i < 15; i++) {
      const bit = (bits15 >> (14 - i)) & 1
      // Around top-left finder
      if (i < 6) matrix[8][i] = bit
      else if (i === 6) matrix[8][7] = bit
      else if (i === 7) matrix[8][8] = bit
      else if (i === 8) matrix[7][8] = bit
      else matrix[14 - i][8] = bit
      // Along edges
      if (i < 8) matrix[size - 1 - i][8] = bit
      else matrix[8][size - 15 + i] = bit
    }
  }
  setFormat(FORMAT)

  // Version info for version >= 7
  if (version >= 7) {
    const VERSION_INFO = [
      0,0,0,0,0,0,0,
      0b000111110010010100, 0b001000010110111100, 0b001001101010011001,
      0b001010010011010011, 0b001011101111110110, 0b001100011101100010,
      0b001101100001000111, 0b001110011000001101, 0b001111100100101000,
      0b010000101001111100, 0b010001010101011001, 0b010010101100010011,
      0b010011010000110110, 0b010100100010100010, 0b010101011110000111,
      0b010110100111001101, 0b010111011011101000, 0b011000111011000100,
      0b011001000111100001,
    ]
    const vi = VERSION_INFO[version] || 0
    for (let i = 0; i < 18; i++) {
      const bit = (vi >> i) & 1
      const r = Math.floor(i / 3), c = i % 3
      matrix[r][size - 11 + c] = bit
      matrix[size - 11 + c][r] = bit
    }
  }

  return { matrix, size }
}

function draw(canvas, text, scale) {
  const { matrix, size } = encode(text)
  const quiet = 4
  const total = size + quiet * 2
  canvas.width = total * scale
  canvas.height = total * scale
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000000'
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (matrix[r][c])
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale)
}

export default function QRCode({ value, size = 200 }) {
  const canvasRef = useRef(null)

  const scale = Math.max(4, Math.ceil(size / 50))

  useEffect(() => {
    if (canvasRef.current && value) {
      try {
        draw(canvasRef.current, value, scale)
      } catch (_e) {
        // data too long — leave canvas blank
      }
    }
  }, [value, scale])

  const download = useCallback(() => {
    if (!canvasRef.current) return
    const a = document.createElement('a')
    a.download = 'form-qr-code.png'
    a.href = canvasRef.current.toDataURL('image/png')
    a.click()
  }, [])

  if (!value) return null

  return (
    <div style={{ textAlign: 'center' }}>
      <canvas ref={canvasRef}
              style={{ width: size, height: size, imageRendering: 'pixelated' }} />
      <br />
      <button className="btn btn--sm" onClick={download} style={{ marginTop: 8 }}>
        Download QR code
      </button>
    </div>
  )
}

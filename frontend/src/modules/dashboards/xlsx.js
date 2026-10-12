/**
 * A spreadsheet file, written here rather than by a library.
 *
 * An .xlsx is a zip of XML parts, and the sheet this module writes is the
 * smallest one Excel, LibreOffice and Google Sheets all accept: a single
 * worksheet with its strings inline, so there is no shared-string table to
 * keep in step.
 *
 * Why not a dependency. The two charting libraries already in this project can
 * both export a spreadsheet, and neither one could be used: amCharts fetches
 * SheetJS from a CDN at the moment of the download, which is a network call in
 * the middle of a click and a third-party script this application does not
 * otherwise load, and Highcharts' "XLS" is an HTML table under a spreadsheet
 * extension that Excel warns about on open. Adding SheetJS itself is around a
 * megabyte for the one feature. This is a hundred lines, ships nothing new,
 * and produces a genuine .xlsx.
 *
 * The zip entries are STORED rather than deflated — the format allows it, it
 * needs no compressor, and a spreadsheet of a few thousand cells is small
 * either way.
 */

const ZIP_VERSION = 20;

/* The polynomial is the standard one; the table is built once on first use
   rather than at import, so a page that never exports never pays for it. */
let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);

    for (let index = 0; index < 256; index += 1) {
      let value = index;

      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }

      crcTable[index] = value >>> 0;
    }
  }

  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** The five characters that cannot appear as themselves in XML text. */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A spreadsheet column's letter: 0 → A, 25 → Z, 26 → AA.
 */
export function columnLetter(index) {
  let letters = "";
  let remaining = index;

  while (remaining >= 0) {
    letters = String.fromCharCode((remaining % 26) + 65) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  }

  return letters;
}

/**
 * One cell. A number is written as a number so the spreadsheet can total it;
 * everything else goes in as inline text, which is also what keeps a value
 * like "007" or a long id from being read as a number and losing its shape.
 */
function cellXml(value, reference) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }

  return (
    `<c r="${reference}" t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
  );
}

function sheetXml(rows) {
  const body = rows
    .map((cells, rowIndex) => {
      const number = rowIndex + 1;

      const painted = cells
        .map((value, columnIndex) =>
          cellXml(value, `${columnLetter(columnIndex)}${number}`),
        )
        .join("");

      return `<row r="${number}">${painted}</row>`;
    })
    .join("");

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData>` +
    "</worksheet>"
  );
}

/* The fixed parts. Only the sheet itself changes between one export and the
   next, so these are written out as they are. */
function parts(sheetName) {
  return [
    {
      name: "[Content_Types].xml",
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
        "</workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        "</Relationships>",
    },
  ];
}

/**
 * A worksheet name Excel will accept: 31 characters, and none of the seven it
 * reserves. An empty one would make the file unopenable, so it has a fallback.
 */
export function sheetNameFrom(title) {
  const cleaned = String(title || "")
    .replace(/[\\/?*[\]:]/g, " ")
    .trim()
    .slice(0, 31);

  return cleaned || "Sheet1";
}

/**
 * Build the .xlsx. `rows` is an array of rows, each an array of cell values;
 * the first is treated as the header only in the sense that it is written
 * first — no styling is applied, because a styled header needs a styles part
 * and nothing here reads it back.
 */
export function buildXlsx(rows, { sheetName = "Sheet1" } = {}) {
  const files = [
    ...parts(sheetNameFrom(sheetName)),
    { name: "xl/worksheets/sheet1.xml", text: sheetXml(rows || []) },
  ];

  const locals = [];
  const central = [];

  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);

    localView.setUint32(0, 0x04034b50, true); // local file header
    localView.setUint16(4, ZIP_VERSION, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true); // compressed
    localView.setUint32(22, data.length, true); // uncompressed
    localView.setUint16(26, nameBytes.length, true);

    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    locals.push(local);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);

    entryView.setUint32(0, 0x02014b50, true); // central directory header
    entryView.setUint16(4, ZIP_VERSION, true);
    entryView.setUint16(6, ZIP_VERSION, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);

    entry.set(nameBytes, 46);

    central.push(entry);

    offset += local.length;
  }

  const centralSize = central.reduce((total, entry) => total + entry.length, 0);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);

  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...locals, ...central, end], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

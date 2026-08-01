import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { gzipSync } from 'node:zlib'
import {
  extractFileText,
  truncateView,
  viewArchiveFile,
  viewCsvFile,
  viewDocxFile,
  viewEnvFile,
  viewFile,
  viewFormatForPath,
  viewHexFile,
  viewImageDataUrl,
  viewJsonFile,
  viewLogFile,
  viewPdfFile,
  viewPptxFile,
  viewTextFile,
  viewXlsxFile,
  viewYamlFile,
  MAX_VIEW_OUTPUT_CHARACTERS
} from '../src/main/fileViewer.js'

const createTempDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'supracode-fv-'))
  return directory
}

const createTextFixture = (directory: string, name: string, content: string): string => {
  const path = join(directory, name)
  writeFileSync(path, content, 'utf8')
  return path
}

const buildPdf = (text: string): Buffer => {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  ]
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPosition = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

const buildDocx = async (text: string): Promise<Buffer> => {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  archive.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  archive.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  return archive.generateAsync({ type: 'nodebuffer' })
}

const buildPptx = async (slides: string[]): Promise<Buffer> => {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`)
  archive.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
  archive.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst/></p:presentation>')
  slides.forEach((slide, index) => {
    archive.file(`ppt/slides/slide${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${slide}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
  })
  return archive.generateAsync({ type: 'nodebuffer' })
}

const buildXlsx = async (sheetName: string, sharedString: string): Promise<Buffer> => {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`)
  archive.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  archive.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  archive.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
  archive.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${sharedString}</t></si></sst>`)
  archive.file('xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')
  return archive.generateAsync({ type: 'nodebuffer' })
}

const buildTar = (entries: Array<{ name: string; content: string }>): Buffer => {
  const header = Buffer.alloc(512)
  header.write('ustar', 257, 'ascii')
  const blocks: Buffer[] = []
  for (const { name, content } of entries) {
    const block = Buffer.from(header)
    block.write(name, 0, 'ascii')
    block.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
    block.write('0', 156, 'ascii')
    blocks.push(block)
    const data = Buffer.from(content, 'utf8')
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
    data.copy(padded)
    blocks.push(padded)
  }
  blocks.push(Buffer.alloc(512))
  return Buffer.concat(blocks)
}

test('viewTextFile renders numbered lines', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'notes.txt', 'alpha\nbeta\ngamma\n')
  assert.equal(viewTextFile(path), '1: alpha\n2: beta\n3: gamma')
  rmSync(directory, { recursive: true, force: true })
})

test('viewTextFile supports offset and limit', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'notes.txt', 'one\ntwo\nthree\nfour\n')
  assert.equal(viewTextFile(path, { offset: 2, limit: 2 }), '2: two\n3: three')
  rmSync(directory, { recursive: true, force: true })
})

test('viewTextFile rejects binary content', () => {
  const directory = createTempDir()
  const path = join(directory, 'blob.bin')
  writeFileSync(path, Buffer.from([0x00, 0x01, 0x02]))
  assert.throws(() => viewTextFile(path), /not valid UTF-8/)
  rmSync(directory, { recursive: true, force: true })
})

test('viewTextFile rejects oversized files', () => {
  const directory = createTempDir()
  const path = join(directory, 'big.bin')
  writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  assert.throws(() => viewTextFile(path), /view size limit/)
  rmSync(directory, { recursive: true, force: true })
})

test('viewJsonFile pretty-prints JSON', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'data.json', '{"b":2,"a":[1,true,null]}')
  assert.equal(viewJsonFile(path), '{\n  "b": 2,\n  "a": [\n    1,\n    true,\n    null\n  ]\n}')
  rmSync(directory, { recursive: true, force: true })
})

test('viewYamlFile converts YAML to JSON', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'config.yaml', 'name: demo\nports:\n  - 80\n  - 443\n')
  assert.equal(viewYamlFile(path), '{\n  "name": "demo",\n  "ports": [\n    80,\n    443\n  ]\n}')
  rmSync(directory, { recursive: true, force: true })
})

test('viewEnvFile redacts values and keeps names', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, '.env', 'API_KEY=supersecret\nPORT=3000\n# comment\n')
  const output = viewEnvFile(path)
  assert.ok(output.includes('API_KEY'))
  assert.ok(!output.includes('supersecret'))
  assert.ok(output.includes('PORT'))
  assert.ok(!output.includes('3000'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewCsvFile renders rows', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'data.csv', 'name,age\nAlice,30\nBob,25\n')
  assert.equal(viewCsvFile(path), 'name | age\nAlice | 30\nBob | 25')
  rmSync(directory, { recursive: true, force: true })
})

test('viewCsvFile handles quoted cells', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'quoted.csv', '"a,b","he said ""hi"""\n')
  assert.equal(viewCsvFile(path), 'a,b | he said "hi"')
  rmSync(directory, { recursive: true, force: true })
})

test('viewLogFile returns tail by default', () => {
  const directory = createTempDir()
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
  const path = createTextFixture(directory, 'app.log', `${lines.join('\n')}\n`)
  const output = viewLogFile(path)
  assert.ok(output.startsWith('1: line 1'))
  assert.ok(output.includes('20: line 20'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewLogFile supports explicit offset', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'app.log', 'a\nb\nc\nd\n')
  assert.equal(viewLogFile(path, { offset: 2, limit: 2 }), '2: b\n3: c')
  rmSync(directory, { recursive: true, force: true })
})

test('viewHexFile renders hexdump rows', () => {
  const directory = createTempDir()
  const path = join(directory, 'blob.bin')
  writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0xff]))
  const output = viewHexFile(path)
  assert.ok(output.includes('00000000'))
  assert.ok(output.includes('00 01 02 ff'))
  assert.ok(output.includes('...'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewPdfFile extracts text', async () => {
  const directory = createTempDir()
  const path = join(directory, 'doc.pdf')
  writeFileSync(path, buildPdf('Hello PDF world'))
  assert.equal(await viewPdfFile(path), 'Hello PDF world')
  rmSync(directory, { recursive: true, force: true })
})

test('viewDocxFile extracts text', async () => {
  const directory = createTempDir()
  const path = join(directory, 'doc.docx')
  writeFileSync(path, await buildDocx('Hello DOCX world'))
  assert.equal(await viewDocxFile(path), 'Hello DOCX world')
  rmSync(directory, { recursive: true, force: true })
})

test('viewPptxFile extracts slide text in order', async () => {
  const directory = createTempDir()
  const path = join(directory, 'deck.pptx')
  writeFileSync(path, await buildPptx(['First slide', 'Second slide']))
  const output = await viewPptxFile(path)
  assert.ok(output.includes('--- Slide 1 ---'))
  assert.ok(output.includes('First slide'))
  assert.ok(output.includes('--- Slide 2 ---'))
  assert.ok(output.includes('Second slide'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewXlsxFile extracts sheets and cells', async () => {
  const directory = createTempDir()
  const path = join(directory, 'book.xlsx')
  writeFileSync(path, await buildXlsx('Data', 'Hello XLSX'))
  const output = await viewXlsxFile(path)
  assert.ok(output.includes('--- Sheet: Data ---'))
  assert.ok(output.includes('Hello XLSX'))
  assert.ok(output.includes('42'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewArchiveFile previews zip entries', async () => {
  const directory = createTempDir()
  const path = join(directory, 'bundle.zip')
  const archive = new JSZip()
  archive.file('readme.txt', 'zip hello')
  archive.file('blob.bin', Buffer.from([0x00, 0xff]))
  writeFileSync(path, await archive.generateAsync({ type: 'nodebuffer' }))
  const output = await viewArchiveFile(path)
  assert.ok(output.includes('--- readme.txt ---'))
  assert.ok(output.includes('zip hello'))
  assert.ok(output.includes('blob.bin (2 bytes, binary)'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewArchiveFile previews tar entries', async () => {
  const directory = createTempDir()
  const path = join(directory, 'bundle.tar')
  writeFileSync(path, buildTar([{ name: 'notes.txt', content: 'tar hello' }]))
  const output = await viewArchiveFile(path)
  assert.ok(output.includes('--- notes.txt ---'))
  assert.ok(output.includes('tar hello'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewArchiveFile previews gzipped tar entries', async () => {
  const directory = createTempDir()
  const path = join(directory, 'bundle.tgz')
  writeFileSync(path, gzipSync(buildTar([{ name: 'notes.txt', content: 'gz hello' }])))
  const output = await viewArchiveFile(path)
  assert.ok(output.includes('--- notes.txt ---'))
  assert.ok(output.includes('gz hello'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewFile dispatches by extension', async () => {
  const directory = createTempDir()
  const envPath = createTextFixture(directory, 'service.env', 'TOKEN=abc\n')
  const logPath = createTextFixture(directory, 'app.log', 'logged\n')
  const pdfPath = join(directory, 'doc.pdf')
  writeFileSync(pdfPath, buildPdf('dispatched'))
  assert.ok((await viewFile(envPath)).includes('TOKEN'))
  assert.equal(await viewFile(logPath), '1: logged')
  assert.equal(await viewFile(pdfPath), 'dispatched')
  rmSync(directory, { recursive: true, force: true })
})

test('viewFile rejects image files', async () => {
  const directory = createTempDir()
  const path = join(directory, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await assert.rejects(() => viewFile(path), /view_image/)
  rmSync(directory, { recursive: true, force: true })
})

test('viewFormatForPath covers known extensions', () => {
  assert.equal(viewFormatForPath('a.json'), 'json')
  assert.equal(viewFormatForPath('a.yml'), 'yaml')
  assert.equal(viewFormatForPath('a.csv'), 'csv')
  assert.equal(viewFormatForPath('a.pdf'), 'pdf')
  assert.equal(viewFormatForPath('a.docx'), 'docx')
  assert.equal(viewFormatForPath('a.pptx'), 'pptx')
  assert.equal(viewFormatForPath('a.xlsx'), 'xlsx')
  assert.equal(viewFormatForPath('a.log'), 'log')
  assert.equal(viewFormatForPath('a.zip'), 'archive')
  assert.equal(viewFormatForPath('a.png'), 'image')
  assert.equal(viewFormatForPath('a.env'), 'text')
  assert.equal(viewFormatForPath('a.xyz'), 'text')
})

test('viewFormatForPath maps env files to redacted viewer', () => {
  assert.equal(viewFormatForPath('.env'), 'env')
  assert.equal(viewFormatForPath('/workspace/.env.local'), 'env')
  assert.equal(viewFormatForPath('src/.env.production'), 'env')
  assert.equal(viewFormatForPath('.env.example'), 'text')
})

test('viewFile redacts env values through the dispatcher', async () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, '.env', 'API_KEY=supersecret\n')
  const output = await viewFile(path)
  assert.ok(output.includes('API_KEY'))
  assert.ok(!output.includes('supersecret'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewImageDataUrl returns a data URL for supported images', () => {
  const directory = createTempDir()
  const path = join(directory, 'pixel.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))
  assert.ok(viewImageDataUrl(path).startsWith('data:image/png;base64,'))
  rmSync(directory, { recursive: true, force: true })
})

test('viewImageDataUrl rejects unsupported image formats', () => {
  const directory = createTempDir()
  const path = join(directory, 'pixel.xyz')
  writeFileSync(path, Buffer.from([0x01, 0x02]))
  assert.throws(() => viewImageDataUrl(path), /Unsupported image format/)
  rmSync(directory, { recursive: true, force: true })
})

test('extractFileText skips images', async () => {
  const directory = createTempDir()
  const path = join(directory, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.equal(await extractFileText(path), undefined)
  rmSync(directory, { recursive: true, force: true })
})

test('extractFileText returns plain text content', async () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'notes.txt', 'plain content')
  assert.equal(await extractFileText(path), 'plain content')
  rmSync(directory, { recursive: true, force: true })
})

test('extractFileText extracts docx content', async () => {
  const directory = createTempDir()
  const path = join(directory, 'doc.docx')
  writeFileSync(path, await buildDocx('extracted text'))
  assert.equal(await extractFileText(path), 'extracted text')
  rmSync(directory, { recursive: true, force: true })
})

test('truncateView caps output length', () => {
  const long = 'x'.repeat(MAX_VIEW_OUTPUT_CHARACTERS + 100)
  const output = truncateView(long)
  assert.ok(output.endsWith('... output truncated (48100 characters total)'))
  assert.ok(output.length < long.length)
  assert.equal(truncateView('short'), 'short')
})

test('viewTextFile throws on invalid options', () => {
  const directory = createTempDir()
  const path = createTextFixture(directory, 'notes.txt', 'x\n')
  assert.throws(() => viewTextFile(path, { offset: 0 }), /positive/)
  rmSync(directory, { recursive: true, force: true })
})

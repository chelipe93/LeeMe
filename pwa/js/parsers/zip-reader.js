/**
 * Lector ZIP minimalista en Vanilla JS usando DecompressionStream('deflate-raw') nativo.
 * Permite leer archivos EPUB 100% offline en el navegador sin dependencias externas.
 */
class ZipReader {
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;
    this.bytes = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
    this.entries = new Map();
    this._parseCentralDirectory();
  }

  static async fromBuffer(arrayBuffer) {
    return new ZipReader(arrayBuffer);
  }

  _parseCentralDirectory() {
    const len = this.bytes.length;
    const minOff = Math.max(0, len - 65557);
    let eocdOffset = -1;

    // Buscar firma EOCD 0x06054b50 desde el final
    for (let i = len - 22; i >= minOff; i--) {
      if (
        this.bytes[i] === 0x50 &&
        this.bytes[i + 1] === 0x4b &&
        this.bytes[i + 2] === 0x05 &&
        this.bytes[i + 3] === 0x06
      ) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error('Archivo EPUB inválido: no se encontró el directorio ZIP (EOCD).');
    }

    const totalEntries = this.view.getUint16(eocdOffset + 10, true);
    const cdOffset = this.view.getUint32(eocdOffset + 16, true);
    const utf8Decoder = new TextDecoder('utf-8');
    const latinDecoder = new TextDecoder('iso-8859-1');

    let ptr = cdOffset;
    for (let i = 0; i < totalEntries && ptr + 46 <= len; i++) {
      const sig = this.view.getUint32(ptr, true);
      if (sig !== 0x02014b50) break;

      const flags = this.view.getUint16(ptr + 8, true);
      const method = this.view.getUint16(ptr + 10, true);
      const compSize = this.view.getUint32(ptr + 20, true);
      const uncompSize = this.view.getUint32(ptr + 24, true);
      const nameLen = this.view.getUint16(ptr + 28, true);
      const extraLen = this.view.getUint16(ptr + 30, true);
      const commentLen = this.view.getUint16(ptr + 32, true);
      const localHeaderOffset = this.view.getUint32(ptr + 42, true);

      const nameBytes = this.bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const isUtf8 = (flags & 0x0800) !== 0;
      const name = (isUtf8 ? utf8Decoder : latinDecoder).decode(nameBytes);

      this.entries.set(name, {
        name,
        method,
        compSize,
        uncompSize,
        localHeaderOffset
      });

      ptr += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) {
    return this.entries.has(name);
  }

  listEntries() {
    return Array.from(this.entries.keys());
  }

  async getBytes(entryName) {
    const entry = this.entries.get(entryName);
    if (!entry) return null;

    const lho = entry.localHeaderOffset;
    if (lho + 30 > this.bytes.length || this.view.getUint32(lho, true) !== 0x04034b50) {
      throw new Error(`Entrada ZIP corrupta: ${entryName}`);
    }

    const nameLen = this.view.getUint16(lho + 26, true);
    const extraLen = this.view.getUint16(lho + 28, true);
    const dataStart = lho + 30 + nameLen + extraLen;
    const compData = this.bytes.subarray(dataStart, dataStart + entry.compSize);

    if (entry.method === 0) {
      return new Uint8Array(compData);
    }
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('Este navegador no soporta DecompressionStream.');
      }
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compData);
      writer.close();
      const outBuf = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(outBuf);
    }
    throw new Error(`Método de compresión ZIP no soportado (${entry.method}) en ${entryName}`);
  }

  async getText(entryName) {
    const bytes = await this.getBytes(entryName);
    if (!bytes) return null;
    return new TextDecoder('utf-8').decode(bytes);
  }
}

window.ZipReader = ZipReader;

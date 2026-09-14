/** Incremental newline framing shared by subprocess and socket adapters. */

export interface LineReader {
  /** Decoded text in whatever pieces the transport delivered. */
  text(chunk: string): void;
  /** Flush the final unterminated line. */
  end(): void;
}

export interface LineReaderOptions {
  /** Refuse a line that can grow without bound. Defaults to one MiB. */
  maxBufferedChars?: number;
  onOverflow?: (bufferedChars: number) => void;
}

export function createLineReader(
  onLine: (line: string) => void,
  options: LineReaderOptions = {},
): LineReader {
  const maximum = options.maxBufferedChars ?? 1_048_576;
  let buffer = "";
  let ended = false;

  const deliver = (line: string): void => {
    if (line.length > maximum) {
      options.onOverflow?.(line.length);
      return;
    }
    const normalized = line.trim();
    if (normalized !== "") onLine(normalized);
  };

  return {
    text(chunk) {
      if (ended || chunk === "") return;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        deliver(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length <= maximum) return;
      const size = buffer.length;
      buffer = "";
      options.onOverflow?.(size);
    },
    end() {
      if (ended) return;
      ended = true;
      deliver(buffer);
      buffer = "";
    },
  };
}

/** Parse one JSON line only when its top-level value is an object. */
export function parseJsonRecord(line: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface NdjsonReader extends LineReader {
  /** Feed one already-framed line, useful for replay fixtures. */
  line(line: string): void;
}

export function createNdjsonReader(
  onRecord: (record: Record<string, unknown>) => void,
  options: LineReaderOptions & { onMalformed?: (line: string) => void } = {},
): NdjsonReader {
  const line = (value: string): void => {
    const record = parseJsonRecord(value);
    if (record) onRecord(record);
    else options.onMalformed?.(value);
  };
  const reader = createLineReader(line, options);
  return { ...reader, line };
}

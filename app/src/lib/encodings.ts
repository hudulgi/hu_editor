import type { Encoding } from "./api";
import type { MessageKey } from "./i18n";

export const ENCODING_LABEL: Record<Encoding, string> = {
  utf8: "UTF-8",
  cp949: "CP949",
  shiftJis: "Shift-JIS",
  gbk: "GBK",
  big5: "Big5",
  windows1252: "Windows-1252",
};

/** Every encoding, with the message key of what it is for. */
export const ENCODINGS: [Encoding, MessageKey][] = [
  ["utf8", "encoding.unicode"],
  ["cp949", "encoding.korean"],
  ["shiftJis", "encoding.japanese"],
  ["gbk", "encoding.simplifiedChinese"],
  ["big5", "encoding.traditionalChinese"],
  ["windows1252", "encoding.western"],
];

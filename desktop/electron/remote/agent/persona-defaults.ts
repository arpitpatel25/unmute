/**
 * Fingerprints of every built-in rulebook Unmute has ever shipped.
 *
 * WHY THIS EXISTS. The persona file is seeded once from the built-in rules and
 * then read verbatim, so an untouched copy froze whatever rules shipped on the
 * day it was written. One machine ran 8 September's rules eight days later,
 * through every change made since — including a whole new tool whose rules
 * never arrived (2026-09-16).
 *
 * A copy whose body matches one of these was never edited by a person, so it
 * is safe to replace with today's rules. Anything else is theirs and is left
 * alone. New seeds carry their own fingerprint in the file header, so this list
 * only has to cover files written before that existed; it never needs updating.
 *
 * sha256 of AGENT_PRINCIPLES.trim(), first 16 hex characters, generated from
 * the git history of agent/constitution.ts.
 */
export const LEGACY_DEFAULT_FINGERPRINTS: ReadonlySet<string> = new Set([
  '1a2bc79dd6ea1468', // 037caffa,
  '429ceb0c2832dfe0', // 0d2cd734,
  '7a01f1e62f50a347', // 0e6258d2,
  'bf06b6fc0fec77e2', // 15998dcb,
  '738ce55d4792272c', // 17a96dd9,
  '0332b6261d231581', // 17abc341,
  'b3fa28eb91d054c0', // 1ca886f4,
  '33d90de1f44d262e', // 23eed84d,
  '575bd287b568f17f', // 25fc2aad,
  'd7e955ea6f3e2ce1', // 31bf4eba,
  '395ded9c4d83005b', // 3f313e1c,
  'dfb4cdd9c65ce73a', // 442d03c6,
  'd4bb2de75ae22725', // 44b77643,
  'a962fd9b5037a541', // 48d593d5,
  '70842d31e819d05e', // 49f3e80e,
  'dff692c0b0277f5a', // 49f4f8f9,
  '82975681c8baeeef', // 64be28d2,
  '2d632ee64a30d615', // 667e2159,
  '361caaffc8045926', // 6eb00047,
  'f506d120a183b5da', // 6f576460,
  '1af1246bd109e43c', // 721df2ef,
  '9a3e9305b795b655', // 72e9dae4,
  'b56502fbd8207400', // 74c21107,
  'c2767cace49293c9', // 75014adb,
  'b3d967624a3ee287', // 755e3787,
  'a10ac7b6d6af685f', // 79e9a443,
  '31e7d38592877d42', // 8400e80a,
  'f73e810fb26d32e4', // 999fdbe5,
  '987ab8fcb65ecde6', // 9cf6ac1e,
  'ffee21addd34f36f', // 9d3c254e,
  '1a79efc8edf2b4b6', // a64ab193,
  'c735d109c6cd65fb', // a658967f,
  'd5aa49618e6030c3', // a7197dd9,
  'f85a8d5a116464ca', // bb5c83b1,
  'bf372f1ce3ca444e', // c47a1410,
  'b3f72105ccd096c4', // c5211671,
  '15209eec1b667769', // c9e24164,
  '64fd5bc85c36f1eb', // cc48bbf5,
  'fba4725f73b0e5fc', // cfc317c0,
  'be08cc7685950792', // d6c0fcc4,
  'a620898672e25547', // d8528a94,
  '6109a04408096a80', // e63665d9,
  'a2e01e15b401f723', // f4f36874,
  '946db8b01169cc08', // f8de03d1,
  'd38fcf6835cb8ddb', // fcaf9f6a,
  '007c4fd199e7f539', // fd7eb628,
])

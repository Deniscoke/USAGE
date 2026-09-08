/**
 * The miner build this server currently offers.
 *
 * Kept beside the server so the download page, the config endpoint and the
 * device list cannot disagree about which version is current.
 */
export const MINER_VERSION = "0.1.0";
export const MINER_PROTOCOL_VERSION = "miner-protocol-v1";
/** Older builds still work; below this the server may refuse in future. */
export const MINIMUM_MINER_VERSION = "0.1.0";

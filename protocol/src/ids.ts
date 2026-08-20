import { randomInt, randomUUID } from "node:crypto";

export const newTaskId = (): string => `task-${randomUUID()}`;
export const newContextId = (): string => `ctx-${randomUUID()}`;
export const newCorrelationId = (): string => `corr-${randomUUID()}`;

/**
 * Session names are single short animal words: they get typed into chat ("what
 * is otter doing?"), read aloud during the demo, and embedded in pod names, so
 * every entry is 3-6 lowercase letters. Callers must treat them as opaque.
 *
 * 48 entries is a small space on purpose — it keeps names memorable, and
 * ChatOps rejects collisions against live pods when minting (see chatops.ts).
 */
export const SESSION_NAME_WORDS = [
  "otter", "lynx", "wren", "tapir", "newt", "ibis", "mole", "crab",
  "heron", "stoat", "puffin", "marmot", "gecko", "koala", "bison", "raven",
  "finch", "egret", "gull", "tern", "lark", "swan", "hare", "vole",
  "shrew", "badger", "beaver", "weasel", "ferret", "martin", "osprey", "falcon",
  "magpie", "toucan", "iguana", "turtle", "salmon", "cicada", "beetle", "moth",
  "wasp", "mantis", "urchin", "limpet", "squid", "skink", "viper", "adder",
];

export const newSessionName = (): string =>
  SESSION_NAME_WORDS[randomInt(SESSION_NAME_WORDS.length)];

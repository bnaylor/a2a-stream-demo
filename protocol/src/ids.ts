import { randomInt, randomUUID } from "node:crypto";

export const newTaskId = (): string => `task-${randomUUID()}`;
export const newContextId = (): string => `ctx-${randomUUID()}`;
export const newCorrelationId = (): string => `corr-${randomUUID()}`;

const ADJECTIVES = ["brisk", "calm", "deft", "eager", "fuzzy", "keen", "merry", "nimble"];
const ANIMALS = ["otter", "heron", "lynx", "marmot", "puffin", "stoat", "tapir", "wren"];

export const newSessionName = (): string =>
  `worker-${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${ANIMALS[randomInt(ANIMALS.length)]}`;

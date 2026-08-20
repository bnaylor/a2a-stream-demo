function assertToken(token: string): string {
  if (token === "" || /[.\s*>]/.test(token)) {
    throw new Error(`invalid subject token: ${JSON.stringify(token)}`);
  }
  return token;
}

export const taskRequestSubject = (taskId: string): string =>
  `a2a.tasks.${assertToken(taskId)}.request`;
export const taskEventsSubject = (taskId: string): string =>
  `a2a.tasks.${assertToken(taskId)}.events`;
export const agentCardSubject = (session: string): string =>
  `a2a.agents.${assertToken(session)}`;
export const heartbeatSubject = (agentType: string, owner: string, session: string): string =>
  `agents.hb.${assertToken(agentType)}.${assertToken(owner)}.${assertToken(session)}`;

export function taskIdFromSubject(subject: string): string | null {
  const m = /^a2a\.tasks\.([^.]+)\.(request|events)$/.exec(subject);
  return m ? m[1] : null;
}

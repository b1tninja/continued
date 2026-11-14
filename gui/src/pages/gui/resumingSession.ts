import { BaseSessionMetadata } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { parseDate } from "../../components/History/util";

export const RECENT_SESSIONS_LIMIT = 5;

/**
 * Whether the session restored from the last run is worth showing a loading
 * view for. A session keeps the placeholder title until it is first saved, so
 * a persisted placeholder means the chat was empty and there is nothing to
 * wait for.
 */
export function expectsSessionToResume(
  persistedTitle: string | undefined,
): boolean {
  const title = persistedTitle?.trim();
  return !!title && title !== NEW_SESSION_TITLE;
}

/**
 * The title to show while `loadingSessionId` is loading: its saved metadata if
 * the list has arrived, otherwise the persisted title of the current session.
 */
export function getResumingTitle(
  loadingSessionId: string,
  currentSessionId: string,
  currentTitle: string,
  allSessionMetadata: BaseSessionMetadata[],
): string | undefined {
  const fromMetadata = allSessionMetadata.find(
    (m) => m.sessionId === loadingSessionId,
  )?.title;
  if (fromMetadata?.trim()) {
    return fromMetadata;
  }
  if (
    loadingSessionId === currentSessionId &&
    expectsSessionToResume(currentTitle)
  ) {
    return currentTitle;
  }
  return undefined;
}

/**
 * The most recent sessions, newest first, leaving out the one being loaded.
 * Sessions with an unreadable date sort last.
 */
export function selectRecentSessions(
  allSessionMetadata: BaseSessionMetadata[],
  excludeSessionId: string | undefined,
  limit: number = RECENT_SESSIONS_LIMIT,
): BaseSessionMetadata[] {
  if (limit <= 0) {
    return [];
  }
  const time = (m: BaseSessionMetadata) => {
    const t = parseDate(m.dateCreated).getTime();
    return isNaN(t) ? -Infinity : t;
  };
  return allSessionMetadata
    .filter((m) => m.sessionId !== excludeSessionId)
    .map((m) => ({ m, t: time(m) }))
    .sort((a, b) => (a.t === b.t ? 0 : b.t > a.t ? 1 : -1))
    .slice(0, limit)
    .map(({ m }) => m);
}

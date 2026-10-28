export type OperatorMode = "present" | "away";
/** What conversations' processes read: whether the user is at Desk (host presence.ts). */
export interface OperatorAvailability { mode: OperatorMode }
/** The user's presence as browsers see it: `device` and `used` describe the window used last, if one has reported. */
export interface OperatorPresence { present: boolean; device?: string; used?: number }

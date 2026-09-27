export interface ReadingPosition {
	from?: string; anchor?: string; offset: number; follow: boolean; sizes?: Record<string, number>;
}
const key = "pi-desk:reading";
export function readPosition(id: string): ReadingPosition | undefined {
	try { return (JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, ReadingPosition>)[id]; }
	catch { return; }
}
export function savePosition(id: string, position: ReadingPosition): void {
	try {
		const positions = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, ReadingPosition>;
		delete positions[id]; positions[id] = position;
		for (const old of Object.keys(positions).slice(0, -64)) delete positions[old];
		localStorage.setItem(key, JSON.stringify(positions));
	} catch { /* Reading remains usable when device storage is full or disabled. */ }
}

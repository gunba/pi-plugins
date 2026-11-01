/**
 * Every stored embedding of the current model, in memory, so that a semantic search scores them all without reading
 * the database. Each vector is kept at 8 bits per dimension with its own scale: a quarter of the memory of the
 * float vectors, and close enough for ranking, since only the order of the best matches is used.
 *
 * Reading each vector from SQLite on every search took about 10 s for 217,000 vectors on the workspace server, and grew
 * with the history until searches exceeded their 30 s limit.
 */
export class VectorIndex {
	private readonly dimensions: number;
	private ids = new Float64Array(0);
	private scales = new Float32Array(0);
	private data = new Int8Array(0);
	private readonly rows = new Map<number, number>();
	private count = 0;

	constructor(dimensions: number) { this.dimensions = dimensions; }

	get size(): number { return this.rows.size; }

	set(id: number, vector: Float32Array): void {
		let row = this.rows.get(id);
		if (row === undefined) {
			if (this.count === this.ids.length) this.grow();
			row = this.count++; this.rows.set(id, row);
		}
		let maximum = 0;
		for (let d = 0; d < this.dimensions; d++) maximum = Math.max(maximum, Math.abs(vector[d]!));
		const scale = maximum / 127, offset = row * this.dimensions;
		this.ids[row] = id; this.scales[row] = scale;
		for (let d = 0; d < this.dimensions; d++) this.data[offset + d] = scale ? Math.round(vector[d]! / scale) : 0;
	}

	/** A deleted row is left empty; its space is reused only by a rebuild. */
	delete(id: number): void {
		const row = this.rows.get(id);
		if (row === undefined) return;
		this.rows.delete(id); this.ids[row] = -1; this.scales[row] = 0;
	}

	/** The `limit` best matches by dot product above `minimum`, best first; `only` restricts them to those chunk IDs. */
	top(query: Float32Array, limit: number, minimum: number, only?: ReadonlySet<number>): { id: number; score: number }[] {
		const best: { id: number; score: number }[] = [];
		const { dimensions, data, ids, scales } = this;
		for (let row = 0; row < this.count; row++) {
			const id = ids[row]!;
			if (id < 0 || only && !only.has(id)) continue;
			const offset = row * dimensions;
			let sum = 0;
			for (let d = 0; d < dimensions; d++) sum += query[d]! * data[offset + d]!;
			const score = sum * scales[row]!;
			if (!(score >= minimum) || best.length === limit && score <= best[limit - 1]!.score) continue;
			let at = best.length;
			while (at > 0 && best[at - 1]!.score < score) at--;
			best.splice(at, 0, { id, score });
			if (best.length > limit) best.pop();
		}
		return best;
	}

	private grow(): void {
		const capacity = Math.max(1024, Math.ceil(this.ids.length * 1.5));
		const ids = new Float64Array(capacity), scales = new Float32Array(capacity), data = new Int8Array(capacity * this.dimensions);
		ids.set(this.ids); scales.set(this.scales); data.set(this.data);
		this.ids = ids; this.scales = scales; this.data = data;
	}
}

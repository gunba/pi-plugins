import assert from "node:assert/strict";
import test from "node:test";
import { VectorIndex } from "../src/host/search-vectors.ts";

// A fixed generator, so a failure reproduces.
function vectors(count, dimensions, seed = 1) {
	let state = seed;
	const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5;
	return Array.from({ length: count }, () => {
		const vector = Float32Array.from({ length: dimensions }, random), norm = Math.hypot(...vector);
		return vector.map(value => value / norm);
	});
}
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

test("the 8-bit index ranks like exact dot products and keeps up with changes", () => {
	const dimensions = 64, stored = vectors(2_000, dimensions), index = new VectorIndex(dimensions);
	stored.forEach((vector, id) => index.set(id, vector));
	const query = stored[7];
	const exact = stored.map((vector, id) => ({ id, score: dot(query, vector) })).sort((a, b) => b.score - a.score).slice(0, 20);
	const top = index.top(query, 20, -1);
	assert.equal(top[0].id, 7);
	assert.ok(Math.abs(top[0].score - 1) < 0.02, `self-match score ${top[0].score}`);
	const overlap = top.filter(item => exact.some(other => other.id === item.id)).length;
	assert.ok(overlap >= 18, `top-20 overlap ${overlap}`);

	index.delete(7);
	assert.notEqual(index.top(query, 1, -1)[0].id, 7, "a deleted vector is not returned");
	index.set(3, query);
	assert.equal(index.top(query, 1, -1)[0].id, 3, "setting an existing ID replaces its vector");
	assert.deepEqual(index.top(query, 5, -1, new Set([11, 12])).map(item => item.id).sort(), [11, 12], "`only` restricts the IDs");
	assert.equal(index.size, 1_999);
});

let database: Promise<IDBDatabase> | undefined;
let current: IDBDatabase | undefined;
function invalidate(connection: IDBDatabase): void {
	if (current === connection) { database = undefined; current = undefined; }
}
function open(): Promise<IDBDatabase> {
	if (database) return database;
	const pending = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("pi-desk-drafts", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("attachments");
		request.onsuccess = () => {
			const connection = request.result;
			current = connection;
			connection.onclose = () => invalidate(connection);
			connection.onversionchange = () => { invalidate(connection); connection.close(); };
			resolve(connection);
		};
		request.onerror = () => reject(request.error);
	});
	database = pending;
	void pending.catch(() => { if (database === pending) database = undefined; });
	return pending;
}
export async function draftTransaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
	const connection = await open();
	try { return connection.transaction("attachments", mode); }
	catch (error) {
		if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
		invalidate(connection); connection.close();
		// A synchronous start failure admitted no reads or writes; never replay an aborted transaction.
		return (await open()).transaction("attachments", mode);
	}
}

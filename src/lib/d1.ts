/** D1 batches are atomic per call; chunk to stay under request limits. Order is preserved. */
export async function runBatch(db: D1Database, statements: D1PreparedStatement[], chunkSize = 50): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) await db.batch(statements.slice(i, i + chunkSize));
}

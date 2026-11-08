import type { Pool } from 'pg';

export function artifactQueries(pool: Pool) {
  return {
    async createArtifact(artifact: { id: string; sessionId: string; kind: string; title: string; objectKey: string; bytes: number; sources: unknown }, ttlDays: number) {
      await pool.query(
        `INSERT INTO artifacts (id, session_id, kind, title, object_key, bytes, sources, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() + make_interval(days => $8))`,
        [artifact.id, artifact.sessionId, artifact.kind, artifact.title, artifact.objectKey, artifact.bytes, JSON.stringify(artifact.sources), ttlDays]);
    },
    // The row is the permission check: no row for this session means no signed URL.
    async findArtifact(id: string, sessionId: string) {
      const { rows } = await pool.query<{ object_key: string; title: string; kind: string; expires_at: Date }>(
        'SELECT object_key, title, kind, expires_at FROM artifacts WHERE id = $1 AND session_id = $2 AND expires_at > now()', [id, sessionId]);
      return rows[0];
    },
    async expiredArtifacts(limit = 200) {
      const { rows } = await pool.query<{ id: string; object_key: string }>(
        `SELECT a.id, a.object_key FROM artifacts a JOIN sessions s ON s.id = a.session_id
         WHERE a.expires_at <= now() OR s.expires_at <= now() LIMIT $1`, [limit]);
      return rows.map(row => ({ id: row.id, objectKey: row.object_key }));
    },
    async deleteArtifacts(ids: string[]) {
      if (ids.length) await pool.query('DELETE FROM artifacts WHERE id = ANY($1::uuid[])', [ids]);
    },
  };
}

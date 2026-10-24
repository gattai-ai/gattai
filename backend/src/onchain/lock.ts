import { pool } from "../db";

/**
 * Ambil PostgreSQL advisory lock pada satu koneksi khusus yang ditahan selama
 * proses hidup. Dipakai agar hanya satu replika yang menjalankan indexer.
 *
 * `pg_try_advisory_lock` tidak memblokir: bila instance lain sudah memegang
 * kunci, fungsi ini mengembalikan `null` dan pemanggil melewati indexer.
 */
export async function acquireLeaderLock(
  key: number,
): Promise<{ release: () => Promise<void> } | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [key],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }

  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [key]);
      } finally {
        client.release();
      }
    },
  };
}

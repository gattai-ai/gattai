import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Pool koneksi Postgres + instance Drizzle dengan schema lengkap.
 * Pool bersifat lazy: tidak ada koneksi sampai kueri pertama dijalankan,
 * sehingga server tetap bisa start tanpa DATABASE_URL (mis. untuk /health).
 *
 * `allowExitOnIdle` membuat proses (mis. skrip satu-kali dan `bun test`) bisa
 * keluar dengan sendirinya saat pool menganggur, tanpa menggantung.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle: true,
});

export const db = drizzle(pool, { schema });
export { pool };
export default db;

// Single Postgres connection (Supabase "Transaction pooler" URL in DATABASE_URL).
import postgres from "postgres";

let _sql = null;
export function db() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (Netlify → Site configuration → Environment variables)");
  const local = /localhost|127\.0\.0\.1|host=\/tmp/.test(url);
  _sql = postgres(url, {
    prepare: false,          // required by Supabase's transaction pooler
    max: 1,                  // one connection per function instance
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: local ? false : "require",
    onnotice: () => {},
  });
  return _sql;
}

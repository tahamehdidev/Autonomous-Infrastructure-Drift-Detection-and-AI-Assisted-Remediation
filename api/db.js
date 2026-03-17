const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drift_events (
      id              SERIAL PRIMARY KEY,
      environment     VARCHAR(50)   NOT NULL,
      resource_type   VARCHAR(255),
      risk_level      VARCHAR(10)   NOT NULL,
      explanation     TEXT,
      status          VARCHAR(50)   NOT NULL DEFAULT 'detected',
      detected_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      remediated_at   TIMESTAMPTZ,
      github_run_id   VARCHAR(50)
    );
  `);
  console.log("Database initialized");
}

module.exports = { pool, initDB };

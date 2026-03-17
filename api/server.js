const express = require("express");
const { pool, initDB } = require("./db");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── HEALTH CHECK ──────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── POST /webhook/drift — record a new drift event ────────────────────
app.post("/webhook/drift", async (req, res) => {
  const {
    environment,
    resource_type,
    risk_level,
    explanation,
    status,
    github_run_id,
  } = req.body;

  if (!environment || !risk_level) {
    return res.status(400).json({
      error: "environment and risk_level are required fields",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO drift_events
        (environment, resource_type, risk_level, explanation, status, github_run_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        environment,
        resource_type || null,
        risk_level,
        explanation || null,
        status || "detected",
        github_run_id || null,
      ]
    );

    const event = result.rows[0];

    // If status is remediated, stamp the remediated_at time
    if (status === "auto_remediated" || status === "manually_remediated") {
      await pool.query(
        `UPDATE drift_events SET remediated_at = NOW() WHERE id = $1`,
        [event.id]
      );
      event.remediated_at = new Date().toISOString();
    }

    res.status(201).json({ id: event.id, event });
  } catch (err) {
    console.error("Error recording drift event:", err.message);
    res.status(500).json({ error: "Failed to record drift event" });
  }
});

// ── GET /drift/history — all drift events ─────────────────────────────
app.get("/drift/history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM drift_events ORDER BY detected_at DESC LIMIT 100`
    );
    res.json({ events: result.rows, count: result.rows.length });
  } catch (err) {
    console.error("Error fetching drift history:", err.message);
    res.status(500).json({ error: "Failed to fetch drift history" });
  }
});

// ── GET /drift/stats — aggregate statistics ───────────────────────────
app.get("/drift/stats", async (req, res) => {
  try {
    const total = await pool.query(`SELECT COUNT(*) FROM drift_events`);

    const byRisk = await pool.query(
      `SELECT risk_level, COUNT(*) as count
       FROM drift_events
       GROUP BY risk_level`
    );

    const byStatus = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM drift_events
       GROUP BY status`
    );

    const byEnvironment = await pool.query(
      `SELECT environment, COUNT(*) as count
       FROM drift_events
       GROUP BY environment`
    );

    res.json({
      total: parseInt(total.rows[0].count),
      by_risk_level: byRisk.rows,
      by_status: byStatus.rows,
      by_environment: byEnvironment.rows,
    });
  } catch (err) {
    console.error("Error fetching drift stats:", err.message);
    res.status(500).json({ error: "Failed to fetch drift stats" });
  }
});

// ── START SERVER ──────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`TerraWatch Drift API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err.message);
    process.exit(1);
  });
